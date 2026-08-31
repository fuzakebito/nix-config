import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  patchPlan,
  parseWorkerOutput,
  readRuntime,
  renderPlanMarkdown,
  withWorkLock,
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
        outcome: "createPlan and writeRuntime persist one hash-bound canonical checkpoint that readRuntime restores after a session restart",
        satisfies: ["R1"],
        decisions: ["D1"],
        references: ["home/pi/files/plan-execute/core.ts#createPlan", "home/pi/files/plan-execute/core.ts#writeRuntime"],
        expectedPaths: ["home/pi/files/plan-execute"],
        acceptance: ["core-unit proves writeRuntime/readRuntime preserve the canonical plan and state across a disk round trip"],
        workerChecks: [{ id: "core-unit", program: "bun", args: ["test", "core.test.ts"], cwd: "home/pi/files/plan-execute", artifacts: ["home/pi/files/plan-execute/core.ts"] }],
        waveChecks: [{ id: "extension-load", program: "bun", args: ["test", "index.test.ts"], cwd: "home/pi/files/plan-execute" }],
      },
      {
        title: "Wire verification",
        outcome: "completeLease keeps dependent tasks locked until every worker and wave receipt succeeds",
        satisfies: ["R2"],
        references: ["home/pi/files/plan-execute/core.ts#completeLease", "home/pi/files/plan-execute/index.ts#runChecks"],
        dependsOn: ["T1"],
        expectedPaths: ["home/pi/files/plan-execute"],
        acceptance: ["verification-unit proves a failed or missing required receipt blocks completion and dependency unlock"],
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

  test("requires repository grounding and maps every approved decision to a task", () => {
    const brief = readyBrief();
    const ungrounded = planInput();
    ungrounded.tasks[0].references = [];
    expect(() => createPlan(ungrounded, brief)).toThrow("requires repository references");
    const uncoveredDecision = planInput();
    uncoveredDecision.tasks[0].decisions = [];
    expect(() => createPlan(uncoveredDecision, brief)).toThrow("decision D1 is not implemented");
  });

  test("renders the complete reviewed task and check context", () => {
    const markdown = renderPlanMarkdown(createPlan(planInput(), readyBrief()));
    expect(markdown).toContain("R1: Persist an approved plan");
    expect(markdown).toContain("D1: Use one writer per ready set — Avoid shared-worktree writer conflicts");
    expect(markdown).toContain("home/pi/files/plan-execute/core.ts#createPlan");
    expect(markdown).toContain("Depends on: T1");
    expect(markdown).toContain("worker:core-unit `bun test core.test.ts` (cwd: home/pi/files/plan-execute) (artifacts: home/pi/files/plan-execute/core.ts)");
    expect(markdown).toContain("final:flake-check `nix flake check --no-write-lock-file`");
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

  test("patches selected plan fields without resending the full plan", () => {
    const brief = readyBrief();
    const plan = createPlan(planInput(), brief);
    const patched = patchPlan(plan, brief, {
      expectedHash: plan.specHash,
      risks: ["Review long-running cancellation"],
      taskPatches: [{ id: "T2", acceptance: ["A failed command blocks completion and records evidence"] }],
    });
    expect(patched.revision).toBe(plan.revision + 1);
    expect(patched.specHash).not.toBe(plan.specHash);
    expect(patched.tasks[0].title).toBe(plan.tasks[0].title);
    expect(patched.tasks[1].acceptance).toEqual(["A failed command blocks completion and records evidence"]);
    expect(patched.momus.verdict).toBe("pending");
    expect(() => patchPlan(plan, brief, { expectedHash: "stale", goal: "changed" })).toThrow("expectedHash is stale");
    expect(() => patchPlan(plan, brief, { expectedHash: plan.specHash, taskPatches: [{ id: "T9", title: "unknown" }] })).toThrow("unknown task ID");
  });

  test("imports only the exact worker lease and enforces actual changed paths", () => {
    const plan = approvedPlan();
    const lease = createLease(plan, {});
    const output = parseWorkerOutput(JSON.stringify({
      leaseId: lease.id,
      attemptId: "A1",
      planHash: plan.specHash,
      taskIds: lease.taskIds,
      status: "implemented",
      summary: "Implemented state",
      changedPaths: ["ignored-self-report.ts"],
      semanticDelta: {
        accomplished: ["Canonical state is durable"], architectureChanges: [], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [],
      },
    }));
    expect(() => importWorkerOutput(plan, lease, "A1", output, ["outside.txt"])).toThrow("outside the lease");
    const imported = importWorkerOutput(plan, lease, "A1", output, ["home/pi/files/plan-execute/core.ts"]);
    expect(imported.tasks[0].status).toBe("implemented");
    expect(imported.semanticDeltas[0].accomplished).toEqual(["Canonical state is durable"]);
  });

  test("requires worker and wave receipts before unlocking dependencies", () => {
    let plan = approvedPlan();
    const lease = createLease(plan, {});
    plan = importWorkerOutput(plan, lease, "A1", {
      leaseId: lease.id,
      attemptId: "A1",
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
    const reservedPath = planInput();
    reservedPath.tasks[0].expectedPaths = [".pi//work/state.json"];
    expect(() => createPlan(reservedPath, brief)).toThrow("reserved path");
    const mutatingNix = planInput();
    mutatingNix.finalChecks = [{ id: "update", program: "nix", args: ["flake", "update"] }];
    expect(() => createPlan(mutatingNix, brief)).toThrow("mutating or unsupported");
    const outLink = planInput();
    outLink.finalChecks = [{ id: "out-link", program: "nix", args: ["build", "--no-link", "--out-link", "result"] }];
    expect(() => createPlan(outLink, brief)).toThrow("mutating Nix");
    const outsideArtifact = planInput();
    outsideArtifact.tasks[0].workerChecks[0].artifacts = ["outside.txt"];
    expect(() => createPlan(outsideArtifact, brief)).toThrow("outside expected paths");
  });

  test("rejects malformed nested worker semantic output", () => {
    expect(() => parseWorkerOutput(JSON.stringify({
      leaseId: "L1", attemptId: "A1", planHash: "hash", taskIds: ["T1"], status: "implemented", summary: "done", changedPaths: [],
      semanticDelta: { accomplished: [], architectureChanges: [{ fact: "missing rationale", references: [] }], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [] },
    }))).toThrow("invalid architecture");
  });

  test("rejects acceptance-wrapper and malformed recovery artifacts", () => {
    expect(() => parseWorkerOutput(JSON.stringify({
      leaseId: "L1", attemptId: "A1", planHash: "hash", taskIds: ["T1"], status: "implemented", summary: "done", changedPaths: [],
      acceptanceReport: { changedFiles: ["src/main.rs"] },
      semanticDelta: { accomplished: ["implemented"], architectureChanges: [], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [] },
    }))).toThrow("unsupported fields");
    expect(() => parseWorkerOutput(JSON.stringify({
      leaseId: "L1", attemptId: "A1", planHash: "hash", taskIds: ["T1"], status: "implemented", summary: "done", changedPaths: [],
      semanticDelta: { accomplished: [], architectureChanges: [{ fact: "change", rationale: "why", references: [1] }], decisions: [], invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [] },
    }))).toThrow("invalid architecture");
  });

  test("keeps the atomic runtime checkpoint authoritative over partial mirrors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan-runtime-"));
    try {
      const plan = approvedPlan();
      const lease = createLease(plan, {});
      const state = { version: 2 as const, generation: 0, planSlug: plan.slug, planHash: plan.specHash, status: "active" as const, stage: "dispatch" as const, lease, receipts: [], updatedAt: new Date().toISOString() };
      await writeRuntime(root, plan, state);
      await writeFile(workPaths(root).statePath, "{broken mirror");
      const checkpoint = await readRuntime(root);
      expect(checkpoint?.state.lease?.id).toBe(lease.id);
      expect(checkpoint?.plan.specHash).toBe(plan.specHash);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("reclaims a lock owned by a provably dead process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan-lock-"));
    try {
      const paths = workPaths(root);
      await mkdir(paths.workDir, { recursive: true });
      await writeFile(paths.lockPath, JSON.stringify({ pid: 2147483647, host: os.hostname(), processStartId: "dead", createdAt: new Date().toISOString() }));
      expect(await withWorkLock(root, async () => "acquired")).toBe("acquired");
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
