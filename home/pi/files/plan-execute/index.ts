import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyMetisReview,
  applyMomusReview,
  completeLease,
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
}

interface WaitCompletion {
  runId: string;
  agent?: string;
  success?: boolean;
  archivePath?: string;
  results?: Array<{ agent?: string; success?: boolean }>;
}

const StringList = Type.Array(Type.String());
const CheckInput = Type.Object({
  id: Type.String({ description: "Unique across every worker, wave, and final check in the plan; use a safe file-name token." }),
  program: Type.String({ description: "Executable name without a path or shell. Shells, mutating Git, unsafe Nix, and inline interpreter code are rejected." }),
  args: Type.Array(Type.String(), { description: "Direct argv entries; no shell expansion. nix build requires --no-link." }),
  cwd: Type.Optional(Type.String({ description: "Repository-relative working directory." })),
  artifacts: Type.Optional(Type.Array(Type.String({ description: "Repository-relative artifact path to hash after the check." }))),
});
const BriefSaveParams = Type.Object({
  request: Type.String(),
  requirements: Type.Array(Type.String(), { minItems: 1 }),
  decisions: Type.Optional(Type.Array(Type.Object({ text: Type.String(), rationale: Type.String() }))),
  assumptions: Type.Optional(StringList),
  constraints: Type.Optional(StringList),
  outOfScope: Type.Optional(StringList),
  repositoryEvidence: Type.Optional(Type.Array(Type.Object({ claim: Type.String(), references: Type.Array(Type.String(), { minItems: 1 }) }))),
  proposedApproach: Type.String(),
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
const PlanSaveParams = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  architecture: Type.Optional(Type.Array(Type.Object({ fact: Type.String(), references: Type.Array(Type.String(), { minItems: 1 }) }))),
  risks: Type.Optional(StringList),
  tasks: Type.Array(Type.Object({
    title: Type.String(),
    outcome: Type.String(),
    satisfies: Type.Array(Type.String({ description: "Planning Brief requirement ID such as R1." }), { minItems: 1 }),
    decisions: Type.Optional(Type.Array(Type.String({ description: "Planning Brief decision ID such as D1." }))),
    references: Type.Optional(StringList),
    dependsOn: Type.Optional(Type.Array(Type.String({ description: "Earlier task ID assigned by array order: T1, T2, and so on." }))),
    expectedPaths: Type.Array(Type.String(), { minItems: 1 }),
    acceptance: Type.Array(Type.String(), { minItems: 1 }),
    workerChecks: Type.Array(CheckInput, { minItems: 1 }),
    waveChecks: Type.Optional(Type.Array(CheckInput)),
  }), { minItems: 1 }),
  finalChecks: Type.Array(CheckInput, { minItems: 1 }),
});

const METIS_SCHEMA = {
  type: "object", required: ["briefPath", "briefHash", "readiness", "blockingGaps", "nonBlockingRisks", "directives"],
  properties: {
    briefPath: { type: "string" }, briefHash: { type: "string" }, readiness: { type: "string", enum: ["ready", "blocked"] },
    blockingGaps: { type: "array", items: { type: "object" } }, nonBlockingRisks: { type: "array", items: { type: "string" } }, directives: { type: "array", items: { type: "string" } },
  },
} as const;
const MOMUS_SCHEMA = {
  type: "object", required: ["planPath", "planHash", "verdict", "blockingFindings", "nonBlockingNotes"],
  properties: {
    planPath: { type: "string" }, planHash: { type: "string" }, verdict: { type: "string", enum: ["approved", "rejected"] },
    blockingFindings: { type: "array", items: { type: "object" } }, nonBlockingNotes: { type: "array", items: { type: "string" } },
  },
} as const;
const WORKER_SCHEMA = {
  type: "object", required: ["leaseId", "planHash", "taskIds", "status", "summary", "changedPaths", "semanticDelta"],
  properties: {
    leaseId: { type: "string" }, planHash: { type: "string" }, taskIds: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["implemented", "blocked"] }, summary: { type: "string" }, changedPaths: { type: "array", items: { type: "string" } }, blocker: { type: "string" }, semanticDelta: { type: "object" },
  },
} as const;

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function providerOutputPath(kind: "metis" | "momus" | "worker", identity: string): string {
  return path.join(MANAGED_DIR, "evidence", "provider", `${kind}-${identity}.json`).replaceAll("\\", "/");
}

async function readAsyncResult<T>(completions: WaitCompletion[], root: string, agent: string, outputPath: string, parse: (output: string) => T, matches: (value: T) => boolean): Promise<{ value: T; runId: string }> {
  const expected = path.resolve(root, outputPath);
  const failures: string[] = [];
  for (const completion of [...completions].reverse()) {
    const agentMatches = completion.agent === agent || completion.results?.some((child) => child.agent === agent && child.success !== false);
    if (!agentMatches || completion.success === false || !completion.archivePath) continue;
    try {
      const archive = JSON.parse(await fs.readFile(completion.archivePath, "utf8")) as { entries?: Array<{ source?: string; path?: string; agent?: string }> };
      const retained = archive.entries?.some((item) => item.source === "output-artifact" && item.path && path.resolve(item.path) === expected && (!item.agent || item.agent === agent));
      if (!retained) { failures.push(`${agent} completion did not retain the expected output artifact`); continue; }
      const value = parse(await fs.readFile(expected, "utf8"));
      if (matches(value)) return { value, runId: completion.runId };
      failures.push(`${agent} output does not match the current artifact identity`);
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  throw new Error(failures[0] ?? `no completed async ${agent} output found; wait for the current run first`);
}

async function findAsyncResult<T>(ctx: ExtensionContext, root: string, agent: string, outputPath: string, parse: (output: string) => T, matches: (value: T) => boolean): Promise<{ value: T; runId: string }> {
  const completions: WaitCompletion[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_wait") completions.push(...((entry.message.details as { completions?: WaitCompletion[] } | undefined)?.completions ?? []));
  }
  return readAsyncResult(completions, root, agent, outputPath, parse, matches);
}

function getTargetPath(input: Record<string, unknown>): string | undefined {
  const target = input.path ?? input.filePath ?? input.file_path;
  return typeof target === "string" ? normalizePath(target) : undefined;
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
  return plan.tasks.filter((task) => ids.includes(task.id)).map((task) => `${task.id}. ${task.title}\nOutcome: ${task.outcome}\nRequirements: ${task.satisfies.join(", ")}\nExpected paths: ${task.expectedPaths.join(", ")}\nAcceptance: ${task.acceptance.join("; ")}\nWorker checks: ${task.workerChecks.map((check) => check.id).join(", ")}\nWave checks: ${task.waveChecks.map((check) => check.id).join(", ") || "none"}`).join("\n\n");
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

  async function persistExecution(root: string, plan: PlanDocument, state: WorkState): Promise<void> {
    await withWorkLock(root, async () => { await writeRuntime(root, plan, state); });
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
    const runtime = await loadExecution(root).catch(() => undefined);
    const brief = session.briefSlug ? await readBrief(root, session.briefSlug).catch(() => undefined) : undefined;
    const plan = runtime?.plan ?? (session.planSlug ? await readPlan(root, session.planSlug).catch(() => undefined) : undefined);
    const state = runtime?.state;
    const decisions = plan ? pendingDecisions(plan) : [];
    let nextAction = "none";
    if (session.mode === "planning") {
      if (!brief) nextAction = "planning_brief_save";
      else if (brief.metis.readiness !== "ready") nextAction = "launch metis and wait; metis_import is recovery-only";
      else if (!plan || plan.briefHash !== brief.briefHash) nextAction = "plan_save";
      else if (plan.momus.verdict !== "approved") nextAction = "launch momus and wait; momus_import is recovery-only";
      else nextAction = `/start-work ${plan.slug}`;
    } else if (state?.status === "active" && state.stage === "dispatch") nextAction = state.workerRunId ? "wait for worker; work_import is recovery-only" : "launch the current lease worker";
    else if (state?.status === "active" && state.stage === "verify") nextAction = "work_verify";
    else if (state?.status === "paused" && decisions.length > 0) nextAction = `work_decide ${decisions[0].id}`;
    else if (state && ["paused", "stopped"].includes(state.status)) nextAction = `/start-work ${state.planSlug}`;
    else if (!state && plan?.momus.verdict === "approved") nextAction = `/start-work ${plan.slug}`;
    return {
      mode: session.mode,
      brief: brief ? { slug: brief.slug, hash: brief.briefHash, readiness: brief.metis.readiness } : undefined,
      plan: plan ? { slug: plan.slug, hash: plan.specHash, verdict: plan.momus.verdict, progress: getProgress(plan) } : undefined,
      execution: state ? { status: state.status, stage: state.stage, leaseId: state.lease?.id, taskIds: state.lease?.taskIds ?? [], workerRunId: state.workerRunId, failure: state.lastFailure?.split("\n")[0] } : undefined,
      pendingDecisions: decisions,
      nextAction,
    };
  }

  async function importMetisValue(root: string, value: MetisOutput) {
    if (!session.briefSlug) throw new Error("save a Planning Brief first");
    const brief = await readBrief(root, session.briefSlug);
    const reviewed = applyMetisReview(brief, value);
    await withWorkLock(root, async () => { await writeBrief(root, reviewed); });
    session.lastDirective = undefined;
    persistSession();
    return textResult(value.readiness === "ready" ? "Metis: READY. Generate the canonical plan." : `Metis: BLOCKED (${value.blockingGaps.length} gaps). Resolve them, revise the Brief, and run Metis again.`, value);
  }

  async function importMomusValue(root: string, value: MomusOutput) {
    if (!session.planSlug || !session.briefSlug) throw new Error("save a plan first");
    const plan = await readPlan(root, session.planSlug);
    const reviewed = applyMomusReview(plan, value);
    await withWorkLock(root, async () => { await writePlan(root, reviewed); });
    if (value.verdict === "approved") { restoreTools(); session.mode = "idle"; }
    session.lastDirective = undefined;
    persistSession();
    if (lastContext) await updateUI(lastContext);
    return textResult(value.verdict === "approved" ? `Momus approved ${plan.slug}. Run /start-work ${plan.slug}.` : `Momus rejected ${plan.slug}. Revise the plan and review the new hash.`, value);
  }

  async function importWorkerValue(root: string, value: WorkerOutput, runId: string) {
    const runtime = await loadExecution(root);
    if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch") throw new Error("execution is not waiting for worker output");
    const { plan, state } = runtime;
    const lease = runtime.state.lease;
    const needsDecision = value.semanticDelta.userDecisionNeeded.length > 0;
    if (value.status === "blocked" || needsDecision) {
      const blocker = value.blocker?.trim() || value.semanticDelta.userDecisionNeeded.join("; ") || "Worker reported a blocker";
      const withDelta = recordSemanticDelta(plan, lease.id, value.semanticDelta);
      const paused = { ...state, workerRunId: runId, status: "paused" as const, stage: "dispatch" as const, lastFailure: blocker, stopReason: blocker, updatedAt: new Date().toISOString() };
      await persistExecution(root, withDelta, paused);
      restoreTools();
      session.mode = "idle";
      session.lastDirective = undefined;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(`Paused: ${blocker}. Record a pending decision ID with work_decide when applicable, then run /start-work.`, { leaseId: lease.id, blocker, semanticDelta: value.semanticDelta, pendingDecisions: pendingDecisions(withDelta) });
    }
    const current = await snapshot(root);
    const actualChangedPaths = changedSince(lease.baseline, current);
    const imported = importWorkerOutput(plan, lease, value, actualChangedPaths);
    const verifying = { ...state, workerRunId: runId, status: "active" as const, stage: "verify" as const, lastFailure: undefined, stopReason: undefined, updatedAt: new Date().toISOString() };
    await persistExecution(root, imported, verifying);
    session.lastDirective = undefined;
    persistSession();
    if (lastContext) await updateUI(lastContext);
    const delta = imported.semanticDeltas.at(-1)!;
    return textResult(`Worker slice imported. Semantic outcome: ${delta.accomplished.join("; ") || "implemented as planned"}. Run work_verify.`, { leaseId: lease.id, actualChangedPaths, semanticDelta: delta });
  }

  async function snapshot(root: string): Promise<Record<string, string>> {
    const tracked = await pi.exec("git", ["diff", "--name-only", "HEAD", "--"], { cwd: root });
    const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root });
    if (tracked.code !== 0 || untracked.code !== 0) throw new Error("execution requires a Git worktree with HEAD");
    const files = [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").map(normalizePath).filter((item) => item && !item.startsWith(`${MANAGED_DIR}/`)))].sort();
    const result: Record<string, string> = {};
    for (const file of files) {
      const content = await fs.readFile(path.join(root, file)).catch(() => Buffer.from("[deleted]"));
      result[file] = createHash("sha256").update(content).digest("hex");
    }
    return result;
  }

  function changedSince(baseline: Record<string, string>, current: Record<string, string>): string[] {
    return [...new Set([...Object.keys(baseline), ...Object.keys(current)])].filter((file) => baseline[file] !== current[file]).sort();
  }

  async function resolvePlan(root: string, requested: string | undefined, ctx: ExtensionContext): Promise<PlanDocument | undefined> {
    const plans = (await listPlans(root)).filter((plan) => getProgress(plan).remaining > 0);
    if (requested) return plans.find((plan) => plan.slug === slugify(requested)) ?? readPlan(root, requested);
    if (plans.length <= 1) return plans[0];
    if (!ctx.hasUI) throw new Error(`multiple plans found: ${plans.map((plan) => plan.slug).join(", ")}`);
    const selected = await ctx.ui.select("Select a plan", plans.map((plan) => `${plan.slug} — ${plan.title}`));
    return selected ? plans.find((plan) => selected.startsWith(`${plan.slug} —`)) : undefined;
  }

  async function hashArtifact(root: string, artifact: string): Promise<string> {
    return createHash("sha256").update(await fs.readFile(path.join(root, artifact))).digest("hex");
  }

  async function runChecks(root: string, leaseId: string, checks: CheckSpec[], scope: CheckReceipt["scope"]): Promise<{ receipts: CheckReceipt[]; failure?: string }> {
    const receipts: CheckReceipt[] = [];
    for (const check of checks) {
      const started = Date.now();
      const result = await pi.exec(check.program, check.args, { cwd: path.join(root, check.cwd ?? "."), timeout: 10 * 60 * 1000 });
      const relativeDir = path.join(MANAGED_DIR, "evidence", leaseId);
      const absoluteDir = path.join(root, relativeDir);
      await fs.mkdir(absoluteDir, { recursive: true });
      const stdoutPath = path.join(relativeDir, `${check.id}.stdout.log`).replaceAll("\\", "/");
      const stderrPath = path.join(relativeDir, `${check.id}.stderr.log`).replaceAll("\\", "/");
      await fs.writeFile(path.join(root, stdoutPath), result.stdout);
      await fs.writeFile(path.join(root, stderrPath), result.stderr);
      let exitCode = result.code;
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
    name: "workflow_status", label: "Workflow status", description: "Return the current durable stage, identities, pending decisions, and exact next action.", parameters: ImportParams,
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
        if (args.some((arg) => ["--write-lock-file", "--commit-lock-file", "--update-input"].includes(arg))) throw new Error("plan_inspect rejects lock-file mutation");
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
    name: "planning_brief_save", label: "Save Planning Brief", description: "Save the structured pre-plan context. Any change invalidates the previous Metis assessment.", parameters: BriefSaveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root) throw new Error("planning_brief_save is available only during /plan");
      const previous = session.briefSlug ? await readBrief(session.root, session.briefSlug).catch(() => undefined) : undefined;
      const brief = createPlanningBrief(params, previous);
      const paths = await withWorkLock(session.root, async () => writeBrief(session.root!, brief));
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
    name: "metis_import", label: "Import Metis assessment", description: "Import the latest structured Metis result for the current Planning Brief.", parameters: ImportParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.briefSlug) throw new Error("save a Planning Brief first");
      const brief = await readBrief(session.root, session.briefSlug);
      const briefPath = `${MANAGED_DIR}/briefs/${brief.slug}.json`;
      const outputPath = providerOutputPath("metis", brief.briefHash);
      const { value } = await findAsyncResult<MetisOutput>(ctx, session.root, "metis", outputPath, parseMetisOutput, (review) => review.briefPath === briefPath && review.briefHash === brief.briefHash);
      return importMetisValue(session.root, value);
    },
  });

  pi.registerTool({
    name: "plan_save", label: "Save canonical plan", description: "Create or revise the canonical plan after Metis marks the current Planning Brief ready.", parameters: PlanSaveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.briefSlug) throw new Error("save and assess a Planning Brief first");
      const brief = await readBrief(session.root, session.briefSlug);
      const previous = session.planSlug ? await readPlan(session.root, session.planSlug).catch(() => undefined) : undefined;
      const plan = createPlan(params, brief, previous);
      const paths = await withWorkLock(session.root, async () => {
        const result = await writePlan(session.root!, plan);
        await fs.rm(workPaths(session.root!).runtimePath, { force: true });
        await writeWorkState(session.root!, { version: 2, planSlug: plan.slug, planHash: plan.specHash, status: "planned", stage: "dispatch", receipts: [], updatedAt: new Date().toISOString() });
        return result;
      });
      session.planSlug = plan.slug;
      session.lastDirective = undefined;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(`Saved ${path.relative(ctx.cwd, paths.markdownPath)}. Momus must review plan hash ${plan.specHash} against Brief ${brief.briefHash}.`, concisePlan(plan));
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
    name: "momus_import", label: "Import Momus review", description: "Import the latest semantic Momus review bound to the current plan hash.", parameters: ImportParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.planSlug || !session.briefSlug) throw new Error("save a plan first");
      const plan = await readPlan(session.root, session.planSlug);
      const brief = await readBrief(session.root, session.briefSlug);
      if (plan.briefSlug !== brief.slug || plan.briefHash !== brief.briefHash) throw new Error("plan is stale relative to the current Planning Brief");
      const planPath = `${MANAGED_DIR}/plans/${plan.slug}.md`;
      const outputPath = providerOutputPath("momus", plan.specHash);
      const { value } = await findAsyncResult<MomusOutput>(ctx, session.root, "momus", outputPath, parseMomusOutput, (review) => review.planPath === planPath && review.planHash === plan.specHash);
      return importMomusValue(session.root, value);
    },
  });

  pi.registerTool({
    name: "work_import", label: "Import worker slice", description: "Import the latest structured worker output, verify its lease identity and actual changed paths, and stage deterministic checks.", parameters: ImportParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (session.mode !== "executing" || !session.root || !session.planSlug) throw new Error("no active execution");
      const runtime = await loadExecution(session.root);
      if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch") throw new Error("execution is not waiting for worker output");
      const plan = runtime.plan;
      const lease = runtime.state.lease;
      const outputPath = providerOutputPath("worker", lease.id);
      const { value, runId } = await findAsyncResult<WorkerOutput>(ctx, session.root, "worker", outputPath, parseWorkerOutput, (output) => output.leaseId === lease.id && output.planHash === plan.specHash && JSON.stringify(output.taskIds) === JSON.stringify(lease.taskIds));
      return importWorkerValue(session.root, value, runId);
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
      const state = { ...runtime.state, stage: "dispatch" as const, lastFailure: undefined, stopReason: "Decision recorded; explicit /start-work required", updatedAt: new Date().toISOString() };
      await persistExecution(root, plan, state);
      if (lastContext) await updateUI(lastContext);
      return textResult(`Decision recorded for lease ${leaseId}. Run /start-work ${plan.slug} to continue.`, { decision: params.decision, strategicVersion: `${plan.specHash}:${plan.semanticDeltas.length}` });
    },
  });

  pi.registerTool({
    name: "work_verify", label: "Verify worker and wave", description: "Run worker, wave, and when applicable final checks. Only verified work unlocks dependencies.", parameters: ImportParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (session.mode !== "executing" || !session.root || !session.planSlug) throw new Error("no active execution");
      const runtime = await loadExecution(session.root);
      if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "verify") throw new Error("execution has no imported slice to verify");
      const state = runtime.state;
      const lease = runtime.state.lease;
      let plan = runtime.plan;
      const tasks = plan.tasks.filter((task) => lease.taskIds.includes(task.id));
      const workerChecks = tasks.flatMap((task) => task.workerChecks);
      const waveChecks = tasks.flatMap((task) => task.waveChecks);
      const workerResult = await runChecks(session.root, lease.id, workerChecks, "worker");
      let receipts = workerResult.receipts;
      let failure = workerResult.failure;
      if (!failure) {
        const waveResult = await runChecks(session.root, lease.id, waveChecks, "wave");
        receipts = [...receipts, ...waveResult.receipts];
        failure = waveResult.failure;
      }
      const isFinalSlice = plan.tasks.every((task) => lease.taskIds.includes(task.id) || task.status === "completed");
      if (!failure && isFinalSlice) {
        const finalResult = await runChecks(session.root, lease.id, plan.finalChecks, "final");
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
        const updated: WorkState = { ...state, stage: "dispatch", receipts: [...state.receipts, ...receipts], lastFailure: failure, lease: { ...lease, attempt: lease.attempt + 1 }, updatedAt: new Date().toISOString() };
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
        workerRunId: undefined,
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
      const state = await readWorkState(ctx.cwd).catch(() => undefined);
      if (state?.status === "active") { ctx.ui.notify(`Work ${state.planSlug} is active. Stop it first.`, "warning"); return; }
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
      const checkpoint = await readRuntime(ctx.cwd).catch(() => undefined);
      if (checkpoint) await withWorkLock(ctx.cwd, async () => { await writePlan(ctx.cwd, checkpoint.plan); await writeWorkState(ctx.cwd, checkpoint.state); });
      let plan: PlanDocument | undefined;
      try { plan = await resolvePlan(ctx.cwd, args.trim() || undefined, ctx); }
      catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
      if (!plan) { ctx.ui.notify("No incomplete plan found.", "warning"); return; }
      if (plan.momus.verdict !== "approved" || plan.momus.planHash !== plan.specHash) { ctx.ui.notify("Current plan hash is not approved by Momus.", "error"); return; }
      const brief = await readBrief(ctx.cwd, plan.briefSlug).catch(() => undefined);
      if (!brief || brief.briefHash !== plan.briefHash) { ctx.ui.notify("Plan is stale relative to its Planning Brief.", "error"); return; }
      const previous = checkpoint?.state ?? await readWorkState(ctx.cwd);
      if (previous?.status === "active") { ctx.ui.notify(`Work ${previous.planSlug} is already active.`, "error"); return; }
      if (ctx.hasUI && !(await ctx.ui.confirm("Start work?", `${plan.title}\n${getProgress(plan).remaining} tasks remain`))) return;
      restoreTools();
      session = { mode: "executing", root: ctx.cwd, planSlug: plan.slug, executionTools: pi.getActiveTools() };
      enterExecution();
      const resumable = Boolean(previous?.planSlug === plan.slug && previous.planHash === plan.specHash && previous.lease && ["paused", "stopped"].includes(previous.status));
      const lease = resumable ? previous!.lease! : createLease(plan, await snapshot(ctx.cwd));
      const now = new Date().toISOString();
      await persistExecution(ctx.cwd, plan, { ...(resumable ? previous : {}), version: 2, planSlug: plan.slug, planHash: plan.specHash, status: "active", stage: resumable ? previous!.stage : "dispatch", lease, receipts: resumable ? previous!.receipts : [], startedAt: previous?.startedAt ?? now, updatedAt: now, stopReason: undefined });
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
    description: "Pause durable execution and abort the active main turn",
    handler: async (args, ctx) => {
      const root = session.root ?? ctx.cwd;
      const runtime = await loadExecution(root);
      if (!runtime) { ctx.ui.notify("No work state found.", "info"); return; }
      const now = new Date().toISOString();
      const stopped = { ...runtime.state, status: "stopped" as const, stopReason: args.trim() || "Stopped by user", updatedAt: now };
      await persistExecution(root, runtime.plan, stopped);
      const workerRunId = stopped.workerRunId;
      restoreTools();
      session.mode = "idle";
      if (!ctx.isIdle()) ctx.abort();
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Stopped ${stopped.planSlug}${workerRunId ? `; cancelling worker ${workerRunId}` : ""}.`, "warning");
      if (workerRunId) pi.sendUserMessage(`[CANCEL WORKER]\nCall subagent with action \"stop\" and id \"${workerRunId}\". Do not continue the plan.`, { deliverAs: "followUp" });
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
      const next = !brief
        ? "Research the repository, ask only material unresolved questions, then call planning_brief_save."
        : brief.metis.readiness !== "ready"
          ? `Run one fresh Metis with async:true and context:fresh against ${MANAGED_DIR}/briefs/${brief.slug}.json and hash ${brief.briefHash}. The harness injects its schema and file-only output and imports it after subagent_wait. Use metis_import only to recover a missed import. If blocked, resolve every gap and revise the Brief.`
          : !plan
            ? "Metis is READY. Generate the canonical plan with worker, wave, and final checks using plan_save."
            : plan.momus.verdict !== "approved"
              ? `Run one fresh Momus with async:true and context:fresh against ${MANAGED_DIR}/briefs/${brief.slug}.json and ${MANAGED_DIR}/plans/${plan.slug}.md at plan hash ${plan.specHash}. The harness injects its schema and file-only output and imports it after subagent_wait. Use momus_import only to recover a missed import. Revise and re-review if rejected.`
              : `Planning is approved. Summarize it for the user, then offer /start-work ${plan.slug}.`;
      return { message: { customType: "plan-execute-planning-v2", display: false, content: `Planning is read-only. Keep goal, decisions, repository evidence, and risks; do not preserve operational tool chatter. Call workflow_status whenever the next step is unclear. ${next}` } };
    }
    if (session.mode === "executing" && session.root && session.planSlug) {
      const runtime = await loadExecution(session.root);
      if (!runtime?.state.lease || runtime.state.status !== "active") return;
      const { plan, state } = runtime;
      const lease = runtime.state.lease;
      const strategicVersion = `${plan.specHash}:${plan.semanticDeltas.length}`;
      let strategic = "";
      if (session.lastStrategicVersion === undefined) strategic = `Strategic context:\n${renderStrategicContext(plan)}\n\n`;
      else if (session.lastStrategicVersion !== strategicVersion && plan.semanticDeltas.length > 0) strategic = `Semantic context delta:\n${renderSemanticDelta(plan.semanticDeltas.at(-1)!)}\n\n`;
      session.lastStrategicVersion = strategicVersion;
      const key = `${lease.id}:${state.stage}:${lease.attempt}`;
      if (session.lastDirective === key && !strategic) return;
      session.lastDirective = key;
      persistSession();
      const failure = state.lastFailure ? `\nPrevious verification failure:\n${state.lastFailure}\n` : "";
      const directive = state.stage === "dispatch"
        ? `${failure}Launch exactly one fresh worker for lease ${lease.id}, plan hash ${plan.specHash}, and task IDs ${lease.taskIds.join(", ")}. Use async:true, context:fresh, and worktree:false; the harness injects its schema and file-only output and imports it after subagent_wait. Use work_import only to recover a missed import. The worker may edit only the expected paths and must return operational identity plus a semantic delta. Do not ask it to manage workflow state.\n\n${renderTasks(plan, lease.taskIds)}`
        : "The worker output is imported. Call work_verify; the extension, not the model, runs worker, wave, and final checks.";
      return { message: { customType: "plan-execute-lease-v2", display: false, content: `${strategic}${directive}` } };
    }
  });

  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown>;
    if (session.mode === "planning") {
      if (MUTATION_TOOLS.has(event.toolName) || (/(write|edit|patch|fix|apply)/i.test(event.toolName) && !["planning_brief_save", "metis_import", "plan_save", "momus_import"].includes(event.toolName))) {
        return { block: true, reason: `${event.toolName} is disabled during planning` };
      }
      if (event.toolName === "subagent") {
        const agent = typeof input.agent === "string" ? input.agent : undefined;
        if (!agent || !["metis", "momus", "scout", "researcher", "oracle"].includes(agent) || input.workflowScript) return { block: true, reason: "Planning delegates only Metis, Momus, scout, researcher, or oracle" };
        const task = String(input.task ?? "");
        if (["scout", "researcher", "oracle"].includes(agent)) {
          Object.assign(input, { async: true, context: agent === "oracle" ? "fork" : "fresh", worktree: true });
        } else if (agent === "metis") {
          if (!session.root || !session.briefSlug) return { block: true, reason: "save a Planning Brief first" };
          const brief = await readBrief(session.root, session.briefSlug);
          if (!task.includes(`${MANAGED_DIR}/briefs/${brief.slug}.json`) || !task.includes(brief.briefHash)) return { block: true, reason: "Metis task must include the exact Brief path and hash" };
          Object.assign(input, { async: true, context: "fresh", worktree: false, outputSchema: METIS_SCHEMA, output: providerOutputPath("metis", brief.briefHash), outputMode: "file-only" });
        } else {
          if (!session.root || !session.briefSlug || !session.planSlug) return { block: true, reason: "save a plan first" };
          const brief = await readBrief(session.root, session.briefSlug);
          const plan = await readPlan(session.root, session.planSlug);
          if (plan.briefHash !== brief.briefHash || !task.includes(`${MANAGED_DIR}/plans/${plan.slug}.md`) || !task.includes(`${MANAGED_DIR}/briefs/${brief.slug}.json`) || !task.includes(plan.specHash)) return { block: true, reason: "Momus task must include the current Brief, exact plan path, and plan hash" };
          Object.assign(input, { async: true, context: "fresh", worktree: false, outputSchema: MOMUS_SCHEMA, output: providerOutputPath("momus", plan.specHash), outputMode: "file-only" });
        }
      }
    }
    if (session.mode === "executing") {
      if (MUTATION_TOOLS.has(event.toolName) || /(write|edit|patch|fix|apply)/i.test(event.toolName)) return { block: true, reason: "The main agent retains strategy but does not perform worker or verification operations" };
      if (event.toolName === "subagent") {
        if (input.action) return { block: true, reason: "Execution may only launch the current lease worker" };
        if (input.agent !== "worker" || input.workflowScript) return { block: true, reason: "Execution launches one worker for the current lease" };
        if (!session.root || !session.planSlug) return { block: true, reason: "no active lease" };
        const runtime = await loadExecution(session.root);
        const task = String(input.task ?? "");
        if (!runtime?.state.lease || !task.includes(runtime.state.lease.id) || !task.includes(runtime.state.planHash)) return { block: true, reason: "worker task must include the current lease and plan hash" };
        Object.assign(input, { async: true, context: "fresh", worktree: false, outputSchema: WORKER_SCHEMA, output: providerOutputPath("worker", runtime.state.lease.id), outputMode: "file-only" });
      }
    }
    if (/(write|edit|patch|fix|apply)/i.test(event.toolName)) {
      const target = getTargetPath(input);
      if (target && (target === MANAGED_DIR || target.startsWith(`${MANAGED_DIR}/`))) return { block: true, reason: `${MANAGED_DIR} is extension-managed` };
    }
    if (event.toolName === "bash" && String(input.command ?? "").replaceAll("\\", "/").includes(MANAGED_DIR)) return { block: true, reason: `${MANAGED_DIR} is extension-managed` };
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "subagent" && event.input.agent === "worker" && session.root && session.mode === "executing") {
      const runId = (event.details as { runId?: string } | undefined)?.runId;
      if (!runId) return;
      const runtime = await loadExecution(session.root);
      if (!runtime?.state.lease || runtime.state.status !== "active") return;
      await persistExecution(session.root, runtime.plan, { ...runtime.state, workerRunId: runId, updatedAt: new Date().toISOString() });
      return;
    }
    if (event.toolName !== "subagent_wait" || !session.root) return;
    const completions = (event.details as { completions?: WaitCompletion[] } | undefined)?.completions ?? [];
    const hasAgent = (agent: string) => completions.some((completion) => completion.agent === agent || completion.results?.some((child) => child.agent === agent));
    try {
      if (session.mode === "planning" && session.briefSlug && hasAgent("metis")) {
        const brief = await readBrief(session.root, session.briefSlug);
        const briefPath = `${MANAGED_DIR}/briefs/${brief.slug}.json`;
        const { value } = await readAsyncResult(completions, session.root, "metis", providerOutputPath("metis", brief.briefHash), parseMetisOutput, (review) => review.briefPath === briefPath && review.briefHash === brief.briefHash);
        await importMetisValue(session.root, value);
        lastContext?.ui.notify("Metis result imported automatically.", "info");
      } else if (session.mode === "planning" && session.briefSlug && session.planSlug && hasAgent("momus")) {
        const brief = await readBrief(session.root, session.briefSlug);
        const plan = await readPlan(session.root, session.planSlug);
        if (plan.briefHash !== brief.briefHash) throw new Error("plan is stale relative to the current Planning Brief");
        const planPath = `${MANAGED_DIR}/plans/${plan.slug}.md`;
        const { value } = await readAsyncResult(completions, session.root, "momus", providerOutputPath("momus", plan.specHash), parseMomusOutput, (review) => review.planPath === planPath && review.planHash === plan.specHash);
        await importMomusValue(session.root, value);
        lastContext?.ui.notify("Momus result imported automatically.", "info");
      } else if (session.mode === "executing" && hasAgent("worker")) {
        const runtime = await loadExecution(session.root);
        if (!runtime?.state.lease || runtime.state.status !== "active" || runtime.state.stage !== "dispatch") return;
        const lease = runtime.state.lease;
        const { value, runId } = await readAsyncResult(completions, session.root, "worker", providerOutputPath("worker", lease.id), parseWorkerOutput, (output) => output.leaseId === lease.id && output.planHash === runtime.plan.specHash && JSON.stringify(output.taskIds) === JSON.stringify(lease.taskIds));
        await importWorkerValue(session.root, value, runId);
        lastContext?.ui.notify("Worker result imported automatically.", "info");
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
      const runtime = await loadExecution(root).catch(() => undefined);
      restoreTools();
      session.mode = "idle";
      session.lastStrategicVersion = undefined;
      session.lastDirective = undefined;
      if (runtime?.state.status === "active") await persistExecution(root, runtime.plan, { ...runtime.state, status: "paused", stopReason: "Session resumed; explicit /start-work required", updatedAt: new Date().toISOString() });
      persistSession();
    }
    await updateUI(ctx);
  });
}
