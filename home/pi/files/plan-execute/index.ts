import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyMetisReview,
  applyMomusReview,
  completeLease,
  contentHash,
  createLease,
  createPlan,
  createPlanningBrief,
  getImplementedTasks,
  getProgress,
  getReadyTasks,
  importWorkerOutput,
  listPlans,
  parseMetisOutput,
  parseMomusOutput,
  parseWorkerOutput,
  patchPlan,
  readBrief,
  readPlan,
  readRuntime,
  readWorkState,
  recordExecutionDecision,
  recordSemanticDelta,
  renderSemanticDelta,
  renderStrategicContext,
  slugify,
  withWorkLock,
  workPaths,
  writeBrief,
  writePlan,
  writeRuntime,
  writeWorkState,
  type CheckReceipt,
  type CheckSpec,
  type MetisOutput,
  type MomusOutput,
  type PlanDocument,
  type WorkerOutput,
  type WorkState,
  type WorkerAttempt,
} from "./core.ts";

const MANAGED_DIR = [".pi", "work"].join("/");
const WORKFLOW_CUSTOM_TYPE = "plan-execute-v2-session";
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "lsp_fix", "bash", "ctx_execute", "ctx_batch_execute"]);

interface SessionState {
  mode: "idle" | "planning" | "executing";
  root?: string;
  briefSlug?: string;
  planSlug?: string;
  planningTools?: string[];
  executionTools?: string[];
  lastStrategicVersion?: string;
  lastDirective?: string;
  ownerId?: string;
}

interface ProviderReceipt<T> {
  version: 1;
  agent: "metis" | "momus" | "worker";
  identity: string;
  rootRunId: string;
  childRunId: string;
  recordedAt: string;
  value: T;
}

interface StructuredChildResult {
  agent?: string;
  index?: number;
  runId?: string;
  exitCode?: number;
  error?: string;
  detached?: boolean;
  structuredOutput?: unknown;
}

const StringList = Type.Array(Type.String());
const CheckInput = Type.Object({
  id: Type.String({ description: "Unique across every worker, wave, and final check in the plan; use a safe file-name token and cite this ID from the acceptance criterion it proves." }),
  program: Type.String({ description: "Executable name without a path or shell. Shells, mutating Git, unsafe Nix, and inline interpreter code are rejected." }),
  args: Type.Array(Type.String(), { description: "Direct argv entries for a behavior-relevant check; no shell expansion. nix build requires --no-link." }),
  cwd: Type.Optional(Type.String({ description: "Repository-relative working directory needed to run the check." })),
  artifacts: Type.Optional(Type.Array(Type.String({ description: "Repository-relative output whose content must exist and be hashed after the check." }))),
});
const BriefSaveParams = Type.Object({
  request: Type.String({ description: "The user's request, preserving intended behavior and scope." }),
  requirements: Type.Array(Type.String({ description: "Observable outcome or constraint the completed work must satisfy." }), { minItems: 1 }),
  decisions: Type.Optional(Type.Array(Type.Object({ text: Type.String(), rationale: Type.String() }))),
  assumptions: Type.Optional(StringList),
  constraints: Type.Optional(StringList),
  outOfScope: Type.Optional(StringList),
  repositoryEvidence: Type.Optional(Type.Array(Type.Object({
    claim: Type.String({ description: "Verified current-code fact that shapes the plan." }),
    references: Type.Array(Type.String({ description: "Repository-relative path#symbol or path:line anchor supporting the claim." }), { minItems: 1 }),
  }))),
  proposedApproach: Type.String({ description: "Trace the current entry point through relevant symbols and integration wiring to the resulting behavior; include applicable failure boundaries and validation strategy." }),
  openQuestions: Type.Optional(StringList),
});
const LoadParams = Type.Object({ slug: Type.Optional(Type.String()), full: Type.Optional(Type.Boolean()) });
const InspectParams = Type.Object({
  program: Type.Union([Type.Literal("git"), Type.Literal("rg"), Type.Literal("grep"), Type.Literal("find"), Type.Literal("ls"), Type.Literal("pwd"), Type.Literal("wc"), Type.Literal("head"), Type.Literal("tail"), Type.Literal("stat"), Type.Literal("file"), Type.Literal("jq"), Type.Literal("nix")], { description: "Read-only inspection executable; commands are executed directly without a shell." }),
  args: Type.Optional(Type.Array(Type.String(), { description: "Direct argv entries. Git is limited to read commands; Nix to eval/flake show/metadata." })),
  cwd: Type.Optional(Type.String({ description: "Existing repository-relative working directory." })),
});
const ImportParams = Type.Object({});
const DecisionParams = Type.Object({
  decisionId: Type.String({ description: "Pending decision ID returned by workflow_status or work_import." }),
  decision: Type.String(),
  rationale: Type.String(),
  references: Type.Optional(Type.Array(Type.String())),
});
const PlanTaskInput = Type.Object({
  title: Type.String({ description: "Imperative implementation slice, narrow enough for one worker lease." }),
  outcome: Type.String({ description: "Concrete post-change behavior, naming the affected symbols or integration points and how data/control flow changes." }),
  satisfies: Type.Array(Type.String({ description: "Planning Brief requirement ID such as R1." }), { minItems: 1 }),
  decisions: Type.Optional(Type.Array(Type.String({ description: "Planning Brief decision ID such as D1 implemented by this task." }))),
  references: Type.Array(Type.String({ description: "Existing repository path#symbol or path:line anchors a fresh worker should inspect; new files cite the caller, importer, registration point, or convention they join." }), { minItems: 1 }),
  dependsOn: Type.Optional(Type.Array(Type.String({ description: "Earlier task ID assigned by array order: T1, T2, and so on." }))),
  expectedPaths: Type.Array(Type.String({ description: "Narrowest justified repository-relative write set; prefer exact files and tests over broad directories." }), { minItems: 1 }),
  acceptance: Type.Array(Type.String({ description: "Observable trigger and result, including applicable failure or regression behavior and the check ID that proves it." }), { minItems: 1 }),
  workerChecks: Type.Array(CheckInput, { description: "Targeted checks proving this task's behavior.", minItems: 1 }),
  waveChecks: Type.Optional(Type.Array(CheckInput, { description: "Integration checks required after this task and its dependency slice are combined." })),
});
const PlanSaveParams = Type.Object({
  title: Type.String(),
  goal: Type.String({ description: "End-to-end observable result of the complete plan." }),
  architecture: Type.Optional(Type.Array(Type.Object({ fact: Type.String(), references: Type.Array(Type.String(), { minItems: 1 }) }))),
  risks: Type.Optional(StringList),
  tasks: Type.Array(PlanTaskInput, { minItems: 1 }),
  finalChecks: Type.Array(CheckInput, { description: "End-to-end and regression checks proving the complete goal.", minItems: 1 }),
});
const PlanPatchParams = Type.Object({
  expectedHash: Type.String({ description: "Required current plan hash from workflow_status; rejects concurrent stale revisions." }),
  title: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  architecture: Type.Optional(Type.Array(Type.Object({ fact: Type.String(), references: Type.Array(Type.String(), { minItems: 1 }) }))),
  risks: Type.Optional(StringList),
  taskPatches: Type.Optional(Type.Array(Type.Intersect([
    Type.Object({ id: Type.String({ description: "Existing task ID such as T2." }) }),
    Type.Partial(PlanTaskInput),
  ]), { minItems: 1 })),
  finalChecks: Type.Optional(Type.Array(CheckInput, { minItems: 1 })),
});

const METIS_SCHEMA = {
  type: "object", required: ["briefPath", "briefHash", "readiness", "blockingGaps", "nonBlockingRisks", "directives"], additionalProperties: false,
  properties: {
    briefPath: { type: "string" }, briefHash: { type: "string" }, readiness: { type: "string", enum: ["ready", "blocked"] },
    blockingGaps: { type: "array", items: { type: "object", required: ["type", "issue", "requiredAction", "reason"], additionalProperties: false, properties: { type: { type: "string", enum: ["user-decision", "missing-research", "unsupported-assumption", "scope-conflict", "missing-requirement", "untestable-outcome"] }, issue: { type: "string" }, requiredAction: { type: "string" }, reason: { type: "string" } } } },
    nonBlockingRisks: { type: "array", items: { type: "string" } }, directives: { type: "array", items: { type: "string" } },
  },
} as const;
const MOMUS_SCHEMA = {
  type: "object", required: ["planPath", "planHash", "verdict", "blockingFindings", "nonBlockingNotes"], additionalProperties: false,
  properties: {
    planPath: { type: "string" }, planHash: { type: "string" }, verdict: { type: "string", enum: ["approved", "rejected"] },
    blockingFindings: { type: "array", items: { type: "object", required: ["taskIds", "issue", "reason", "requiredCorrection"], additionalProperties: false, properties: { requirementId: { type: "string" }, taskIds: { type: "array", items: { type: "string" } }, issue: { type: "string" }, reason: { type: "string" }, requiredCorrection: { type: "string" } } } },
    nonBlockingNotes: { type: "array", items: { type: "string" } },
  },
} as const;
const WORKER_SCHEMA = {
  type: "object", required: ["leaseId", "attemptId", "planHash", "taskIds", "status", "summary", "changedPaths", "semanticDelta"], additionalProperties: false,
  properties: {
    leaseId: { type: "string" }, attemptId: { type: "string" }, planHash: { type: "string" }, taskIds: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["implemented", "blocked"] }, summary: { type: "string" }, changedPaths: { type: "array", items: { type: "string" } }, blocker: { type: "string" },
    semanticDelta: {
      type: "object", required: ["accomplished", "architectureChanges", "decisions", "invalidatedAssumptions", "planDeviations", "newRisks", "userDecisionNeeded"], additionalProperties: false,
      properties: {
        accomplished: { type: "array", items: { type: "string" } },
        architectureChanges: { type: "array", items: { type: "object", required: ["fact", "rationale", "references"], additionalProperties: false, properties: { fact: { type: "string" }, rationale: { type: "string" }, references: { type: "array", items: { type: "string" } } } } },
        decisions: { type: "array", items: { type: "object", required: ["text", "rationale", "references"], additionalProperties: false, properties: { text: { type: "string" }, rationale: { type: "string" }, references: { type: "array", items: { type: "string" } } } } },
        invalidatedAssumptions: { type: "array", items: { type: "string" } }, planDeviations: { type: "array", items: { type: "string" } }, newRisks: { type: "array", items: { type: "string" } }, userDecisionNeeded: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function providerReceiptPath(kind: "metis" | "momus" | "worker", identity: string): string {
  return path.join(MANAGED_DIR, "evidence", "provider", `${kind}-${identity}.json`).replaceAll("\\", "/");
}

async function writeProviderReceipt<T>(root: string, receipt: ProviderReceipt<T>): Promise<void> {
  const destination = path.resolve(root, providerReceiptPath(receipt.agent, receipt.identity));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.rename(temporary, destination);
}

async function readProviderReceipt<T>(root: string, agent: ProviderReceipt<T>["agent"], identity: string, parse: (output: string) => T): Promise<ProviderReceipt<T>> {
  const raw = JSON.parse(await fs.readFile(path.resolve(root, providerReceiptPath(agent, identity)), "utf8")) as ProviderReceipt<unknown>;
  const allowed = new Set(["version", "agent", "identity", "rootRunId", "childRunId", "recordedAt", "value"]);
  if (Object.keys(raw).some((key) => !allowed.has(key)) || raw.version !== 1 || raw.agent !== agent || raw.identity !== identity || !/^[a-zA-Z0-9-]+$/.test(raw.identity) || !raw.rootRunId || !raw.childRunId || Number.isNaN(Date.parse(raw.recordedAt))) throw new Error(`invalid ${agent} provider receipt`);
  return { ...raw, value: parse(JSON.stringify(raw.value)) } as ProviderReceipt<T>;
}

async function validWorkerReceipt(root: string, plan: PlanDocument | undefined, state: WorkState | undefined): Promise<boolean> {
  const attempt = state?.workerAttempt;
  if (!plan || !state?.lease || !attempt || attempt.consumed) return false;
  try {
    const receipt = await readProviderReceipt(root, "worker", attempt.id, parseWorkerOutput);
    return receipt.value.leaseId === state.lease.id && receipt.value.attemptId === attempt.id && receipt.value.planHash === plan.specHash && JSON.stringify(receipt.value.taskIds) === JSON.stringify(state.lease.taskIds);
  } catch { return false; }
}

function structuredResult(details: unknown, agent: string, isError: boolean): { rootRunId: string; childRunId: string; value: unknown } {
  const result = details as { runId?: string; results?: StructuredChildResult[] } | undefined;
  const child = result?.results?.find((item) => item.agent === agent);
  if (isError || !result?.runId || !child || !Number.isInteger(child.index) || child.detached || child.error || (child.exitCode !== undefined && child.exitCode !== 0) || child.structuredOutput === undefined) throw new Error(`${agent} did not return one successful validated structured result`);
  return { rootRunId: result.runId, childRunId: child.runId ?? `${result.runId}:index:${child.index}`, value: child.structuredOutput };
}

function metisAssessmentTask(briefSlug: string, briefHash: string): string {
  return `Assess ${MANAGED_DIR}/briefs/${briefSlug}.json at exact brief hash ${briefHash}. Verify repository evidence and whether the current entry points, boundary symbols, consumers, integration wiring, failure behavior, and validation strategy are known well enough to write worker-ready tasks. Return every blocking gap in the required structured output, and do not edit files.`;
}

function momusReviewTask(briefSlug: string, planSlug: string, planHash: string): string {
  return `Review authoritative ${MANAGED_DIR}/plans/${planSlug}.json and its companion ${MANAGED_DIR}/plans/${planSlug}.md against ${MANAGED_DIR}/briefs/${briefSlug}.json. Bind the semantic review to current plan hash ${planHash}; keep planPath identity as ${MANAGED_DIR}/plans/${planSlug}.md. Audit every requirement, approved decision, and task for exact code anchors, end-to-end flow, integration and failure behavior, and acceptance-to-check relevance. Report every blocking correction in the required structured output, and do not edit files.`;
}

function getTargetPath(input: Record<string, unknown>): string | undefined {
  const target = input.path ?? input.filePath ?? input.file_path;
  return typeof target === "string" ? target : undefined;
}

async function repositoryReservedRoots(root: string): Promise<string[]> {
  const roots = [path.resolve(root, MANAGED_DIR), path.resolve(root, ".git")];
  try {
    const dotGit = path.resolve(root, ".git");
    const stat = await fs.lstat(dotGit);
    if (stat.isSymbolicLink() || stat.isDirectory()) roots.push(await fs.realpath(dotGit));
    else if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, "utf8"));
      if (match) roots.push(path.resolve(root, match[1].trim()));
    }
  } catch { /* Git validation later reports missing metadata. */ }
  return [...new Set(roots)];
}

async function targetsReservedPath(root: string, target: string): Promise<boolean> {
  const absolute = path.resolve(root, target);
  const roots = await repositoryReservedRoots(root);
  if (roots.some((reserved) => absolute === reserved || absolute.startsWith(`${reserved}${path.sep}`))) return true;
  try {
    const real = await fs.realpath(absolute);
    return roots.some((reserved) => real === reserved || real.startsWith(`${reserved}${path.sep}`));
  } catch {
    try {
      const parent = await fs.realpath(path.dirname(absolute));
      const projected = path.join(parent, path.basename(absolute));
      return roots.some((reserved) => projected === reserved || projected.startsWith(`${reserved}${path.sep}`));
    } catch { return false; }
  }
}

function pathAllowed(filePath: string, allowed: string[]): boolean {
  const normalized = normalizePath(filePath);
  return allowed.some((candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`));
}

function concisePlan(plan: PlanDocument) {
  return {
    slug: plan.slug,
    title: plan.title,
    goal: plan.goal,
    specHash: plan.specHash,
    revision: plan.revision,
    momus: plan.momus.verdict,
    progress: getProgress(plan),
    ready: getReadyTasks(plan).map((task) => task.id),
    implemented: getImplementedTasks(plan).map((task) => task.id),
    latestSemanticDelta: plan.semanticDeltas.at(-1),
  };
}

function renderTasks(plan: PlanDocument, ids: string[]): string {
  const command = (check: CheckSpec) => `${check.program} ${check.args.join(" ")}${check.cwd ? ` (cwd: ${check.cwd})` : ""}${check.artifacts.length ? ` (artifacts: ${check.artifacts.join(", ")})` : ""}`;
  return plan.tasks.filter((task) => ids.includes(task.id)).map((task) => {
    const requirements = task.satisfies.map((id) => `${id}: ${plan.requirements.find((item) => item.id === id)?.text ?? "unknown"}`).join("; ");
    const decisions = task.decisions.map((id) => { const decision = plan.decisions.find((item) => item.id === id); return decision ? `${id}: ${decision.text} — ${decision.rationale}` : `${id}: unknown`; }).join("; ") || "none";
    const dependencies = task.dependsOn.map((id) => { const dependency = plan.tasks.find((item) => item.id === id); return dependency ? `${id} (${dependency.title}): ${dependency.outcome}` : `${id}: unknown`; }).join("; ") || "none";
    return `${task.id}. ${task.title}\nOutcome: ${task.outcome}\nRequirements: ${requirements}\nDecisions: ${decisions}\nDepends on: ${dependencies}\nReferences: ${task.references.join(", ") || "none"}\nExpected paths: ${task.expectedPaths.join(", ")}\nAcceptance: ${task.acceptance.join("; ")}\nWorker checks: ${task.workerChecks.map(command).join("; ")}\nWave checks: ${task.waveChecks.map(command).join("; ") || "none"}`;
  }).join("\n\n");
}

export default function planExecuteExtension(pi: ExtensionAPI): void {
  let session: SessionState = { mode: "idle" };
  let lastContext: ExtensionContext | undefined;

  function persistSession(): void {
    pi.appendEntry(WORKFLOW_CUSTOM_TYPE, session);
  }

  function restoreTools(): void {
    if (session.planningTools) pi.setActiveTools(session.planningTools);
    if (session.executionTools) pi.setActiveTools(session.executionTools);
    session.planningTools = undefined;
    session.executionTools = undefined;
  }

  function enterPlanning(): void {
    const tools = session.planningTools ?? pi.getActiveTools();
    session.planningTools = tools;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const active = new Set(tools.filter((tool) => !MUTATION_TOOLS.has(tool)));
    for (const tool of ["read", "grep", "find", "ls", "plan_inspect", "workflow_status"]) if (available.has(tool)) active.add(tool);
    pi.setActiveTools([...active]);
  }

  function enterExecution(): void {
    const tools = session.executionTools ?? pi.getActiveTools();
    session.executionTools = tools;
    const active = new Set(tools.filter((tool) => !MUTATION_TOOLS.has(tool)));
    if (pi.getAllTools().some((tool) => tool.name === "workflow_status")) active.add("workflow_status");
    pi.setActiveTools([...active]);
  }

  async function updateUI(ctx: ExtensionContext): Promise<void> {
    lastContext = ctx;
    if (ctx.mode !== "tui") return;
    const root = session.root ?? ctx.cwd;
    const state = await readWorkState(root).catch(() => undefined);
    const slug = session.planSlug ?? state?.planSlug;
    const plan = slug ? await readPlan(root, slug).catch(() => undefined) : undefined;
    if (!plan) {
      ctx.ui.setStatus("plan-execute", session.mode === "planning" ? ctx.ui.theme.fg("warning", "planning") : undefined);
      ctx.ui.setWidget("plan-execute", undefined);
      return;
    }
    const progress = getProgress(plan);
    const label = session.mode === "planning" ? "planning" : state?.status ?? "planned";
    ctx.ui.setStatus("plan-execute", ctx.ui.theme.fg(label === "completed" ? "success" : "accent", `${label} ${progress.completed}/${progress.total}`));
    const tasks = state?.lease?.taskIds ?? getReadyTasks(plan).map((task) => task.id);
    ctx.ui.setWidget("plan-execute", [`Plan: ${plan.title}`, tasks.length ? `${state?.stage ?? "ready"}: ${tasks.join(", ")}` : "Complete"]);
  }

  async function loadExecution(root: string): Promise<{ plan: PlanDocument; state: WorkState } | undefined> {
    const checkpoint = await readRuntime(root);
    if (checkpoint) return { plan: checkpoint.plan, state: checkpoint.state };
    const state = await readWorkState(root);
    if (!state) return undefined;
    return { plan: await readPlan(root, state.planSlug), state };
  }

  async function persistExecution(root: string, plan: PlanDocument, state: WorkState): Promise<WorkState> {
    return withWorkLock(root, async () => {
      const checkpoint = await readRuntime(root);
      const mirror = checkpoint ? undefined : await readWorkState(root);
      const currentGeneration = checkpoint?.state.generation ?? mirror?.generation ?? 0;
      if (state.generation !== currentGeneration) throw new Error(`stale workflow generation ${state.generation}; current generation is ${currentGeneration}`);
      if ((checkpoint?.state.planHash ?? mirror?.planHash) && (checkpoint?.state.planHash ?? mirror?.planHash) !== state.planHash) throw new Error("stale workflow plan identity");
      const next = { ...state, generation: currentGeneration + 1, updatedAt: new Date().toISOString() };
      await writeRuntime(root, plan, next);
      return next;
    });
  }

  function pendingDecisions(plan: PlanDocument) {
    const seen = new Set<string>();
    return plan.semanticDeltas.flatMap((delta) => delta.userDecisionNeeded).filter((question) => {
      if (seen.has(question)) return false;
      seen.add(question);
      return true;
    }).map((question) => ({
      id: `Q-${createHash("sha256").update(question).digest("hex").slice(0, 8)}`,
      question,
    }));
  }

  async function getWorkflowStatus(root: string) {
    const runtime = await loadExecution(root);
    const brief = session.briefSlug ? await readBrief(root, session.briefSlug).catch(() => undefined) : undefined;
    const plan = runtime?.plan ?? (session.planSlug ? await readPlan(root, session.planSlug).catch(() => undefined) : undefined);
    const state = runtime?.state;
    const decisions = plan ? pendingDecisions(plan) : [];
    const workerReceiptReady = await validWorkerReceipt(root, plan, state);
    let nextAction = "none";
    if (session.mode === "planning") {
      if (!brief) nextAction = "planning_brief_save";
      else if (brief.metis.readiness !== "ready") nextAction = "launch metis and wait; metis_import is recovery-only";
      else if (!plan || plan.briefHash !== brief.briefHash) nextAction = "plan_save";
      else if (plan.momus.verdict === "rejected") nextAction = "revise the rejected plan with plan_patch, or plan_save for structural task changes, before a fresh Momus review";
      else if (plan.momus.verdict !== "approved") nextAction = "call one Momus subagent and wait; review identity and import are automatic";
      else nextAction = `/start-work ${plan.slug}`;
    } else if (state?.status === "active" && state.stage === "dispatch") nextAction = workerReceiptReady ? "work_import" : state.workerAttempt ? "reconcile the current terminal worker attempt; do not launch a duplicate" : "launch the current lease worker";
    else if (state?.status === "active" && state.stage === "verify") nextAction = "work_verify";
    else if (state?.status === "paused" && decisions.length > 0) nextAction = `work_decide ${decisions[0].id}`;
    else if (state && ["paused", "stopped"].includes(state.status)) nextAction = `/start-work ${state.planSlug}`;
    else if (!state && plan?.momus.verdict === "approved") nextAction = `/start-work ${plan.slug}`;
    const metisReview = brief ? {
      readiness: brief.metis.readiness,
      current: brief.metis.briefHash === brief.briefHash,
      reviewedHash: brief.metis.briefHash,
      reviewedAt: brief.metis.reviewedAt,
      blockingGaps: brief.metis.blockingGaps,
      nonBlockingRisks: brief.metis.nonBlockingRisks,
      directives: brief.metis.directives,
    } : undefined;
    const momusReview = plan ? {
      verdict: plan.momus.verdict,
      current: plan.momus.planHash === plan.specHash,
      reviewedHash: plan.momus.planHash,
      reviewedAt: plan.momus.reviewedAt,
      blockingFindings: plan.momus.blockingFindings,
      nonBlockingNotes: plan.momus.nonBlockingNotes,
    } : undefined;
    const latestReview = momusReview?.reviewedAt && (!metisReview?.reviewedAt || momusReview.reviewedAt >= metisReview.reviewedAt)
      ? { reviewer: "momus", ...momusReview }
      : metisReview?.reviewedAt ? { reviewer: "metis", ...metisReview } : undefined;
    return {
      mode: session.mode,
      brief: brief ? { slug: brief.slug, hash: brief.briefHash, readiness: brief.metis.readiness } : undefined,
      plan: plan ? { slug: plan.slug, hash: plan.specHash, revision: plan.revision, verdict: plan.momus.verdict, progress: getProgress(plan) } : undefined,
      reviews: { metis: metisReview, momus: momusReview, latest: latestReview },
      execution: state ? { status: state.status, stage: state.stage, generation: state.generation, ownerId: state.ownerId, leaseId: state.lease?.id, taskIds: state.lease?.taskIds ?? [], workerAttempt: state.workerAttempt, workerRunId: state.workerRunId, failure: state.lastFailure?.split("\n")[0] } : undefined,
      pendingDecisions: decisions,
      nextAction,
    };
  }

  async function importMetisValue(root: string, value: MetisOutput) {
    if (!session.briefSlug) throw new Error("save a Planning Brief first");
    await withWorkLock(root, async () => {
      const brief = await readBrief(root, session.briefSlug!);
      if (brief.briefHash !== value.briefHash) throw new Error("stale Metis review transaction");
      await writeBrief(root, applyMetisReview(brief, value));
    });
    session.lastDirective = undefined;
    persistSession();
    return textResult(value.readiness === "ready" ? "Metis: READY. Generate the canonical plan." : `Metis: BLOCKED (${value.blockingGaps.length} gaps). Resolve them, revise the Brief, and run Metis again.`, value);
  }

  async function importMomusValue(root: string, value: MomusOutput) {
    if (!session.planSlug || !session.briefSlug) throw new Error("save a plan first");
    const planSlug = session.planSlug;
    await withWorkLock(root, async () => {
      const plan = await readPlan(root, planSlug);
      if (plan.specHash !== value.planHash) throw new Error("stale Momus review transaction");
      await writePlan(root, applyMomusReview(plan, value));
    });
    if (value.verdict === "approved") { restoreTools(); session.mode = "idle"; }
    session.lastDirective = undefined;
    persistSession();
    if (lastContext) await updateUI(lastContext);
    return textResult(value.verdict === "approved" ? `Momus approved ${planSlug}. Run /start-work ${planSlug}.` : `Momus rejected ${planSlug}. Revise the plan and review the new hash.`, value);
  }

  async function saveCanonicalPlan(root: string, plan: PlanDocument, expectedPreviousHash?: string) {
    return withWorkLock(root, async () => {
      const checkpoint = await readRuntime(root);
      const previous = checkpoint?.state ?? await readWorkState(root);
      if (previous && ["active", "paused", "stopped"].includes(previous.status)) throw new Error(`cannot replace nonterminal execution ${previous.planSlug}; abandon or complete it first`);
      if (expectedPreviousHash !== undefined && previous?.planHash !== expectedPreviousHash) throw new Error("stale canonical plan revision");
      const result = await writePlan(root, plan);
      await fs.rm(workPaths(root).runtimePath, { force: true });
      await writeWorkState(root, { version: 2, generation: (previous?.generation ?? 0) + 1, planSlug: plan.slug, planHash: plan.specHash, status: "planned", stage: "dispatch", receipts: [], updatedAt: new Date().toISOString() });
      return result;
    });
  }

  async function importWorkerValue(root: string, value: WorkerOutput, runId: string) {
    const runtime = await loadExecution(root);
    if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch") throw new Error("execution is not waiting for worker output");
    const { plan, state } = runtime;
    const lease = runtime.state.lease;
    const attempt = runtime.state.workerAttempt;
    if (!attempt || attempt.status !== "terminal" || !attempt.success || value.attemptId !== attempt.id || attempt.rootRunId !== runId) throw new Error("worker result is not bound to the current successful terminal attempt");
    const allowedPaths = plan.tasks.filter((task) => lease.taskIds.includes(task.id)).flatMap((task) => task.expectedPaths);
    for (const expectedPath of allowedPaths) await assertPathContained(root, expectedPath);
    const current = await snapshot(root);
    const actualChangedPaths = changedSince(lease.baseline, current);
    const outside = actualChangedPaths.filter((changed) => !pathAllowed(changed, allowedPaths));
    if (outside.length > 0) throw new Error(`worker modified paths outside the lease: ${outside.join(", ")}`);
    const needsDecision = value.semanticDelta.userDecisionNeeded.length > 0;
    if (value.status === "blocked" || needsDecision) {
      const blocker = value.blocker?.trim() || value.semanticDelta.userDecisionNeeded.join("; ") || "Worker reported a blocker";
      const withDelta = recordSemanticDelta(plan, lease.id, value.semanticDelta);
      const paused = { ...state, workerAttempt: { ...attempt, consumed: true }, workerRunId: runId, status: "paused" as const, stage: "dispatch" as const, lastFailure: blocker, stopReason: blocker, updatedAt: new Date().toISOString() };
      await persistExecution(root, withDelta, paused);
      restoreTools();
      session.mode = "idle";
      session.lastDirective = undefined;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(`Paused: ${blocker}. Record a pending decision ID with work_decide when applicable, then run /start-work.`, { leaseId: lease.id, blocker, semanticDelta: value.semanticDelta, pendingDecisions: pendingDecisions(withDelta) });
    }
    const imported = importWorkerOutput(plan, lease, attempt.id, value, actualChangedPaths);
    const verifying = { ...state, workerAttempt: { ...attempt, consumed: true }, workerRunId: runId, status: "active" as const, stage: "verify" as const, lastFailure: undefined, stopReason: undefined, updatedAt: new Date().toISOString() };
    await persistExecution(root, imported, verifying);
    session.lastDirective = undefined;
    persistSession();
    if (lastContext) await updateUI(lastContext);
    const delta = imported.semanticDeltas.at(-1)!;
    return textResult(`Worker slice imported. Semantic outcome: ${delta.accomplished.join("; ") || "implemented as planned"}. Run work_verify.`, { leaseId: lease.id, actualChangedPaths, semanticDelta: delta });
  }

  async function snapshot(root: string): Promise<Record<string, string>> {
    // ponytail: ignored untracked files stay outside the proof boundary; use OS sandboxing if they must be confined.
    const listed = await pi.exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
    const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: root });
    const index = await pi.exec("git", ["ls-files", "--stage", "-v", "-z"], { cwd: root });
    if (listed.code !== 0 || head.code !== 0 || index.code !== 0) throw new Error("execution requires a Git worktree with HEAD");
    const files = [...new Set(listed.stdout.split("\0").map(normalizePath).filter((item) => item && !item.startsWith(`${MANAGED_DIR}/`)))].sort();
    const result: Record<string, string> = { "\0git/HEAD": head.stdout.trim(), "\0git/index": createHash("sha256").update(index.stdout).digest("hex") };
    for (const file of files) {
      const absolute = path.join(root, file);
      try {
        const stat = await fs.lstat(absolute);
        const content = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(absolute)) : stat.isFile() ? await fs.readFile(absolute) : Buffer.from("[non-file]");
        result[file] = createHash("sha256").update(`${stat.mode}:${stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other"}:`).update(content).digest("hex");
      } catch { result[file] = "[deleted]"; }
    }
    return result;
  }

  function changedSince(baseline: Record<string, string>, current: Record<string, string>): string[] {
    return [...new Set([...Object.keys(baseline), ...Object.keys(current)])].filter((file) => baseline[file] !== current[file]).sort();
  }

  async function resolvePlan(root: string, requested: string | undefined, _ctx: ExtensionContext): Promise<PlanDocument | undefined> {
    const checkpoint = await readRuntime(root);
    const state = checkpoint?.state ?? await readWorkState(root);
    const canonicalSlug = state && !["completed", "abandoned"].includes(state.status) ? state.planSlug : undefined;
    if (requested && canonicalSlug && slugify(requested) !== canonicalSlug) throw new Error(`only canonical state-slot plan ${canonicalSlug} is executable`);
    if (canonicalSlug) return readPlan(root, canonicalSlug);
    const plans = (await listPlans(root)).filter((plan) => getProgress(plan).remaining > 0 && plan.momus.verdict === "approved" && plan.momus.planHash === plan.specHash);
    if (requested) return plans.find((plan) => plan.slug === slugify(requested)) ?? readPlan(root, requested);
    if (plans.length > 1) throw new Error(`multiple approved plans have no canonical state slot; run /plan to select one explicitly`);
    return plans[0];
  }

  async function assertPathContained(root: string, relative: string): Promise<void> {
    const realRoot = await fs.realpath(root);
    const candidate = path.resolve(realRoot, relative);
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) throw new Error(`path escapes repository: ${relative}`);
    let existing = candidate;
    while (existing !== realRoot) {
      try { await fs.lstat(existing); break; }
      catch { existing = path.dirname(existing); }
    }
    const realExisting = await fs.realpath(existing);
    if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`)) throw new Error(`symlink escapes repository: ${relative}`);
    const reserved = await repositoryReservedRoots(root);
    if (reserved.some((entry) => realExisting === entry || realExisting.startsWith(`${entry}${path.sep}`))) throw new Error(`path resolves into reserved workflow or Git state: ${relative}`);
  }

  async function resolveWithinRoot(root: string, relative: string): Promise<string> {
    const realRoot = await fs.realpath(root);
    const candidate = path.resolve(realRoot, relative);
    if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) throw new Error(`path escapes repository: ${relative}`);
    const real = await fs.realpath(candidate);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new Error(`symlink escapes repository: ${relative}`);
    return real;
  }

  async function hashArtifact(root: string, artifact: string): Promise<string> {
    return createHash("sha256").update(await fs.readFile(await resolveWithinRoot(root, artifact))).digest("hex");
  }

  async function runChecks(root: string, evidenceId: string, checks: CheckSpec[], scope: CheckReceipt["scope"], signal?: AbortSignal): Promise<{ receipts: CheckReceipt[]; failure?: string }> {
    const receipts: CheckReceipt[] = [];
    for (const check of checks) {
      const started = Date.now();
      const before = await snapshot(root);
      const cwd = await resolveWithinRoot(root, check.cwd ?? ".");
      const result = await pi.exec(check.program, check.args, { cwd, timeout: 10 * 60 * 1000, signal });
      const relativeDir = path.join(MANAGED_DIR, "evidence", evidenceId);
      const absoluteDir = path.join(root, relativeDir);
      await fs.mkdir(absoluteDir, { recursive: true });
      const stdoutPath = path.join(relativeDir, `${check.id}.stdout.log`).replaceAll("\\", "/");
      const stderrPath = path.join(relativeDir, `${check.id}.stderr.log`).replaceAll("\\", "/");
      await fs.writeFile(path.join(root, stdoutPath), result.stdout);
      await fs.writeFile(path.join(root, stderrPath), result.stderr);
      let exitCode = result.code;
      const after = await snapshot(root);
      const unexpectedCheckChanges = changedSince(before, after).filter((changed) => !pathAllowed(changed, check.artifacts));
      if (unexpectedCheckChanges.length > 0) {
        exitCode = exitCode || 1;
        await fs.appendFile(path.join(root, stderrPath), `\nCheck modified undeclared paths: ${unexpectedCheckChanges.join(", ")}\n`);
      }
      const artifactHashes: Record<string, string> = {};
      for (const artifact of check.artifacts) {
        try { artifactHashes[artifact] = await hashArtifact(root, artifact); }
        catch { exitCode = exitCode || 1; await fs.appendFile(path.join(root, stderrPath), `\nMissing artifact: ${artifact}\n`); }
      }
      receipts.push({ id: check.id, scope, command: [check.program, ...check.args], exitCode, durationMs: Date.now() - started, stdoutPath, stderrPath, artifactHashes });
      if (exitCode !== 0) {
        const excerpt = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-20).join("\n");
        return { receipts, failure: `${check.id} failed with exit ${exitCode}. Logs: ${stdoutPath}, ${stderrPath}\n${excerpt}` };
      }
    }
    return { receipts };
  }

  pi.registerTool({
    name: "workflow_status", label: "Workflow status", description: "Return the current durable stage, identities, review evidence and freshness, pending decisions, and exact next action.", parameters: ImportParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const status = await getWorkflowStatus(session.root ?? ctx.cwd);
      return textResult(JSON.stringify(status, null, 2), status);
    },
  });

  pi.registerTool({
    name: "plan_inspect", label: "Inspect repository", description: "Run a bounded read-only command without shell expansion during planning.", parameters: InspectParams,
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (session.mode !== "planning" || !session.root) throw new Error("plan_inspect is available only during /plan");
      const args = [...(params.args ?? [])];
      if (params.program === "git") {
        if (!["status", "diff", "log", "show", "grep", "ls-files", "rev-parse", "cat-file", "describe", "name-rev"].includes(args[0] ?? "")) throw new Error("plan_inspect permits only read-only Git commands");
        if (args.some((arg) => arg === "-o" || arg === "--ext-diff" || arg === "--textconv" || arg.startsWith("--output") || arg.startsWith("--open-files-in-pager"))) throw new Error("plan_inspect rejects Git output, pager, and external-command options");
        args.unshift("--no-optional-locks");
      }
      if (params.program === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) throw new Error("plan_inspect rejects external rg preprocessors");
      if (params.program === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"].includes(arg))) throw new Error("plan_inspect rejects mutating find actions");
      if (params.program === "nix") {
        if (!(args[0] === "eval" || (args[0] === "flake" && ["show", "metadata"].includes(args[1] ?? "")))) throw new Error("plan_inspect permits only nix eval, flake show, and flake metadata");
        if (args.some((arg) => ["--write-lock-file", "--commit-lock-file", "--update-input", "--write-to", "-o", "--out-link"].includes(arg) || arg.startsWith("--write-to=") || arg.startsWith("--out-link="))) throw new Error("plan_inspect rejects output and lock-file mutation");
        if (!args.includes("--no-write-lock-file")) args.push("--no-write-lock-file");
      }
      const root = await fs.realpath(session.root);
      const cwd = await fs.realpath(path.resolve(root, params.cwd ?? "."));
      if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) throw new Error("plan_inspect cwd must stay inside the repository");
      const result = await pi.exec(params.program, args, { cwd, timeout: 60_000 });
      const output = `${result.stdout}${result.stderr ? `${result.stdout ? "\n" : ""}${result.stderr}` : ""}`;
      const text = output.length > 50_000 ? `${output.slice(0, 25_000)}\n[output truncated; showing tail]\n${output.slice(-25_000)}` : output;
      return textResult(text || `(exit ${result.code}, no output)`, { exitCode: result.code, command: [params.program, ...args] });
    },
  });

  pi.registerTool({
    name: "planning_brief_save", label: "Save Planning Brief", description: "Save repository-grounded pre-plan context after tracing the relevant flow, integration points, failure boundaries, and validation strategy. Any change invalidates the previous Metis assessment.", parameters: BriefSaveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root) throw new Error("planning_brief_save is available only during /plan");
      const { brief, paths } = await withWorkLock(session.root, async () => {
        const previous = session.briefSlug ? await readBrief(session.root!, session.briefSlug).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }) : undefined;
        const brief = createPlanningBrief(params, previous);
        return { brief, paths: await writeBrief(session.root!, brief) };
      });
      session.briefSlug = brief.slug;
      session.lastDirective = undefined;
      persistSession();
      return textResult(`Saved ${path.relative(ctx.cwd, paths.jsonPath)} revision ${brief.revision}. Metis must assess brief hash ${brief.briefHash}.`, { slug: brief.slug, briefHash: brief.briefHash });
    },
  });

  pi.registerTool({
    name: "planning_brief_load", label: "Load Planning Brief", description: "Load the current structured planning context and Metis readiness.", parameters: LoadParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const slug = params.slug ? slugify(params.slug) : session.briefSlug;
      if (!slug) throw new Error("no active Planning Brief");
      const brief = await readBrief(session.root ?? ctx.cwd, slug);
      return textResult(JSON.stringify(brief, null, 2), { slug, briefHash: brief.briefHash, readiness: brief.metis.readiness });
    },
  });

  pi.registerTool({
    name: "metis_import", label: "Import Metis assessment", description: "Recovery-only import of the harness-owned, terminal, schema-validated Metis receipt.", parameters: ImportParams,
    async execute() {
      if (session.mode !== "planning" || !session.root || !session.briefSlug) throw new Error("save a Planning Brief first");
      const brief = await readBrief(session.root, session.briefSlug);
      const receipt = await readProviderReceipt(session.root, "metis", brief.briefHash, parseMetisOutput);
      if (receipt.value.briefPath !== `${MANAGED_DIR}/briefs/${brief.slug}.json` || receipt.value.briefHash !== brief.briefHash) throw new Error("Metis receipt identity mismatch");
      return importMetisValue(session.root, receipt.value);
    },
  });

  pi.registerTool({
    name: "plan_save", label: "Save canonical plan", description: "Create a worker-ready canonical plan whose tasks cite exact code anchors, explain flow and failure behavior, use narrow write paths, and map observable acceptance to relevant checks. Prefer plan_patch for targeted revisions.", parameters: PlanSaveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.briefSlug) throw new Error("save and assess a Planning Brief first");
      const brief = await readBrief(session.root, session.briefSlug);
      const previous = session.planSlug ? await readPlan(session.root, session.planSlug).catch(() => undefined) : undefined;
      const plan = createPlan(params, brief, previous);
      const paths = await saveCanonicalPlan(session.root, plan, previous?.specHash);
      session.planSlug = plan.slug;
      session.lastDirective = undefined;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(`Saved ${path.relative(ctx.cwd, paths.markdownPath)}. Momus must review plan hash ${plan.specHash} against Brief ${brief.briefHash}.`, concisePlan(plan));
    },
  });

  pi.registerTool({
    name: "plan_patch", label: "Patch canonical plan", description: "Revise selected top-level fields or existing tasks without resending the complete plan. Structural task additions, removals, or reordering still require plan_save.", parameters: PlanPatchParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.briefSlug || !session.planSlug) throw new Error("save a plan first");
      const brief = await readBrief(session.root, session.briefSlug);
      const current = await readPlan(session.root, session.planSlug);
      if (current.briefSlug !== brief.slug || current.briefHash !== brief.briefHash) throw new Error("plan is stale relative to the current Planning Brief");
      const plan = patchPlan(current, brief, params);
      const paths = await saveCanonicalPlan(session.root, plan, current.specHash);
      session.lastDirective = undefined;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(`Patched ${path.relative(ctx.cwd, paths.markdownPath)} to revision ${plan.revision}. Momus review is pending for the new current hash.`, concisePlan(plan));
    },
  });

  pi.registerTool({
    name: "plan_load", label: "Load plan", description: "Load a concise plan status by default, or the full canonical plan when full=true.", parameters: LoadParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const slug = params.slug ? slugify(params.slug) : session.planSlug;
      if (!slug) throw new Error("no active plan");
      const plan = await readPlan(session.root ?? ctx.cwd, slug);
      return textResult(JSON.stringify(params.full ? plan : concisePlan(plan), null, 2), concisePlan(plan));
    },
  });

  pi.registerTool({
    name: "momus_import", label: "Import Momus review", description: "Recovery-only import of the harness-owned, terminal, schema-validated Momus receipt.", parameters: ImportParams,
    async execute() {
      if (session.mode !== "planning" || !session.root || !session.planSlug || !session.briefSlug) throw new Error("save a plan first");
      const plan = await readPlan(session.root, session.planSlug);
      const brief = await readBrief(session.root, session.briefSlug);
      if (plan.briefSlug !== brief.slug || plan.briefHash !== brief.briefHash) throw new Error("plan is stale relative to the current Planning Brief");
      const receipt = await readProviderReceipt(session.root, "momus", plan.specHash, parseMomusOutput);
      if (receipt.value.planPath !== `${MANAGED_DIR}/plans/${plan.slug}.md` || receipt.value.planHash !== plan.specHash) throw new Error("Momus receipt identity mismatch");
      return importMomusValue(session.root, receipt.value);
    },
  });

  pi.registerTool({
    name: "work_import", label: "Import worker slice", description: "Recovery-only import of the current terminal worker attempt's harness-owned, schema-validated receipt.", parameters: ImportParams,
    async execute() {
      if (session.mode !== "executing" || !session.root || !session.planSlug) throw new Error("no active execution");
      const runtime = await loadExecution(session.root);
      const attempt = runtime?.state.workerAttempt;
      if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch" || !attempt || attempt.consumed || ["running", "unresolved"].includes(attempt.status) || (attempt.status === "terminal" && !attempt.success)) throw new Error("execution has no unconsumed successful terminal worker attempt to import");
      const receipt = await readProviderReceipt(session.root, "worker", attempt.id, parseWorkerOutput);
      if (receipt.value.leaseId !== runtime.state.lease.id || receipt.value.attemptId !== attempt.id || receipt.value.planHash !== runtime.plan.specHash || JSON.stringify(receipt.value.taskIds) !== JSON.stringify(runtime.state.lease.taskIds)) throw new Error("worker receipt identity mismatch");
      if (attempt.status === "reserved") await persistExecution(session.root, runtime.plan, { ...runtime.state, workerAttempt: { ...attempt, status: "terminal", rootRunId: receipt.rootRunId, childRunId: receipt.childRunId, success: true, endedAt: receipt.recordedAt }, workerRunId: receipt.rootRunId, updatedAt: new Date().toISOString() });
      return importWorkerValue(session.root, receipt.value, receipt.rootRunId);
    },
  });

  pi.registerTool({
    name: "work_decide", label: "Record execution decision", description: "Record a user-approved decision for a paused worker question without carrying operational history forward.", parameters: DecisionParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = session.root ?? ctx.cwd;
      const runtime = await loadExecution(root);
      if (!runtime?.state.lease || runtime.state.status !== "paused") throw new Error("execution is not paused for a decision");
      const pending = pendingDecisions(runtime.plan);
      const selected = pending.find((item) => item.id === params.decisionId.trim());
      if (!selected) throw new Error(`unknown pending decision ID; call workflow_status for ${pending.map((item) => item.id).join(", ") || "the current state"}`);
      const plan = recordExecutionDecision(runtime.plan, selected.question, params.decision, params.rationale, params.references ?? []);
      const leaseId = runtime.state.lease.id;
      const state = { ...runtime.state, stage: "dispatch" as const, workerAttempt: undefined, workerRunId: undefined, lastFailure: undefined, stopReason: "Decision recorded; explicit /start-work required", updatedAt: new Date().toISOString() };
      await persistExecution(root, plan, state);
      if (lastContext) await updateUI(lastContext);
      return textResult(`Decision recorded for lease ${leaseId}. Run /start-work ${plan.slug} to continue.`, { decision: params.decision, strategicVersion: contentHash(plan.semanticDeltas) });
    },
  });

  pi.registerTool({
    name: "work_verify", label: "Verify worker and wave", description: "Run worker, wave, and when applicable final checks. Only verified work unlocks dependencies.", parameters: ImportParams,
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (session.mode !== "executing" || !session.root || !session.planSlug) throw new Error("no active execution");
      const runtime = await loadExecution(session.root);
      if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "verify" || runtime.state.ownerId !== session.ownerId) throw new Error("execution has no owned imported slice to verify");
      if (runtime.state.verificationAttempt?.status === "running") throw new Error(`verification ${runtime.state.verificationAttempt.id} is already running`);
      const verificationAttempt = { id: randomUUID(), status: "running" as const, startedAt: new Date().toISOString() };
      const state = await persistExecution(session.root, runtime.plan, { ...runtime.state, verificationAttempt, updatedAt: new Date().toISOString() });
      const lease = runtime.state.lease;
      let plan = runtime.plan;
      const tasks = plan.tasks.filter((task) => lease.taskIds.includes(task.id));
      const workerChecks = tasks.flatMap((task) => task.workerChecks);
      const waveChecks = tasks.flatMap((task) => task.waveChecks);
      const evidenceId = `${lease.id}/${state.workerAttempt?.id ?? `verify-${lease.attempt}`}/${verificationAttempt.id}`;
      const workerResult = await runChecks(session.root, evidenceId, workerChecks, "worker", signal);
      let receipts = workerResult.receipts;
      let failure = workerResult.failure;
      if (!failure) {
        const waveResult = await runChecks(session.root, evidenceId, waveChecks, "wave", signal);
        receipts = [...receipts, ...waveResult.receipts];
        failure = waveResult.failure;
      }
      const isFinalSlice = plan.tasks.every((task) => lease.taskIds.includes(task.id) || task.status === "completed");
      if (!failure && isFinalSlice) {
        const finalResult = await runChecks(session.root, evidenceId, plan.finalChecks, "final", signal);
        receipts = [...receipts, ...finalResult.receipts];
        failure = finalResult.failure;
      }
      if (!failure) {
        const afterChecks = await snapshot(session.root);
        const changedPaths = changedSince(lease.baseline, afterChecks);
        const allowedPaths = tasks.flatMap((task) => task.expectedPaths);
        const artifactPaths = [...workerChecks, ...waveChecks, ...(isFinalSlice ? plan.finalChecks : [])].flatMap((check) => check.artifacts);
        const outside = changedPaths.filter((changed) => !pathAllowed(changed, [...allowedPaths, ...artifactPaths]));
        if (outside.length > 0) failure = `Verification modified paths outside the lease: ${outside.join(", ")}`;
      }
      if (failure) {
        const updated: WorkState = { ...state, stage: "dispatch", workerAttempt: undefined, workerRunId: undefined, verificationAttempt: undefined, receipts: [...state.receipts, ...receipts], lastFailure: failure, lease: { ...lease, attempt: lease.attempt + 1 }, updatedAt: new Date().toISOString() };
        await persistExecution(session.root, plan, updated);
        session.lastDirective = undefined;
        persistSession();
        if (lastContext) await updateUI(lastContext);
        return textResult(`Verification failed; repair the same lease and import it again.\n${failure}`, { leaseId: lease.id, receipts });
      }
      plan = completeLease(plan, lease, receipts);
      const current = await snapshot(session.root);
      const ready = getReadyTasks(plan);
      const now = new Date().toISOString();
      const nextLease = ready.length ? createLease(plan, current) : undefined;
      await persistExecution(session.root, plan, {
        ...state,
        planHash: plan.specHash,
        status: nextLease ? "active" : "completed",
        stage: "dispatch",
        lease: nextLease,
        workerAttempt: undefined,
        workerRunId: undefined,
        verificationAttempt: undefined,
        receipts: [...state.receipts, ...receipts],
        lastFailure: undefined,
        endedAt: nextLease ? undefined : now,
        updatedAt: now,
      });
      if (!nextLease) { restoreTools(); session.mode = "idle"; }
      session.lastDirective = undefined;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      const delta = plan.semanticDeltas.find((item) => item.leaseId === lease.id);
      return textResult(nextLease ? `Slice verified and integrated. Next lease ${nextLease.id}: ${nextLease.taskIds.join(", ")}.` : `Plan ${plan.slug} completed. Worker, wave, and final checks passed.`, { progress: getProgress(plan), semanticDelta: delta, nextLease });
    },
  });

  pi.registerCommand("plan", {
    description: "Create a Metis-ready and Momus-approved durable plan",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      let request = args.trim();
      if (!request && ctx.hasUI) request = (await ctx.ui.editor("What should be planned?", ""))?.trim() ?? "";
      if (!request) { ctx.ui.notify("Usage: /plan <request>", "warning"); return; }
      const checkpoint = await readRuntime(ctx.cwd);
      const state = checkpoint?.state ?? await readWorkState(ctx.cwd);
      if (state && ["active", "paused", "stopped"].includes(state.status)) { ctx.ui.notify(`Work ${state.planSlug} is nonterminal. Complete or explicitly abandon it first.`, "warning"); return; }
      restoreTools();
      session = { mode: "planning", root: ctx.cwd, planningTools: pi.getActiveTools() };
      enterPlanning();
      persistSession();
      await updateUI(ctx);
      pi.sendUserMessage(`[PLAN REQUEST]\n${request}`);
    },
  });

  pi.registerCommand("cancel-plan", {
    description: "Leave planning mode without deleting saved Briefs or plans",
    handler: async (_args, ctx) => {
      if (session.mode !== "planning") { ctx.ui.notify("Planning mode is not active.", "info"); return; }
      restoreTools();
      session = { mode: "idle" };
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify("Planning mode cancelled; saved planning artifacts were kept.", "info");
    },
  });

  pi.registerCommand("start-work", {
    description: "Start or resume a Momus-approved plan",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const checkpoint = await readRuntime(ctx.cwd);
      if (checkpoint) await withWorkLock(ctx.cwd, async () => { await writePlan(ctx.cwd, checkpoint.plan); await writeWorkState(ctx.cwd, checkpoint.state); });
      let plan: PlanDocument | undefined;
      try { plan = await resolvePlan(ctx.cwd, args.trim() || undefined, ctx); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
      if (!plan) { ctx.ui.notify("No incomplete plan found.", "warning"); return; }
      if (plan.momus.verdict !== "approved" || plan.momus.planHash !== plan.specHash) { ctx.ui.notify("Current plan hash is not approved by Momus.", "error"); return; }
      const brief = await readBrief(ctx.cwd, plan.briefSlug).catch(() => undefined);
      if (!brief || brief.briefHash !== plan.briefHash) { ctx.ui.notify("Plan is stale relative to its Planning Brief.", "error"); return; }
      let previous = checkpoint?.state ?? await readWorkState(ctx.cwd);
      if (previous && ["completed", "abandoned"].includes(previous.status) && previous.planHash !== plan.specHash) {
        previous = await withWorkLock(ctx.cwd, async () => {
          await fs.rm(workPaths(ctx.cwd).runtimePath, { force: true });
          const selected: WorkState = { version: 2, generation: previous!.generation + 1, planSlug: plan!.slug, planHash: plan!.specHash, status: "planned", stage: "dispatch", receipts: [], updatedAt: new Date().toISOString() };
          await writeWorkState(ctx.cwd, selected);
          return selected;
        });
      }
      if (previous?.status === "active") {
        if (previous.planSlug !== plan.slug || previous.planHash !== plan.specHash || !previous.lease || !session.ownerId || previous.ownerId !== session.ownerId) { ctx.ui.notify(`Work ${previous.planSlug} is owned by another live or unreconciled session; do not launch a duplicate.`, "error"); return; }
        restoreTools();
        session = { ...session, mode: "executing", root: ctx.cwd, planSlug: plan.slug, executionTools: pi.getActiveTools() };
        enterExecution();
        persistSession();
        await updateUI(ctx);
        ctx.ui.notify(`Reattached to owned work ${plan.slug}.`, "info");
        pi.sendUserMessage(`[EXECUTION RESUMED]\nPlan ${plan.slug}; lease ${previous.lease.id}.`);
        return;
      }
      if (previous?.status === "paused" && pendingDecisions(plan).length > 0) { ctx.ui.notify("Resolve pending decisions with work_decide before resuming.", "error"); return; }
      if (previous?.verificationAttempt?.status === "running") { ctx.ui.notify(`Verification ${previous.verificationAttempt.id} has unresolved liveness; do not resume.`, "error"); return; }
      if (previous?.workerAttempt && ["reserved", "running", "unresolved"].includes(previous.workerAttempt.status)) {
        const receiptExists = await validWorkerReceipt(ctx.cwd, plan, previous);
        if (!receiptExists) { ctx.ui.notify(`Worker attempt ${previous.workerAttempt.id} has unresolved liveness; do not launch a replacement.`, "error"); return; }
      }
      if (ctx.hasUI && !(await ctx.ui.confirm("Start work?", `${plan.title}\n${getProgress(plan).remaining} tasks remain`))) return;
      restoreTools();
      const ownerId = randomUUID();
      session = { mode: "executing", root: ctx.cwd, planSlug: plan.slug, executionTools: pi.getActiveTools(), ownerId };
      enterExecution();
      const resumable = Boolean(previous?.planSlug === plan.slug && previous.planHash === plan.specHash && previous.lease && ["paused", "stopped"].includes(previous.status));
      for (const expectedPath of plan.tasks.flatMap((task) => task.expectedPaths)) await assertPathContained(ctx.cwd, expectedPath);
      const lease = resumable ? previous!.lease! : createLease(plan, await snapshot(ctx.cwd));
      const recoverableAttempt = resumable && previous!.workerAttempt && await validWorkerReceipt(ctx.cwd, plan, previous) ? previous!.workerAttempt : undefined;
      const now = new Date().toISOString();
      await persistExecution(ctx.cwd, plan, { ...(resumable ? previous : {}), version: 2, generation: previous?.generation ?? 0, ownerId, planSlug: plan.slug, planHash: plan.specHash, status: "active", stage: resumable ? previous!.stage : "dispatch", lease, workerAttempt: recoverableAttempt, workerRunId: recoverableAttempt?.rootRunId, receipts: resumable ? previous!.receipts : [], startedAt: previous?.startedAt ?? now, updatedAt: now, stopReason: undefined });
      session.lastDirective = undefined;
      session.lastStrategicVersion = undefined;
      persistSession();
      await updateUI(ctx);
      pi.sendUserMessage(`[EXECUTION STARTED]\nPlan ${plan.slug}; lease ${lease.id}.`);
    },
  });

  pi.registerCommand("work-status", {
    description: "Show concise durable progress",
    handler: async (_args, ctx) => {
      const status = await getWorkflowStatus(ctx.cwd);
      if (!status.execution && !status.plan && !status.brief) { ctx.ui.notify("No workflow state found.", "info"); return; }
      const pending = status.pendingDecisions.map((item) => `${item.id}: ${item.question}`).join("\n");
      ctx.ui.notify(`${status.plan?.slug ?? status.brief?.slug ?? "workflow"}\nMode: ${status.mode}\nStatus: ${status.execution ? `${status.execution.status}/${status.execution.stage}` : status.plan?.verdict ?? status.brief?.readiness}\nProgress: ${status.plan ? `${status.plan.progress.completed}/${status.plan.progress.total}` : "not planned"}\nLease: ${status.execution?.taskIds.join(", ") || "none"}${status.execution?.workerRunId ? `\nWorker: ${status.execution.workerRunId}` : ""}${status.execution?.failure ? `\nFailure: ${status.execution.failure}` : ""}${pending ? `\nPending decisions:\n${pending}` : ""}\nNext: ${status.nextAction}`, "info");
    },
  });

  pi.registerCommand("stop-work", {
    description: "Stop execution when no worker call is in flight",
    handler: async (args, ctx) => {
      const root = session.root ?? ctx.cwd;
      const runtime = await loadExecution(root);
      if (!runtime || runtime.state.status !== "active") { ctx.ui.notify("No active work state found.", "info"); return; }
      if (!session.ownerId || runtime.state.ownerId !== session.ownerId) { ctx.ui.notify("Only the owning session may stop active work.", "error"); return; }
      if (runtime.state.workerAttempt && runtime.state.workerAttempt.status !== "terminal") { ctx.ui.notify("The foreground worker call must return or be interrupted before work can stop.", "error"); return; }
      if (runtime.state.verificationAttempt?.status === "running") { ctx.ui.notify("Verification must terminate before work can stop.", "error"); return; }
      await persistExecution(root, runtime.plan, { ...runtime.state, status: "stopped", ownerId: undefined, stopReason: args.trim() || "Stopped by user", updatedAt: new Date().toISOString() });
      restoreTools();
      session = { mode: "idle" };
      if (!ctx.isIdle()) ctx.abort();
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Stopped ${runtime.state.planSlug}.`, "warning");
    },
  });

  pi.registerCommand("abandon-work", {
    description: "Explicitly abandon a nonterminal execution and release its durable ownership",
    handler: async (args, ctx) => {
      const root = session.root ?? ctx.cwd;
      const runtime = await loadExecution(root);
      if (!runtime || !["active", "paused", "stopped"].includes(runtime.state.status)) { ctx.ui.notify("No nonterminal work state found.", "info"); return; }
      const owned = Boolean(session.ownerId && runtime.state.ownerId === session.ownerId);
      if (runtime.state.verificationAttempt?.status === "running") { ctx.ui.notify("Verification liveness is unresolved; abandonment is blocked.", "error"); return; }
      const orphanConfirmation = `orphan ${runtime.plan.specHash}`;
      if (!owned && args.trim() !== orphanConfirmation) { ctx.ui.notify(`Orphan takeover requires: /abandon-work ${orphanConfirmation}`, "error"); return; }
      if (runtime.state.workerAttempt && ["reserved", "running", "unresolved"].includes(runtime.state.workerAttempt.status) && args.trim() !== orphanConfirmation) { ctx.ui.notify(`Worker liveness is unresolved; confirm orphan termination with: /abandon-work ${orphanConfirmation}`, "error"); return; }
      if (ctx.hasUI && !(await ctx.ui.confirm("Abandon work?", `${runtime.plan.title}\nConfirm the owning process and worker are terminated. This invalidates the current lease and receipts.`))) return;
      await persistExecution(root, runtime.plan, { ...runtime.state, status: "abandoned", ownerId: undefined, stopReason: args.trim() || "Explicitly abandoned by user", endedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      restoreTools();
      session = { mode: "idle" };
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Abandoned ${runtime.state.planSlug}.`, "warning");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    lastContext = ctx;
    if (session.mode === "planning" && session.root) {
      const brief = session.briefSlug ? await readBrief(session.root, session.briefSlug).catch(() => undefined) : undefined;
      const savedPlan = session.planSlug ? await readPlan(session.root, session.planSlug).catch(() => undefined) : undefined;
      const plan = savedPlan && brief && savedPlan.briefSlug === brief.slug && savedPlan.briefHash === brief.briefHash ? savedPlan : undefined;
      const key = `planning:${brief?.briefHash ?? "new"}:${brief?.metis.readiness ?? "none"}:${plan?.specHash ?? "none"}:${plan?.momus.verdict ?? "none"}`;
      if (session.lastDirective === key) return;
      session.lastDirective = key;
      persistSession();
      const metisDirectives = brief?.metis.directives.length ? ` Metis directives: ${brief.metis.directives.join("; ")}.` : "";
      const next = !brief
        ? "Trace the relevant behavior end to end: current entry points, boundary symbols, callers or consumers, integration wiring, applicable failure paths, and existing validation. Ask only material unresolved questions, then call planning_brief_save with exact repository anchors."
        : brief.metis.readiness !== "ready"
          ? `Run one foreground Metis against ${MANAGED_DIR}/briefs/${brief.slug}.json and hash ${brief.briefHash}. The harness disables package acceptance, accepts only the validated structured result, persists its terminal receipt, and imports it automatically. If blocked, resolve every gap and revise the Brief.`
          : !plan
            ? `Metis is READY.${metisDirectives} Generate a worker-ready canonical plan with exact code anchors, narrow write paths, explicit data/control flow and failure behavior, and observable acceptance mapped to relevant worker, wave, and final check IDs using plan_save.`
            : plan.momus.verdict === "rejected"
              ? `Momus rejected the current hash. Apply every persisted blocking correction with plan_patch, or plan_save when task structure must change, before requesting a fresh review. Findings: ${plan.momus.blockingFindings.map((item) => item.requiredCorrection).join("; ")}`
              : plan.momus.verdict !== "approved"
                ? "Call one foreground Momus subagent. The harness supplies the authoritative Brief and Plan JSON, Markdown companion, and plan hash, disables package acceptance, accepts only the validated structured result, and imports it automatically."
                : `Planning is approved. Summarize the end-to-end approach, implementation slices, failure coverage, and validation for the user, then offer /start-work ${plan.slug}.`;
      return { message: { customType: "plan-execute-planning-v2", display: false, content: `Planning is read-only. Preserve goal, approved decisions, repository evidence, integration and failure behavior, acceptance-to-check mapping, and risks; omit operational tool chatter. A fresh worker must not need to rediscover material control flow or architecture. Call workflow_status whenever the next step is unclear. ${next}` } };
    }
    if (session.mode === "executing" && session.root && session.planSlug) {
      const runtime = await loadExecution(session.root);
      if (!runtime?.state.lease || runtime.state.status !== "active") return;
      const { plan, state } = runtime;
      const lease = runtime.state.lease;
      const strategicVersion = `${plan.specHash}:${contentHash(plan.semanticDeltas)}`;
      let strategic = "";
      if (session.lastStrategicVersion === undefined) strategic = `Strategic context:\n${renderStrategicContext(plan)}\n\n`;
      else if (session.lastStrategicVersion !== strategicVersion && plan.semanticDeltas.length > 0) strategic = `Semantic context delta:\n${renderSemanticDelta(plan.semanticDeltas.at(-1)!)}\n\n`;
      session.lastStrategicVersion = strategicVersion;
      const attempt = state.workerAttempt;
      const receiptReady = await validWorkerReceipt(session.root, plan, state);
      const key = `${lease.id}:${state.stage}:${lease.attempt}:${attempt?.id ?? "new"}:${attempt?.status ?? "none"}:${receiptReady}`;
      if (session.lastDirective === key && !strategic) return;
      session.lastDirective = key;
      persistSession();
      const failure = state.lastFailure ? `\nPrevious verification failure:\n${state.lastFailure}\n` : "";
      const directive = state.stage === "dispatch"
        ? receiptReady
          ? `${failure}The current worker attempt has one harness-owned terminal validated receipt. Call work_import.`
          : attempt
            ? `${failure}Worker attempt ${attempt.id} is already ${attempt.status}. Do not launch a duplicate; wait for the foreground tool result or reconcile its failure.`
            : `${failure}Launch exactly one fresh plan-worker for lease ${lease.id} and plan hash ${plan.specHash}. The harness reserves a unique dispatch attempt, forces synchronous foreground execution, disables package acceptance, and accepts only the package-validated structured value. plan-worker has no live supervisor tool and must return blocked when a decision is required.\n\n${renderTasks(plan, lease.taskIds)}`
        : "The worker output is imported. Call work_verify; the extension, not the model, runs worker, wave, and final checks.";
      return { message: { customType: "plan-execute-lease-v2", display: false, content: `${strategic}${directive}` } };
    }
  });

  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown>;
    if (session.mode === "planning") {
      if (MUTATION_TOOLS.has(event.toolName) || (/(write|edit|patch|fix|apply)/i.test(event.toolName) && !["planning_brief_save", "metis_import", "plan_save", "plan_patch", "momus_import"].includes(event.toolName))) {
        return { block: true, reason: `${event.toolName} is disabled during planning` };
      }
      if (event.toolName === "subagent") {
        const agent = typeof input.agent === "string" ? input.agent : undefined;
        if (!agent || !["metis", "momus", "scout", "researcher", "oracle"].includes(agent) || input.workflowScript) return { block: true, reason: "Planning delegates only Metis, Momus, scout, researcher, or oracle" };
        if (["scout", "researcher", "oracle"].includes(agent)) {
          Object.assign(input, { async: true, context: agent === "oracle" ? "fork" : "fresh", worktree: true });
        } else if (agent === "metis") {
          if (!session.root || !session.briefSlug) return { block: true, reason: "save a Planning Brief first" };
          const brief = await readBrief(session.root, session.briefSlug);
          Object.assign(input, { task: metisAssessmentTask(brief.slug, brief.briefHash), async: false, context: "fresh", worktree: false, acceptance: { level: "none", reason: "Plan Execute owns semantic review validation." }, outputSchema: METIS_SCHEMA, output: false });
          delete input.outputMode;
        } else {
          if (!session.root || !session.briefSlug || !session.planSlug) return { block: true, reason: "save a plan first" };
          const brief = await readBrief(session.root, session.briefSlug);
          const plan = await readPlan(session.root, session.planSlug);
          if (plan.briefHash !== brief.briefHash) return { block: true, reason: "plan is stale relative to the current Planning Brief" };
          Object.assign(input, { task: momusReviewTask(brief.slug, plan.slug, plan.specHash), async: false, context: "fresh", worktree: false, acceptance: { level: "none", reason: "Plan Execute owns semantic review validation." }, outputSchema: MOMUS_SCHEMA, output: false });
          delete input.outputMode;
        }
      }
    }
    if (session.mode === "executing") {
      if (MUTATION_TOOLS.has(event.toolName) || /(write|edit|patch|fix|apply)/i.test(event.toolName)) return { block: true, reason: "The main agent retains strategy but does not perform worker or verification operations" };
      if (event.toolName === "subagent") {
        if (input.action) return { block: true, reason: "Execution may only launch the current lease worker" };
        if (input.agent !== "plan-worker" || input.workflowScript) return { block: true, reason: "Execution launches one plan-worker for the current lease" };
        if (!session.root || !session.planSlug) return { block: true, reason: "no active lease" };
        const runtime = await loadExecution(session.root);
        if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch" || runtime.state.ownerId !== session.ownerId) return { block: true, reason: "worker launch does not own the current active dispatch lease" };
        if (runtime.state.workerAttempt) return { block: true, reason: `worker attempt ${runtime.state.workerAttempt.id} already exists; do not launch a duplicate` };
        const attempt: WorkerAttempt = { id: randomUUID(), number: runtime.state.lease.attempt, status: "reserved", toolCallId: (event as unknown as { toolCallId?: string }).toolCallId, startedAt: new Date().toISOString() };
        await persistExecution(session.root, runtime.plan, { ...runtime.state, workerAttempt: attempt, workerRunId: undefined, updatedAt: new Date().toISOString() });
        Object.assign(input, {
          task: `Implement lease ${runtime.state.lease.id}, dispatch attempt ${attempt.id}, plan hash ${runtime.plan.specHash}, and task IDs ${runtime.state.lease.taskIds.join(", ")}. Return status blocked with userDecisionNeeded instead of contacting the supervisor. Do not write workflow state or provider evidence.\n\n${renderStrategicContext(runtime.plan)}${runtime.state.lastFailure ? `\n\nPrevious verification failure:\n${runtime.state.lastFailure}` : ""}\n\nAssigned tasks:\n${renderTasks(runtime.plan, runtime.state.lease.taskIds)}`,
          foregroundOnly: true,
          async: false,
          context: "fresh",
          worktree: false,
          acceptance: { level: "none", reason: "Plan Execute owns worker identity, semantic output, and deterministic verification." },
          outputSchema: WORKER_SCHEMA,
          output: false,
        });
        delete input.outputMode;
      }
    }
    if (/(write|edit|patch|fix|apply)/i.test(event.toolName)) {
      const target = getTargetPath(input);
      const root = session.root ?? lastContext?.cwd;
      if (target && root && await targetsReservedPath(root, target)) return { block: true, reason: `${MANAGED_DIR} and .git are extension-reserved` };
    }
    if (event.toolName === "bash" && String(input.command ?? "").replaceAll("\\", "/").includes(MANAGED_DIR)) return { block: true, reason: `${MANAGED_DIR} is extension-managed` };
  });

  pi.on("tool_execution_end", async (event) => {
    const ended = event as unknown as { toolName?: string; toolCallId?: string; args?: Record<string, unknown>; isError?: boolean };
    if (!ended.isError || !session.root) return;
    const runtime = await loadExecution(session.root);
    if (!runtime) return;
    if (ended.toolName === "subagent" && ended.args?.agent === "plan-worker") {
      const attempt = runtime.state.workerAttempt;
      if (!attempt || attempt.status !== "reserved" || !attempt.toolCallId || attempt.toolCallId !== ended.toolCallId) return;
      await persistExecution(session.root, runtime.plan, { ...runtime.state, workerAttempt: undefined, workerRunId: undefined, lastFailure: "Worker launch failed before a foreground child started", updatedAt: new Date().toISOString() });
    } else if (ended.toolName === "work_verify" && runtime.state.verificationAttempt?.status === "running") {
      await persistExecution(session.root, runtime.plan, { ...runtime.state, status: "paused", ownerId: undefined, verificationAttempt: { ...runtime.state.verificationAttempt, status: "terminal", endedAt: new Date().toISOString() }, lastFailure: "Verification tool terminated with an error", stopReason: "Verification failed", updatedAt: new Date().toISOString() });
    } else return;
    session.lastDirective = undefined;
    persistSession();
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent" || !session.root) return;
    const agent = event.input.agent;
    if (!(["metis", "momus", "plan-worker"] as unknown[]).includes(agent)) return;
    const isError = Boolean((event as unknown as { isError?: boolean }).isError);
    try {
      if (agent === "metis" && session.mode === "planning" && session.briefSlug) {
        const brief = await readBrief(session.root, session.briefSlug);
        const result = structuredResult(event.details, "metis", isError);
        const value = parseMetisOutput(JSON.stringify(result.value));
        if (value.briefPath !== `${MANAGED_DIR}/briefs/${brief.slug}.json` || value.briefHash !== brief.briefHash) throw new Error("Metis result identity mismatch");
        await writeProviderReceipt(session.root, { version: 1, agent: "metis", identity: brief.briefHash, rootRunId: result.rootRunId, childRunId: result.childRunId, recordedAt: new Date().toISOString(), value });
        await importMetisValue(session.root, value);
        pi.sendMessage({ customType: "plan-execute-metis-review-v2", display: false, content: `Metis review imported for current Brief hash ${value.briefHash}.\n${JSON.stringify({ readiness: value.readiness, blockingGaps: value.blockingGaps, nonBlockingRisks: value.nonBlockingRisks, directives: value.directives }, null, 2)}` }, { deliverAs: "steer" });
        lastContext?.ui.notify("Metis result imported automatically.", "info");
      } else if (agent === "momus" && session.mode === "planning" && session.briefSlug && session.planSlug) {
        const brief = await readBrief(session.root, session.briefSlug);
        const plan = await readPlan(session.root, session.planSlug);
        if (plan.briefHash !== brief.briefHash) throw new Error("plan is stale relative to the current Planning Brief");
        const result = structuredResult(event.details, "momus", isError);
        const value = parseMomusOutput(JSON.stringify(result.value));
        if (value.planPath !== `${MANAGED_DIR}/plans/${plan.slug}.md` || value.planHash !== plan.specHash) throw new Error("Momus result identity mismatch");
        await writeProviderReceipt(session.root, { version: 1, agent: "momus", identity: plan.specHash, rootRunId: result.rootRunId, childRunId: result.childRunId, recordedAt: new Date().toISOString(), value });
        await importMomusValue(session.root, value);
        pi.sendMessage({ customType: "plan-execute-momus-review-v2", display: false, content: `Momus review imported for current plan hash ${value.planHash}.\n${JSON.stringify({ verdict: value.verdict, blockingFindings: value.blockingFindings, nonBlockingNotes: value.nonBlockingNotes }, null, 2)}` }, { deliverAs: "steer" });
        lastContext?.ui.notify("Momus result imported automatically.", "info");
      } else if (agent === "plan-worker" && session.mode === "executing") {
        const runtime = await loadExecution(session.root);
        const attempt = runtime?.state.workerAttempt;
        if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch" || !attempt || attempt.status !== "reserved") return;
        try {
          const result = structuredResult(event.details, "plan-worker", isError);
          const value = parseWorkerOutput(JSON.stringify(result.value));
          if (value.leaseId !== runtime.state.lease.id || value.attemptId !== attempt.id || value.planHash !== runtime.plan.specHash || JSON.stringify(value.taskIds) !== JSON.stringify(runtime.state.lease.taskIds)) throw new Error("worker result identity mismatch");
          await writeProviderReceipt(session.root, { version: 1, agent: "worker", identity: attempt.id, rootRunId: result.rootRunId, childRunId: result.childRunId, recordedAt: new Date().toISOString(), value });
          await persistExecution(session.root, runtime.plan, { ...runtime.state, workerAttempt: { ...attempt, status: "terminal", rootRunId: result.rootRunId, childRunId: result.childRunId, success: true, endedAt: new Date().toISOString() }, workerRunId: result.rootRunId, updatedAt: new Date().toISOString() });
          await importWorkerValue(session.root, value, result.rootRunId);
          lastContext?.ui.notify("Worker result imported automatically.", "info");
        } catch (error) {
          const latest = await loadExecution(session.root);
          if (latest?.state.status === "active" && latest.state.stage === "dispatch") {
            const details = event.details as { runId?: string; results?: StructuredChildResult[] } | undefined;
            const child = details?.results?.find((item) => item.agent === "plan-worker");
            const currentAttempt = latest.state.workerAttempt ?? attempt;
            const unresolved = Boolean(child?.detached);
            await persistExecution(session.root, latest.plan, { ...latest.state, status: "paused", workerAttempt: { ...currentAttempt, status: unresolved ? "unresolved" : "terminal", rootRunId: currentAttempt.rootRunId ?? details?.runId, childRunId: currentAttempt.childRunId ?? child?.runId, success: unresolved ? undefined : currentAttempt.success ?? false, endedAt: unresolved ? undefined : currentAttempt.endedAt ?? new Date().toISOString() }, workerRunId: currentAttempt.rootRunId ?? details?.runId, lastFailure: (error as Error).message, stopReason: unresolved ? "Foreground worker detached; terminal liveness is unresolved" : "Worker result could not be safely imported", updatedAt: new Date().toISOString() });
          }
          restoreTools();
          session.mode = "idle";
          persistSession();
          throw error;
        }
      }
    } catch (error) {
      lastContext?.ui.notify(`Automatic result import failed: ${(error as Error).message}`, "warning");
    }
  });

  pi.on("session_compact", async () => {
    session.lastStrategicVersion = undefined;
    session.lastDirective = undefined;
    persistSession();
  });

  pi.on("session_start", async (_event, ctx) => {
    lastContext = ctx;
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === WORKFLOW_CUSTOM_TYPE && entry.data) session = entry.data as SessionState;
    if (session.mode === "planning") enterPlanning();
    if (session.mode === "executing") {
      const root = session.root ?? ctx.cwd;
      const runtime = await loadExecution(root);
      restoreTools();
      session.mode = "idle";
      session.lastStrategicVersion = undefined;
      session.lastDirective = undefined;
      if (runtime?.state.status === "active" && runtime.state.ownerId === session.ownerId) {
        const attempt = runtime.state.workerAttempt;
        await persistExecution(root, runtime.plan, { ...runtime.state, status: "paused", ownerId: undefined, workerAttempt: attempt && attempt.status !== "terminal" ? { ...attempt, status: "unresolved" } : attempt, stopReason: attempt ? "Session ended during a foreground worker attempt; terminal liveness must be reconciled" : "Session resumed; explicit /start-work required", updatedAt: new Date().toISOString() });
      }
      persistSession();
    }
    await updateUI(ctx);
  });
}
