import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyMetisReview,
  applyMomusReview,
  completeLease,
  contentHash,
  createLease,
  createPlan,
  createPlanningBrief,
  getProgress,
  getReadyTasks,
  importWorkerOutput,
  parseMetisOutput,
  parseMomusOutput,
  parseWorkerOutput,
  readRuntime,
  renderPlanMarkdown,
  workPaths,
  writeRuntime,
  type CheckReceipt,
} from "./core.ts";

const managedDir = [".pi", "work"].join("/");

function readyBrief() {
  const brief = createPlanningBrief({
    request: "Rewrite Plan Execute",
    requirements: ["Persist an approved plan", "Verify every execution slice"],
    decisions: [{ text: "Use one writer per ready set", rationale: "Avoid shared-worktree writer conflicts" }],
    assumptions: ["The project is a Git worktree"],
    constraints: ["Keep operational noise out of the main context"],
    outOfScope: ["Team mode"],
    repositoryEvidence: [{ claim: "Pi already loads a local extension", references: ["home/pi/default.nix"] }],
    proposedApproach: "Use structured planning gates and deterministic execution receipts.",
  });
  return applyMetisReview(brief, {
    briefPath: `${managedDir}/briefs/${brief.slug}.json`,
    briefHash: brief.briefHash,
    readiness: "ready",
    blockingGaps: [],
    nonBlockingRisks: ["Subagent interruption depends on the provider"],
    directives: ["Keep the main context semantic"],
  });
}

function planInput() {
  return {
    title: "Plan Execute v2",
    goal: "Run reviewed plans with staged verification",
    architecture: [{ fact: "The extension owns workflow state", references: ["home/pi/files/plan-execute/core.ts"] }],
    tasks: [
      {
        title: "Implement state",
        outcome: "Canonical state is durable",
        satisfies: ["R1"],
        decisions: ["D1"],
        expectedPaths: ["home/pi/files/plan-execute"],
        acceptance: ["State survives a session restart"],
        workerChecks: [{ id: "core-unit", program: "bun", args: ["test", "core.test.ts"], cwd: "home/pi/files/plan-execute" }],
        waveChecks: [{ id: "extension-load", program: "bun", args: ["test", "index.test.ts"], cwd: "home/pi/files/plan-execute" }],
      },
      {
        title: "Wire verification",
        outcome: "Every slice has deterministic checks",
        satisfies: ["R2"],
        dependsOn: ["T1"],
        expectedPaths: ["home/pi/files/plan-execute"],
        acceptance: ["A failed command blocks completion"],
        workerChecks: [{ id: "verification-unit", program: "bun", args: ["test", "core.test.ts"], cwd: "home/pi/files/plan-execute" }],
      },
    ],
    finalChecks: [{ id: "flake-check", program: "nix", args: ["flake", "check"] }],
  };
}

function approvedPlan() {
  const plan = createPlan(planInput(), readyBrief());
  return applyMomusReview(plan, {
    planPath: `${managedDir}/plans/${plan.slug}.md`,
    planHash: plan.specHash,
    verdict: "approved",
    blockingFindings: [],
    nonBlockingNotes: [],
  });
}

describe("Plan Execute v2 core", () => {
  test("invalidates Metis when the Planning Brief changes", () => {
    const first = readyBrief();
    const second = createPlanningBrief({
      request: first.request,
      requirements: first.requirements.map((item) => item.text),
      decisions: first.decisions.map(({ text, rationale }) => ({ text, rationale })),
      constraints: first.constraints,
      proposedApproach: `${first.proposedApproach} Use receipts.`,
    }, first);
    expect(second.briefHash).not.toBe(first.briefHash);
    expect(second.metis.readiness).toBe("pending");
    expect(() => applyMetisReview(second, {
      briefPath: `${managedDir}/briefs/${second.slug}.json`,
      briefHash: first.briefHash,
      readiness: "ready",
      blockingGaps: [],
      nonBlockingRisks: [],
      directives: [],
    })).toThrow("stale");
  });

  test("blocks plan generation until Metis closes all gaps", () => {
    const pending = createPlanningBrief({ request: "Plan it", requirements: ["Work"], proposedApproach: "Inspect then implement" });
    expect(() => createPlan({ title: "Blocked", goal: "No premature plan", tasks: [], finalChecks: [] }, pending)).toThrow("Metis READY");
    expect(() => parseMetisOutput(JSON.stringify({
      briefPath: "brief.json", briefHash: pending.briefHash, readiness: "blocked", blockingGaps: [], nonBlockingRisks: [], directives: [],
    }))).toThrow("requires blocking gaps");
  });

  test("derives ready sets from dependencies instead of stored wave numbers", () => {
    const plan = approvedPlan();
    expect(getReadyTasks(plan).map((task) => task.id)).toEqual(["T1"]);
    expect(plan.tasks.every((task) => !("wave" in task))).toBe(true);
    expect(getProgress(plan)).toEqual({ completed: 0, total: 2, remaining: 2 });
  });

  test("binds Momus approval to the immutable plan spec hash", () => {
    const plan = createPlan(planInput(), readyBrief());
    expect(contentHash(plan.specHash)).toHaveLength(64);
    expect(() => applyMomusReview(plan, {
      planPath: `${managedDir}/plans/${plan.slug}.md`, planHash: "stale", verdict: "approved", blockingFindings: [], nonBlockingNotes: [],
    })).toThrow("stale");
    expect(parseMomusOutput(JSON.stringify({
      planPath: `${managedDir}/plans/${plan.slug}.md`, planHash: plan.specHash, verdict: "approved", blockingFindings: [], nonBlockingNotes: [],
    })).verdict).toBe("approved");
  });

  test("imports only the exact worker lease and enforces actual changed paths", () => {
    const plan = approvedPlan();
    const lease = createLease(plan, {});
    const output = parseWorkerOutput(JSON.stringify({
      leaseId: lease.id,
      planHash: plan.specHash,
      taskIds: lease.taskIds,
      status: "implemented",
      summary: "Implemented state",
      changedPaths: ["ignored-self-report.ts"],
      semanticDelta: {
        accomplished: ["Canonical state is durable"], architectureChanges: [], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [],
      },
    }));
    expect(() => importWorkerOutput(plan, lease, output, ["outside.txt"])).toThrow("outside the lease");
    const imported = importWorkerOutput(plan, lease, output, ["home/pi/files/plan-execute/core.ts"]);
    expect(imported.tasks[0].status).toBe("implemented");
    expect(imported.semanticDeltas[0].accomplished).toEqual(["Canonical state is durable"]);
  });

  test("requires worker and wave receipts before unlocking dependencies", () => {
    let plan = approvedPlan();
    const lease = createLease(plan, {});
    plan = importWorkerOutput(plan, lease, {
      leaseId: lease.id,
      planHash: plan.specHash,
      taskIds: lease.taskIds,
      status: "implemented",
      summary: "done",
      changedPaths: [],
      semanticDelta: {
        accomplished: ["T1 implemented"], architectureChanges: [], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [],
      },
    }, []);
    const workerReceipt: CheckReceipt = {
      id: "core-unit", scope: "worker", command: ["bun", "test"], exitCode: 0, durationMs: 1,
      stdoutPath: "out", stderrPath: "err", artifactHashes: {},
    };
    expect(() => completeLease(plan, lease, [workerReceipt])).toThrow("extension-load");
    plan = completeLease(plan, lease, [workerReceipt, { ...workerReceipt, id: "extension-load", scope: "wave" }]);
    expect(plan.tasks[0].status).toBe("completed");
    expect(getReadyTasks(plan).map((task) => task.id)).toEqual(["T2"]);
  });

  test("rejects traversal check IDs and shell-based check programs", () => {
    const brief = readyBrief();
    const unsafeId = planInput();
    unsafeId.tasks[0].workerChecks[0] = { ...unsafeId.tasks[0].workerChecks[0], id: "../../escape" };
    expect(() => createPlan(unsafeId, brief)).toThrow("safe id");
    const unsafeProgram = planInput();
    unsafeProgram.tasks[0].workerChecks[0] = { ...unsafeProgram.tasks[0].workerChecks[0], program: "sh", args: ["-c", "touch escaped"] };
    expect(() => createPlan(unsafeProgram, brief)).toThrow("forbidden program");
  });

  test("rejects malformed nested worker semantic output", () => {
    expect(() => parseWorkerOutput(JSON.stringify({
      leaseId: "L1", planHash: "hash", taskIds: ["T1"], status: "implemented", summary: "done", changedPaths: [],
      semanticDelta: { accomplished: [], architectureChanges: [{ fact: "missing rationale", references: [] }], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [] },
    }))).toThrow("invalid architecture");
  });

  test("keeps the atomic runtime checkpoint authoritative over partial mirrors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan-runtime-"));
    try {
      const plan = approvedPlan();
      const lease = createLease(plan, {});
      const state = { version: 2 as const, planSlug: plan.slug, planHash: plan.specHash, status: "active" as const, stage: "dispatch" as const, lease, receipts: [], updatedAt: new Date().toISOString() };
      await writeRuntime(root, plan, state);
      await writeFile(workPaths(root).statePath, "{broken mirror");
      const checkpoint = await readRuntime(root);
      expect(checkpoint?.state.lease?.id).toBe(lease.id);
      expect(checkpoint?.plan.specHash).toBe(plan.specHash);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("renders strategic context without operational receipts", () => {
    const markdown = renderPlanMarkdown(approvedPlan());
    expect(markdown).toContain("## Strategic Context");
    expect(markdown).toContain("Use one writer per ready set");
    expect(markdown).toContain("## Final Checks");
    expect(markdown).not.toContain("wave token");
  });
});
