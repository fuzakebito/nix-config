import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendLedger,
  completeTask,
  createPlan,
  getNextTask,
  getProgress,
  getReadyWave,
  listPlans,
  parsePlanReviewOutput,
  readPlan,
  readWorkState,
  reviewPlan,
  slugify,
  writePlan,
  writeWorkState,
  withWorkLock,
  type CompletionEvidence,
  type PlanDocument,
  type PlanReviewOutput,
  type WorkState,
} from "./core.ts";

const PLANNING_DISABLED_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "multiedit",
  "lsp_fix",
  "ctx_execute",
  "ctx_batch_execute",
  "ctx_upgrade",
  "ctx_purge",
]);
const PLANNING_SUBAGENTS = new Set(["plan-analyst", "plan-reviewer"]);
const SAFE_BASH = /^\s*(pwd|ls|find|fd|rg|grep|git\s+(status|log|diff|show|branch|ls-files)|nix\s+(flake\s+(show|metadata)|eval)|printf|echo|which|type)\b/;
const SHELL_MUTATION = /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|clean)|nix\s+flake\s+(update|lock))\b|(^|[^<])>{1,2}|\$\(|`/i;
const WORKFLOW_CUSTOM_TYPE = "plan-execute-state";

interface SessionWorkflowState {
  mode: "idle" | "planning" | "executing";
  root?: string;
  planSlug?: string;
  toolsBeforePlanning?: string[];
  toolsBeforeExecution?: string[];
}

const TaskInput = Type.Object({
  title: Type.String(),
  details: Type.String(),
  references: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Array(Type.String(), { minItems: 1 }),
  verification: Type.Array(Type.String(), { minItems: 1 }),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  wave: Type.Integer({ minimum: 1, description: "Parallel execution wave; tasks in one wave must be independent" }),
  ownedPaths: Type.Array(Type.String(), { minItems: 1, description: "Disjoint project-relative files or directories owned by this task" }),
});

const PlanSaveParams = Type.Object({
  title: Type.String({ description: "Human-readable plan title" }),
  goal: Type.String({ description: "Decision-complete outcome" }),
  constraints: Type.Optional(Type.Array(Type.String())),
  outOfScope: Type.Optional(Type.Array(Type.String())),
  analysis: Type.String({ description: "Concise result from the plan-analyst gap analysis" }),
  tasks: Type.Array(TaskInput, { minItems: 1 }),
});

const PlanReviewParams = Type.Object({});
const PLAN_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["planPath", "reviewToken", "verdict", "findings"],
  properties: {
    planPath: { type: "string" },
    reviewToken: { type: "string" },
    verdict: { type: "string", enum: ["approved", "rejected"] },
    findings: { type: "array", items: { type: "string" } },
  },
} as const;

const PlanLoadParams = Type.Object({
  slug: Type.Optional(Type.String({ description: "Defaults to the active plan" })),
});

const PlanTaskPatch = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  details: Type.Optional(Type.String()),
  references: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  verification: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  wave: Type.Optional(Type.Integer({ minimum: 1 })),
  ownedPaths: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
});

const PlanUpdateParams = Type.Object({
  tasks: Type.Array(PlanTaskPatch, { minItems: 1 }),
});

const WorkCompleteParams = Type.Object({
  taskId: Type.String(),
  waveToken: Type.String(),
  summary: Type.String(),
  commands: Type.Array(Type.String(), { minItems: 1 }),
  artifact: Type.String({ description: "Path or concise identifier for concrete QA/review evidence" }),
  adversarialChecks: Type.Array(Type.String(), { minItems: 1 }),
  cleanup: Type.Array(Type.String(), { minItems: 1, description: "Cleanup receipts; use 'none required' when applicable" }),
});

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function getPathFromToolInput(input: Record<string, unknown>): string | undefined {
  const value = input.path ?? input.filePath ?? input.file_path;
  return typeof value === "string" ? value : undefined;
}

function normalizeProjectPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function pathIsOwned(filePath: string, ownedPaths: string[]): boolean {
  const normalized = normalizeProjectPath(filePath);
  return ownedPaths.some((ownedPath) => normalized === ownedPath || normalized.startsWith(`${ownedPath}/`));
}

function renderTask(task: PlanDocument["tasks"][number]): string {
  const ownership = task.ownedPaths.length > 0 ? `\nOwned paths: ${task.ownedPaths.join(", ")}` : "";
  return `${task.id}. ${task.title} (wave ${task.wave})\nWhat: ${task.details}${ownership}\nAcceptance: ${task.acceptance.join("; ")}\nVerify: ${task.verification.join("; ")}`;
}

function getAssistantOutput(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((message): message is { role: string; content?: unknown } => Boolean(message && typeof message === "object" && "role" in message))
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

interface SubagentResultEvidence {
  agent?: string;
  task?: string;
  exitCode?: number;
  messages?: unknown;
  finalOutput?: string;
  structuredOutput?: unknown;
  progress?: { status?: string };
}

function findReviewerEvidence(ctx: ExtensionContext, planPath: string, token: string): PlanReviewOutput {
  const failures: string[] = [];
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || !["subagent", "subagent_wait"].includes(entry.message.toolName)) continue;
    const details = entry.message.details as { results?: SubagentResultEvidence[] } | undefined;
    for (const result of [...(details?.results ?? [])].reverse()) {
      if (result.agent !== "plan-reviewer") continue;
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        failures.push(`plan-reviewer exited with code ${result.exitCode}`);
        continue;
      }
      if (!result.task?.includes(planPath)) {
        failures.push(`review task is missing exact plan path ${planPath}`);
        continue;
      }
      if (!result.task.includes(token)) {
        failures.push(`review task has a stale or missing token; expected ${token}`);
        continue;
      }
      let review: PlanReviewOutput;
      try {
        review = parsePlanReviewOutput(result.structuredOutput === undefined
          ? result.finalOutput ?? getAssistantOutput(result.messages)
          : JSON.stringify(result.structuredOutput));
      } catch (error) {
        failures.push((error as Error).message);
        continue;
      }
      if (review.planPath !== planPath) failures.push(`reviewer returned planPath ${review.planPath}; expected ${planPath}`);
      else if (review.reviewToken !== token) failures.push(`reviewer returned stale token ${review.reviewToken}; expected ${token}`);
      else return review;
    }
  }
  throw new Error(failures[0] ?? "no plan-reviewer result found; run plan-reviewer for the current saved plan");
}

function hasActiveWaveLaunch(ctx: ExtensionContext, token: string): boolean {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || !["subagent", "subagent_wait"].includes(entry.message.toolName)) continue;
    const details = entry.message.details as { results?: SubagentResultEvidence[] } | undefined;
    const matching = (details?.results ?? []).filter((result) => result.task?.includes(token));
    if (matching.length === 0) continue;
    return matching.some((result) => ["pending", "running"].includes(result.progress?.status ?? ""));
  }
  return false;
}

function hasWaveEvidence(ctx: ExtensionContext, slug: string, token: string, tasks: PlanDocument["tasks"]): boolean {
  const planPath = `.pi/work/plans/${slug}.md`;
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || !["subagent", "subagent_wait"].includes(entry.message.toolName)) continue;
    const details = entry.message.details as { results?: SubagentResultEvidence[] } | undefined;
    const results = details?.results ?? [];
    const completeWave = tasks.every((task) => {
      const expectedAgent = task.kind === "implementation" ? "worker" : "verification-reviewer";
      return results.some((result) => {
        if (result.agent !== expectedAgent || result.exitCode !== 0) return false;
        if (!result.task?.includes(planPath) || !result.task.includes(token) || !result.task.includes(`Item: ${task.id}`)) return false;
        const output = (result.finalOutput ?? getAssistantOutput(result.messages)).trim();
        return task.kind === "verification" ? output.toUpperCase().includes("VERDICT: PASS") : Boolean(output);
      });
    });
    if (completeWave) return true;
  }
  return false;
}

export default function planExecuteExtension(pi: ExtensionAPI): void {
  let session: SessionWorkflowState = { mode: "idle" };
  let lastContext: ExtensionContext | undefined;
  let completedAtAgentStart = 0;
  let continuationScheduled = false;

  function persistSession(): void {
    pi.appendEntry(WORKFLOW_CUSTOM_TYPE, session);
  }

  function restorePlanningTools(): void {
    if (session.toolsBeforePlanning) pi.setActiveTools(session.toolsBeforePlanning);
    session.toolsBeforePlanning = undefined;
  }

  function restoreExecutionTools(): void {
    if (session.toolsBeforeExecution) pi.setActiveTools(session.toolsBeforeExecution);
    session.toolsBeforeExecution = undefined;
  }

  function enterPlanningTools(): void {
    const tools = session.toolsBeforePlanning ?? pi.getActiveTools();
    session.toolsBeforePlanning = tools;
    pi.setActiveTools(tools.filter((name) => !PLANNING_DISABLED_TOOLS.has(name)));
  }

  function enterCoordinatorTools(): void {
    const tools = session.toolsBeforeExecution ?? pi.getActiveTools();
    session.toolsBeforeExecution = tools;
    pi.setActiveTools(tools.filter((name) => !["edit", "write", "apply_patch", "multiedit", "lsp_fix", "ctx_execute", "ctx_batch_execute"].includes(name)));
  }

  async function updateUI(ctx: ExtensionContext): Promise<void> {
    lastContext = ctx;
    if (ctx.mode !== "tui") return;
    const root = session.root ?? ctx.cwd;
    let plan: PlanDocument | undefined;
    let state: WorkState | undefined;
    try {
      state = await readWorkState(root);
      if (session.planSlug ?? state?.planSlug) plan = await readPlan(root, session.planSlug ?? state!.planSlug);
    } catch {
      // A malformed external state file is reported by commands/tools; keep startup usable.
    }

    if (!plan) {
      ctx.ui.setStatus("plan-execute", session.mode === "planning" ? ctx.ui.theme.fg("warning", "plan") : undefined);
      ctx.ui.setWidget("plan-execute", undefined);
      return;
    }

    const progress = getProgress(plan);
    const label = session.mode === "planning" ? "plan" : state?.status ?? "planned";
    ctx.ui.setStatus(
      "plan-execute",
      ctx.ui.theme.fg(label === "completed" ? "success" : "accent", `${label} ${progress.completed}/${progress.total}`),
    );
    const wave = getReadyWave(plan);
    const next = wave[0];
    ctx.ui.setWidget(
      "plan-execute",
      next ? [`Plan: ${plan.title}`, `Wave ${next.wave}: ${wave.map((task) => task.id).join(", ")} (${progress.remaining} remaining)`] : [`Plan: ${plan.title}`, "Complete"],
    );
  }

  async function getChangedSnapshot(root: string): Promise<Record<string, string>> {
    const tracked = await pi.exec("git", ["diff", "--name-only", "HEAD", "--"], { cwd: root });
    const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root });
    if (tracked.code !== 0 || untracked.code !== 0) throw new Error("parallel waves require a Git worktree with HEAD");
    const paths = [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").map(normalizeProjectPath).filter((filePath) => filePath && !filePath.startsWith(".pi/work/")))].sort();
    const snapshot: Record<string, string> = {};
    for (const filePath of paths) {
      const content = await fs.readFile(path.join(root, filePath)).catch(() => Buffer.from("[deleted]"));
      snapshot[filePath] = createHash("sha256").update(content).digest("hex");
    }
    return snapshot;
  }

  async function resolvePlan(root: string, requested: string | undefined, ctx: ExtensionContext): Promise<PlanDocument | undefined> {
    const plans = (await listPlans(root)).filter((plan) => getProgress(plan).remaining > 0);
    if (requested) return plans.find((plan) => plan.slug === slugify(requested)) ?? readPlan(root, requested);
    if (plans.length === 0) return undefined;
    if (plans.length === 1) return plans[0];
    if (!ctx.hasUI) throw new Error(`multiple plans found; specify one: ${plans.map((plan) => plan.slug).join(", ")}`);
    const selected = await ctx.ui.select("Select a plan", plans.map((plan) => `${plan.slug} — ${plan.title}`));
    return selected ? plans.find((plan) => selected.startsWith(`${plan.slug} —`)) : undefined;
  }

  pi.registerTool({
    name: "plan_load",
    label: "Load plan",
    description: "Read the current canonical plan, including its revision, review token, and tasks.",
    parameters: PlanLoadParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const slug = params.slug ? slugify(params.slug) : session.planSlug;
      if (!slug) throw new Error("no active plan; provide a slug");
      const plan = await readPlan(session.root ?? ctx.cwd, slug);
      return textResult(JSON.stringify(plan, null, 2), { slug: plan.slug, revision: plan.revision, reviewToken: plan.reviewToken });
    },
  });

  pi.registerTool({
    name: "plan_save",
    label: "Save plan",
    description: "Create or revise the canonical Plan -> Execute artifact. Available only during /plan.",
    parameters: PlanSaveParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root) throw new Error("plan_save is available only after /plan");
      const { plan, paths } = await withWorkLock(session.root, async () => {
        const existing = session.planSlug ? await readPlan(session.root!, session.planSlug).catch(() => undefined) : undefined;
        const plan = createPlan(params, existing);
        const paths = await writePlan(session.root!, plan);
        await writeWorkState(session.root!, {
          version: 1,
          planSlug: plan.slug,
          planPath: path.relative(session.root!, paths.markdownPath),
          projectRoot: session.root!,
          worktreePath: session.root!,
          status: "planned",
          currentTask: plan.tasks[0]?.id,
          waveBaseline: {},
          sessionIds: [],
          updatedAt: new Date().toISOString(),
        });
        return { plan, paths };
      });
      session.planSlug = plan.slug;
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(`Saved ${path.relative(ctx.cwd, paths.markdownPath)} as revision ${plan.revision}. Review token: ${plan.reviewToken}. Run plan-reviewer once for that exact path and token, then call plan_review with no verdict or findings.`, {
        slug: plan.slug,
        planPath: path.relative(session.root, paths.markdownPath),
        revision: plan.revision,
        reviewToken: plan.reviewToken,
        review: plan.review,
        progress: getProgress(plan),
      });
    },
  });

  pi.registerTool({
    name: "plan_update",
    label: "Update plan tasks",
    description: "Patch selected tasks in the active plan, then revalidate the whole plan and issue a new revision and review token.",
    parameters: PlanUpdateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.planSlug) throw new Error("plan_update is available only for an active /plan");
      const { plan, paths } = await withWorkLock(session.root, async () => {
        const current = await readPlan(session.root!, session.planSlug!);
        const patches = new Map(params.tasks.map((task) => [task.id, task]));
        if (patches.size !== params.tasks.length) throw new Error("plan_update contains duplicate task IDs");
        const implementation = current.tasks.filter((task) => task.kind === "implementation");
        for (const id of patches.keys()) if (!implementation.some((task) => task.id === id)) throw new Error(`unknown implementation task ${id}`);
        const tasks = implementation.map((task) => {
          const patch = patches.get(task.id);
          return {
            title: patch?.title ?? task.title,
            details: patch?.details ?? task.details,
            references: patch?.references ?? task.references,
            acceptance: patch?.acceptance ?? task.acceptance,
            verification: patch?.verification ?? task.verification,
            dependsOn: patch?.dependsOn ?? task.dependsOn,
            wave: patch?.wave ?? task.wave,
            ownedPaths: patch?.ownedPaths ?? task.ownedPaths,
          };
        });
        const plan = createPlan({
          title: current.title,
          goal: current.goal,
          constraints: current.constraints,
          outOfScope: current.outOfScope,
          analysis: current.analysis,
          tasks,
        }, current);
        const paths = await writePlan(session.root!, plan);
        await writeWorkState(session.root!, {
          version: 1,
          planSlug: plan.slug,
          planPath: path.relative(session.root!, paths.markdownPath),
          projectRoot: session.root!,
          worktreePath: session.root!,
          status: "planned",
          currentTask: plan.tasks[0]?.id,
          waveBaseline: {},
          sessionIds: [],
          updatedAt: new Date().toISOString(),
        });
        return { plan, paths };
      });
      if (lastContext) await updateUI(lastContext);
      return textResult(`Updated ${path.relative(ctx.cwd, paths.markdownPath)} to revision ${plan.revision}. New review token: ${plan.reviewToken}.`, {
        slug: plan.slug,
        planPath: path.relative(session.root, paths.markdownPath),
        revision: plan.revision,
        reviewToken: plan.reviewToken,
      });
    },
  });

  pi.registerTool({
    name: "plan_review",
    label: "Import plan review",
    description: "Import the latest matching plan-reviewer verdict directly; takes no manually copied verdict or findings.",
    parameters: PlanReviewParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (session.mode !== "planning" || !session.root || !session.planSlug) throw new Error("plan_review is available only after plan_save");
      const current = await readPlan(session.root, session.planSlug);
      const planPath = `.pi/work/plans/${current.slug}.md`;
      const evidence = findReviewerEvidence(ctx, planPath, current.reviewToken);
      const plan = await withWorkLock(session.root, async () => {
        const latest = await readPlan(session.root!, session.planSlug!);
        if (latest.reviewToken !== evidence.reviewToken) throw new Error(`review token became stale; expected ${latest.reviewToken}, got ${evidence.reviewToken}`);
        const reviewed = reviewPlan(latest, evidence.verdict, evidence.findings);
        await writePlan(session.root!, reviewed);
        return reviewed;
      });
      if (evidence.verdict === "approved") {
        restorePlanningTools();
        session.mode = "idle";
      }
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(
        evidence.verdict === "approved"
          ? `Plan ${plan.slug} revision ${plan.revision} approved. The user can run /start-work ${plan.slug}.`
          : `Plan ${plan.slug} revision ${plan.revision} rejected. Use plan_update for task fixes or plan_save for structural revisions, then review again.`,
        { slug: plan.slug, revision: plan.revision, review: plan.review },
      );
    },
  });

  pi.registerTool({
    name: "work_complete",
    label: "Complete work item",
    description: "Complete only the current plan item after implementation, verification, QA evidence, and cleanup.",
    parameters: WorkCompleteParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (session.mode !== "executing" || !session.root || !session.planSlug) throw new Error("no active Plan -> Execute run");
      const changedSnapshot = await getChangedSnapshot(session.root);
      const { plan, nextWave } = await withWorkLock(session.root, async () => {
        const state = await readWorkState(session.root!);
        if (!state || state.status !== "active") throw new Error(`work is ${state?.status ?? "not initialized"}`);
        if (!state.waveToken || params.waveToken !== state.waveToken) throw new Error("wave token is stale or invalid");
        const currentPlan = await readPlan(session.root!, session.planSlug!);
        const readyTasks = getReadyWave(currentPlan);
        if (!readyTasks.some((task) => task.id === params.taskId)) throw new Error(`task ${params.taskId} is not in the ready wave`);
        const fullWave = currentPlan.tasks.filter((task) => task.wave === state.currentWave);
        if (!hasWaveEvidence(ctx, currentPlan.slug, state.waveToken, fullWave)) {
          throw new Error("the full wave must complete in one parallel subagent run before work_complete");
        }
        const changedSinceBaseline = [...new Set([...Object.keys(state.waveBaseline), ...Object.keys(changedSnapshot)])]
          .filter((filePath) => state.waveBaseline[filePath] !== changedSnapshot[filePath]);
        const ownedPaths = fullWave.flatMap((task) => task.ownedPaths);
        const outsideOwnership = changedSinceBaseline.filter((filePath) => !pathIsOwned(filePath, ownedPaths));
        if (outsideOwnership.length > 0) throw new Error(`wave modified paths outside declared ownership: ${outsideOwnership.join(", ")}`);
        const timestamp = new Date().toISOString();
        const evidence: CompletionEvidence = {
          taskId: params.taskId,
          summary: params.summary,
          commands: params.commands,
          artifact: params.artifact,
          adversarialChecks: params.adversarialChecks,
          cleanup: params.cleanup,
          timestamp,
        };
        const plan = completeTask(currentPlan, evidence);
        const nextWave = getReadyWave(plan);
        const next = nextWave[0];
        await writePlan(session.root!, plan);
        await appendLedger(session.root!, { ...evidence, planSlug: plan.slug, sessionId: ctx.sessionManager.getSessionId() });
        const updatedState: WorkState = {
          ...state,
          status: next ? "active" : "completed",
          currentTask: next?.id,
          currentWave: next?.wave,
          waveToken: next ? (next.wave === state.currentWave ? state.waveToken : randomUUID()) : undefined,
          waveBaseline: next && next.wave !== state.currentWave ? changedSnapshot : state.waveBaseline,
          endedAt: next ? undefined : timestamp,
          updatedAt: timestamp,
        };
        await writeWorkState(session.root!, updatedState);
        return { plan, nextWave };
      });
      const next = nextWave[0];
      if (!next) {
        restoreExecutionTools();
        session.mode = "idle";
      }
      persistSession();
      if (lastContext) await updateUI(lastContext);
      return textResult(next ? `Completed ${params.taskId}. Ready wave ${next.wave}:\n${nextWave.map(renderTask).join("\n\n")}` : `Plan ${plan.slug} completed with all verification gates.`, {
        progress: getProgress(plan),
        nextWave,
      });
    },
  });

  pi.registerCommand("plan", {
    description: "Create a reviewed, durable implementation plan",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      let request = args.trim();
      if (!request && ctx.hasUI) request = (await ctx.ui.editor("What should be planned?", ""))?.trim() ?? "";
      if (!request) {
        ctx.ui.notify("Usage: /plan <request>", "warning");
        return;
      }
      const existingWork = await readWorkState(ctx.cwd);
      if (existingWork?.status === "active") {
        ctx.ui.notify(`Work ${existingWork.planSlug} is active. Run /stop-work before creating another plan.`, "warning");
        return;
      }
      restorePlanningTools();
      restoreExecutionTools();
      session = { mode: "planning", root: ctx.cwd, toolsBeforePlanning: pi.getActiveTools() };
      enterPlanningTools();
      persistSession();
      await updateUI(ctx);
      pi.sendUserMessage(`[PLAN REQUEST]\n${request}`);
    },
  });

  pi.registerCommand("start-work", {
    description: "Start or resume an approved plan",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const worktreeIndex = tokens.indexOf("--worktree");
      if (worktreeIndex >= 0 && !tokens[worktreeIndex + 1]) {
        ctx.ui.notify("Usage: /start-work [plan] --worktree <absolute-path>", "error");
        return;
      }
      const requestedWorktree = worktreeIndex >= 0 ? tokens[worktreeIndex + 1] : undefined;
      if (worktreeIndex >= 0) tokens.splice(worktreeIndex, 2);
      const root = ctx.cwd;
      const worktreePath = path.resolve(root, requestedWorktree ?? ".");
      if (worktreePath !== path.resolve(ctx.cwd)) {
        ctx.ui.notify(`Start Pi inside the requested worktree first: ${worktreePath}`, "error");
        return;
      }
      let plan: PlanDocument | undefined;
      try {
        plan = await resolvePlan(root, tokens[0], ctx);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      if (!plan) {
        ctx.ui.notify("No incomplete plan found. Run /plan first.", "warning");
        return;
      }
      if (plan.review.verdict !== "approved") {
        ctx.ui.notify(`Plan ${plan.slug} is not approved. Finish /plan review first.`, "error");
        return;
      }
      const readyWave = getReadyWave(plan);
      const next = readyWave[0];
      if (!next) {
        ctx.ui.notify(`Plan ${plan.slug} is already complete.`, "info");
        return;
      }
      const previous = await readWorkState(root);
      if (previous?.status === "active" && previous.planSlug !== plan.slug) {
        ctx.ui.notify(`Work ${previous.planSlug} is already active. Run /stop-work before switching plans.`, "error");
        return;
      }
      await withWorkLock(root, () => writePlan(root, plan!));
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm("Start work?", `${plan.title}\n${getProgress(plan).remaining} items remain\nWave ${next.wave}: ${readyWave.length} parallel item(s)`);
        if (!confirmed) return;
      }
      restorePlanningTools();
      restoreExecutionTools();
      const normalTools = pi.getActiveTools();
      session = { mode: "executing", root, planSlug: plan.slug, toolsBeforeExecution: normalTools };
      enterCoordinatorTools();
      const now = new Date().toISOString();
      let changedSnapshot: Record<string, string>;
      try {
        changedSnapshot = await getChangedSnapshot(root);
      } catch (error) {
        restoreExecutionTools();
        session = { mode: "idle" };
        persistSession();
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const state: WorkState = {
        version: 1,
        planSlug: plan.slug,
        planPath: path.join(".pi", "work", "plans", `${plan.slug}.md`),
        projectRoot: root,
        worktreePath,
        status: "active",
        currentTask: next.id,
        currentWave: next.wave,
        waveToken: previous?.planSlug === plan.slug && previous.currentWave === next.wave
          ? previous.waveToken ?? randomUUID()
          : randomUUID(),
        waveBaseline: previous?.planSlug === plan.slug && previous.currentWave === next.wave
          ? previous.waveBaseline
          : changedSnapshot,
        sessionIds: [...new Set([...(previous?.planSlug === plan.slug ? previous.sessionIds : []), sessionId])],
        startedAt: previous?.planSlug === plan.slug ? previous.startedAt : now,
        updatedAt: now,
      };
      await withWorkLock(root, () => writeWorkState(root, state));
      continuationScheduled = false;
      persistSession();
      await updateUI(ctx);
      pi.sendUserMessage(`[START WORK]\nPlan: ${state.planPath}\nWave: ${state.currentWave}\nWave token: ${state.waveToken}`);
    },
  });

  pi.registerCommand("work-status", {
    description: "Show durable Plan -> Execute progress",
    handler: async (_args, ctx) => {
      const state = await readWorkState(ctx.cwd);
      if (!state) {
        ctx.ui.notify("No work state found.", "info");
        return;
      }
      const plan = await readPlan(ctx.cwd, state.planSlug);
      const progress = getProgress(plan);
      const wave = getReadyWave(plan);
      const next = wave[0];
      ctx.ui.notify(`${plan.title}\nStatus: ${state.status}\nProgress: ${progress.completed}/${progress.total}\nReady wave: ${next ? `${next.wave} (${wave.map((task) => task.id).join(", ")})` : "none"}`, "info");
    },
  });

  pi.registerCommand("stop-work", {
    description: "Durably stop automatic plan continuation",
    handler: async (args, ctx) => {
      const root = session.root ?? ctx.cwd;
      const state = await readWorkState(root);
      if (!state) {
        ctx.ui.notify("No work state found.", "info");
        return;
      }
      const now = new Date().toISOString();
      await withWorkLock(root, () => writeWorkState(root, { ...state, status: "stopped", stopReason: args.trim() || "Stopped by user", updatedAt: now }));
      restoreExecutionTools();
      session.mode = "idle";
      continuationScheduled = false;
      if (!ctx.isIdle()) ctx.abort();
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Stopped ${state.planSlug}. Run /start-work ${state.planSlug} to resume.`, "warning");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    lastContext = ctx;
    if (session.mode === "planning") {
      return {
        message: {
          customType: "plan-execute-planning",
          display: false,
          content: `Plan read-only. Use plan_load whenever canonical state is uncertain. Delegate gaps to plan-analyst, ask only unresolved preferences, assign dependency-safe waves and disjoint owned paths, then call plan_save. It returns the exact planPath and a fresh reviewToken for that revision. Run plan-reviewer once as a foreground single subagent (async:false) with both exact values in its task and outputSchema ${JSON.stringify(PLAN_REVIEW_OUTPUT_SCHEMA)}. Then call plan_review({}); it imports verdict and findings directly. For rejected task-only fixes use plan_update, which issues a new token; otherwise plan_save the full revision. Never copy reviewer conclusions manually or modify source files.`,
        },
      };
    }
    if (session.mode === "executing" && session.root && session.planSlug) {
      const plan = await readPlan(session.root, session.planSlug);
      const state = await readWorkState(session.root);
      const wave = getReadyWave(plan);
      if (!state?.waveToken || wave.length === 0) return;
      const assignments = wave.map((task) => {
        const agent = task.kind === "implementation" ? "worker" : "verification-reviewer";
        return `Agent: ${agent}\nPlan: .pi/work/plans/${plan.slug}.md\nWave token: ${state.waveToken}\nItem: ${task.id}\n${renderTask(task)}`;
      }).join("\n\n---\n\n");
      const alreadyRan = hasWaveEvidence(ctx, plan.slug, state.waveToken, wave);
      const action = alreadyRan
        ? "The parallel subagent result for these items already exists. Do not relaunch it; inspect that result and finish recording each item."
        : "Launch every assignment below in one subagent workflowScript using await runs.all with async:true so the wave runs concurrently, then collect completion with subagent_wait({all:true}).";
      return {
        message: {
          customType: "plan-execute-current-wave",
          display: false,
          content: `You are the coordinator and must not edit source files. ${action} Use worktree:false for each child because same-wave owned paths are disjoint and changes must land in this worktree. Workers may modify only their owned paths; verification-reviewer runs read-only. Wait for all children, inspect their outputs, run coordinator-level validation, then call work_complete once per item with waveToken ${state.waveToken} and concrete evidence.\n\n${assignments}`,
        },
      };
    }
  });

  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown>;
    if (session.mode === "planning") {
      if (PLANNING_DISABLED_TOOLS.has(event.toolName) || (/(write|edit|patch|fix|apply)/i.test(event.toolName) && !["plan_save", "plan_review"].includes(event.toolName))) {
        return { block: true, reason: `${event.toolName} is disabled during /plan` };
      }
      if (event.toolName === "bash") {
        const command = String(input.command ?? "");
        if (!SAFE_BASH.test(command) || SHELL_MUTATION.test(command)) return { block: true, reason: "Only conservative read-only shell commands are allowed during /plan" };
      }
      if (event.toolName === "subagent") {
        const agent = typeof input.agent === "string" ? input.agent : undefined;
        if (!agent || !PLANNING_SUBAGENTS.has(agent) || input.workflowScript) return { block: true, reason: "Planning may delegate only to plan-analyst or plan-reviewer" };
        if (agent === "plan-reviewer") {
          if (input.async === true) return { block: true, reason: "plan-reviewer is a single foreground review; use async:false" };
          if (!input.outputSchema || typeof input.outputSchema !== "object") return { block: true, reason: "plan-reviewer requires the structured outputSchema supplied by the planning instructions" };
          if (!session.root || !session.planSlug) return { block: true, reason: "call plan_save before plan-reviewer" };
          const current = await readPlan(session.root, session.planSlug);
          const task = String(input.task ?? "");
          const planPath = `.pi/work/plans/${current.slug}.md`;
          if (!task.includes(planPath)) return { block: true, reason: `plan-reviewer task must include exact plan path ${planPath}` };
          if (!task.includes(current.reviewToken)) return { block: true, reason: `plan-reviewer task must include current review token ${current.reviewToken}` };
        }
      }
    }

    if (session.mode === "executing") {
      if (/(write|edit|patch|fix|apply)/i.test(event.toolName)) {
        return { block: true, reason: "The Plan -> Execute coordinator cannot modify source files; delegate the ready wave to workers" };
      }
      if (event.toolName === "bash" && SHELL_MUTATION.test(String(input.command ?? ""))) {
        return { block: true, reason: "The coordinator may run validation commands but cannot mutate files or Git state" };
      }
      if (event.toolName === "subagent" && typeof input.workflowScript !== "string") {
        return { block: true, reason: "Execute the ready wave in one workflowScript using await runs.all" };
      }
    }

    if (/(write|edit|patch|fix|apply)/i.test(event.toolName)) {
      const target = getPathFromToolInput(input);
      const serialized = JSON.stringify(input).replaceAll("\\", "/");
      if (target?.replaceAll("\\", "/").includes(".pi/work/") || serialized.includes(".pi/work/")) {
        return { block: true, reason: ".pi/work is managed by plan_save, plan_review, and work_complete" };
      }
    }
    if (event.toolName === "bash" && String(input.command ?? "").includes(".pi/work")) {
      return { block: true, reason: ".pi/work is managed by the Plan -> Execute extension" };
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastContext = ctx;
    continuationScheduled = false;
    if (session.mode === "executing" && session.root && session.planSlug) {
      completedAtAgentStart = getProgress(await readPlan(session.root, session.planSlug)).completed;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastContext = ctx;
    if (session.mode !== "executing" || !session.root || !session.planSlug || continuationScheduled) return;
    const plan = await readPlan(session.root, session.planSlug);
    const progress = getProgress(plan);
    const state = await readWorkState(session.root);
    if (!state || state.status !== "active") return;
    if (progress.remaining === 0) {
      session.mode = "idle";
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Plan ${plan.slug} completed.`, "info");
      return;
    }
    if (progress.completed <= completedAtAgentStart) {
      if (state.waveToken && hasActiveWaveLaunch(ctx, state.waveToken)) {
        ctx.ui.notify(`Wave ${state.currentWave} is still running in background.`, "info");
        return;
      }
      await withWorkLock(session.root, () => writeWorkState(session.root!, { ...state, status: "paused", stopReason: "No plan item completed in the last run", updatedAt: new Date().toISOString() }));
      restoreExecutionTools();
      session.mode = "idle";
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Paused ${plan.slug}: no item was completed. Run /start-work ${plan.slug} to resume.`, "warning");
      return;
    }
    const nextWave = getReadyWave(plan);
    const next = nextWave[0];
    if (!next || !state.waveToken) return;
    continuationScheduled = true;
    try {
      pi.sendUserMessage(`[CONTINUE WORK]\nPlan: .pi/work/plans/${plan.slug}.md\nWave: ${next.wave}\nWave token: ${state.waveToken}\nParallel items: ${nextWave.map((task) => task.id).join(", ")}`, { deliverAs: "followUp" });
    } catch (error) {
      continuationScheduled = false;
      await withWorkLock(session.root, () => writeWorkState(session.root!, {
        ...state,
        status: "paused",
        stopReason: `Continuation dispatch failed: ${(error as Error).message}`,
        updatedAt: new Date().toISOString(),
      }));
      restoreExecutionTools();
      session.mode = "idle";
      persistSession();
      await updateUI(ctx);
      ctx.ui.notify(`Paused ${plan.slug}: continuation dispatch failed.`, "error");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    lastContext = ctx;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === WORKFLOW_CUSTOM_TYPE && entry.data) session = entry.data as SessionWorkflowState;
    }
    if (session.mode === "planning") enterPlanningTools();
    if (session.mode === "executing") {
      const state = await readWorkState(session.root ?? ctx.cwd).catch(() => undefined);
      if (!state || state.status !== "active") {
        restoreExecutionTools();
        session.mode = "idle";
      }
      else {
        restoreExecutionTools();
        session.mode = "idle";
        const root = session.root ?? ctx.cwd;
        await withWorkLock(root, () => writeWorkState(root, { ...state, status: "paused", stopReason: "Session resumed; explicit /start-work required", updatedAt: new Date().toISOString() }));
        persistSession();
      }
    }
    await updateUI(ctx);
  });
}
