import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export type ReviewVerdict = "pending" | "approved" | "rejected";
export type TaskStatus = "pending" | "implemented" | "completed";
export type WorkStatus = "planned" | "active" | "paused" | "completed" | "stopped" | "abandoned";
export type WorkStage = "dispatch" | "verify";

export interface Requirement {
  id: string;
  text: string;
}

export interface Decision {
  id: string;
  text: string;
  rationale: string;
}

export interface RepositoryEvidence {
  claim: string;
  references: string[];
}

export interface MetisGap {
  type: "user-decision" | "missing-research" | "unsupported-assumption" | "scope-conflict" | "missing-requirement" | "untestable-outcome";
  issue: string;
  requiredAction: string;
  reason: string;
}

export interface MetisOutput {
  briefPath: string;
  briefHash: string;
  readiness: "ready" | "blocked";
  blockingGaps: MetisGap[];
  nonBlockingRisks: string[];
  directives: string[];
}

export interface PlanningBrief {
  version: 2;
  slug: string;
  request: string;
  requirements: Requirement[];
  decisions: Decision[];
  assumptions: string[];
  constraints: string[];
  outOfScope: string[];
  repositoryEvidence: RepositoryEvidence[];
  proposedApproach: string;
  openQuestions: string[];
  revision: number;
  briefHash: string;
  metis: {
    readiness: "pending" | "ready" | "blocked";
    briefHash?: string;
    blockingGaps: MetisGap[];
    nonBlockingRisks: string[];
    directives: string[];
    reviewedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CheckSpec {
  id: string;
  program: string;
  args: string[];
  cwd?: string;
  artifacts: string[];
}

export interface PlanTask {
  id: string;
  title: string;
  outcome: string;
  satisfies: string[];
  decisions: string[];
  references: string[];
  dependsOn: string[];
  expectedPaths: string[];
  acceptance: string[];
  workerChecks: CheckSpec[];
  waveChecks: CheckSpec[];
  status: TaskStatus;
  completedAt?: string;
}

export interface SemanticDelta {
  leaseId: string;
  accomplished: string[];
  architectureChanges: Array<{ fact: string; rationale: string; references: string[] }>;
  decisions: Array<{ text: string; rationale: string; references: string[] }>;
  invalidatedAssumptions: string[];
  planDeviations: string[];
  newRisks: string[];
  userDecisionNeeded: string[];
  recordedAt: string;
}

export interface MomusFinding {
  requirementId?: string;
  taskIds: string[];
  issue: string;
  reason: string;
  requiredCorrection: string;
}

export interface MomusOutput {
  planPath: string;
  planHash: string;
  verdict: Exclude<ReviewVerdict, "pending">;
  blockingFindings: MomusFinding[];
  nonBlockingNotes: string[];
}

export interface PlanDocument {
  version: 2;
  slug: string;
  title: string;
  goal: string;
  briefSlug: string;
  briefHash: string;
  requirements: Requirement[];
  decisions: Decision[];
  assumptions: string[];
  constraints: string[];
  outOfScope: string[];
  repositoryEvidence: RepositoryEvidence[];
  architecture: Array<{ fact: string; references: string[] }>;
  risks: string[];
  tasks: PlanTask[];
  finalChecks: CheckSpec[];
  semanticDeltas: SemanticDelta[];
  revision: number;
  specHash: string;
  momus: {
    verdict: ReviewVerdict;
    planHash?: string;
    blockingFindings: MomusFinding[];
    nonBlockingNotes: string[];
    reviewedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WorkerOutput {
  leaseId: string;
  attemptId: string;
  planHash: string;
  taskIds: string[];
  status: "implemented" | "blocked";
  summary: string;
  changedPaths: string[];
  semanticDelta: Omit<SemanticDelta, "leaseId" | "recordedAt">;
  blocker?: string;
}

export interface CheckReceipt {
  id: string;
  scope: "worker" | "wave" | "final";
  command: string[];
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  artifactHashes: Record<string, string>;
}

export interface ExecutionLease {
  id: string;
  planHash: string;
  taskIds: string[];
  baseline: Record<string, string>;
  attempt: number;
  createdAt: string;
}

export interface WorkerAttempt {
  id: string;
  number: number;
  status: "reserved" | "running" | "unresolved" | "terminal";
  toolCallId?: string;
  rootRunId?: string;
  childRunId?: string;
  success?: boolean;
  consumed?: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface WorkState {
  version: 2;
  generation: number;
  ownerId?: string;
  planSlug: string;
  planHash: string;
  status: WorkStatus;
  stage: WorkStage;
  lease?: ExecutionLease;
  workerAttempt?: WorkerAttempt;
  workerRunId?: string;
  verificationAttempt?: { id: string; status: "running" | "terminal"; startedAt: string; endedAt?: string };
  receipts: CheckReceipt[];
  lastFailure?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  stopReason?: string;
}

export interface RuntimeCheckpoint {
  version: 2;
  plan: PlanDocument;
  state: WorkState;
  writtenAt: string;
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `plan-${Date.now()}`;
}

function safeRelative(value: string, label: string): string {
  const cleaned = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const normalized = path.posix.normalize(cleaned);
  const reserved = normalized === ".git" || normalized.startsWith(".git/") || normalized === ".pi/work" || normalized.startsWith(".pi/work/");
  if (!normalized || normalized === "." || normalized.includes("\0") || path.isAbsolute(normalized) || normalized.split("/").includes("..") || reserved) {
    throw new Error(`${label} has unsafe or reserved path ${value || "(empty)"}`);
  }
  return normalized;
}

const FORBIDDEN_CHECK_PROGRAMS = new Set(["bash", "sh", "zsh", "fish", "rm", "mv", "cp", "dd", "tee", "curl", "wget", "sudo", "doas"]);

function normalizeCheck(check: Omit<CheckSpec, "artifacts"> & { artifacts?: string[] }, owner: string): CheckSpec {
  const id = check.id.trim();
  const program = check.program.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id.includes("..") || !program) throw new Error(`${owner} check requires a safe id and program`);
  if (program.includes("/") || program.includes("\\") || FORBIDDEN_CHECK_PROGRAMS.has(program)) throw new Error(`${owner} check ${id} uses a forbidden program`);
  const unsafeGitArg = (arg: string) => arg === "--ext-diff" || arg === "--textconv" || arg === "--no-textconv" || arg === "--paginate" || arg === "-p" || arg.startsWith("--exec-path") || arg.startsWith("--config-env") || arg.startsWith("--output") || arg === "-o" || arg.startsWith("--no-pager=");
  if (program === "git" && (!["diff", "status", "show", "log", "grep", "ls-files"].includes(check.args[0] ?? "") || check.args.some(unsafeGitArg))) throw new Error(`${owner} check ${id} uses an unsafe Git command`);
  if (program === "nix" && !["build", "eval", "flake"].includes(check.args[0] ?? "")) throw new Error(`${owner} check ${id} uses an unsupported Nix command`);
  if (program === "nix" && check.args.some((arg) => arg === "-o" || arg === "--out-link" || arg.startsWith("--out-link=") || arg === "--write-to" || arg.startsWith("--write-to=") || arg === "--write-lock-file")) throw new Error(`${owner} check ${id} uses a mutating Nix output or lock option`);
  if (program === "nix" && check.args[0] === "flake" && !["check", "show", "metadata"].includes(check.args[1] ?? "")) throw new Error(`${owner} check ${id} uses a mutating or unsupported Nix flake command`);
  if (program === "nix" && check.args[0] === "build" && !check.args.includes("--no-link")) throw new Error(`${owner} check ${id} must use nix build --no-link`);
  const evalFlags = new Set(["-e", "-c", "-p", "--eval", "--print"]);
  if (["bun", "node", "deno", "python", "python3", "ruby", "perl"].includes(program) && check.args.some((arg) => evalFlags.has(arg))) throw new Error(`${owner} check ${id} cannot execute inline code`);
  const args = check.args.map((arg) => String(arg));
  if (program === "nix" && !args.includes("--no-write-lock-file")) args.push("--no-write-lock-file");
  return {
    id,
    program,
    args,
    cwd: check.cwd ? safeRelative(check.cwd, `${owner} check ${id} cwd`) : undefined,
    artifacts: cleanList(check.artifacts).map((artifact) => safeRelative(artifact, `${owner} check ${id} artifact`)),
  };
}

function parseObject<T>(output: string, label: string): T {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`${label} output is not a JSON object`);
  return JSON.parse(output.slice(start, end + 1)) as T;
}

function assertKeys(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${label} has unsupported fields: ${extra.join(", ")}`);
}

export function createPlanningBrief(input: {
  request: string;
  requirements: string[];
  decisions?: Array<{ text: string; rationale: string }>;
  assumptions?: string[];
  constraints?: string[];
  outOfScope?: string[];
  repositoryEvidence?: RepositoryEvidence[];
  proposedApproach: string;
  openQuestions?: string[];
}, previous?: PlanningBrief): PlanningBrief {
  const request = input.request.trim();
  const proposedApproach = input.proposedApproach.trim();
  const requirements = cleanList(input.requirements).map((text, index) => ({ id: `R${index + 1}`, text }));
  if (!request || !proposedApproach || requirements.length === 0) throw new Error("request, requirements, and proposedApproach are required");
  const decisions = (input.decisions ?? []).map((decision, index) => ({
    id: `D${index + 1}`,
    text: decision.text.trim(),
    rationale: decision.rationale.trim(),
  }));
  if (decisions.some((decision) => !decision.text || !decision.rationale)) throw new Error("every decision requires text and rationale");
  const evidence = (input.repositoryEvidence ?? []).map((item) => ({
    claim: item.claim.trim(),
    references: cleanList(item.references),
  }));
  if (evidence.some((item) => !item.claim || item.references.length === 0)) throw new Error("repository evidence requires a claim and references");
  const spec = {
    request,
    requirements,
    decisions,
    assumptions: cleanList(input.assumptions),
    constraints: cleanList(input.constraints),
    outOfScope: cleanList(input.outOfScope),
    repositoryEvidence: evidence,
    proposedApproach,
    openQuestions: cleanList(input.openQuestions),
  };
  const now = new Date().toISOString();
  return {
    version: 2,
    slug: previous?.slug ?? slugify(request),
    ...spec,
    revision: (previous?.revision ?? 0) + 1,
    briefHash: contentHash(spec),
    metis: { readiness: "pending", blockingGaps: [], nonBlockingRisks: [], directives: [] },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export function parseMetisOutput(output: string): MetisOutput {
  const parsed = parseObject<MetisOutput>(output, "Metis");
  assertKeys(parsed, ["briefPath", "briefHash", "readiness", "blockingGaps", "nonBlockingRisks", "directives"], "Metis output");
  if (!parsed.briefPath?.trim() || !parsed.briefHash?.trim()) throw new Error("Metis output is missing briefPath or briefHash");
  if (!(["ready", "blocked"] as unknown[]).includes(parsed.readiness)) throw new Error("Metis output has invalid readiness");
  if (!Array.isArray(parsed.blockingGaps) || !Array.isArray(parsed.nonBlockingRisks) || !Array.isArray(parsed.directives)) throw new Error("Metis output has invalid arrays");
  const gapTypes = new Set(["user-decision", "missing-research", "unsupported-assumption", "scope-conflict", "missing-requirement", "untestable-outcome"]);
  if (parsed.blockingGaps.some((gap) => { try { assertKeys(gap, ["type", "issue", "requiredAction", "reason"], "Metis blocking gap"); return !gapTypes.has(gap.type) || !gap.issue?.trim() || !gap.requiredAction?.trim() || !gap.reason?.trim(); } catch { return true; } })) throw new Error("Metis output has an invalid blocking gap");
  if (parsed.nonBlockingRisks.some((item) => typeof item !== "string") || parsed.directives.some((item) => typeof item !== "string")) throw new Error("Metis output has invalid text entries");
  if (parsed.readiness === "ready" && parsed.blockingGaps.length > 0) throw new Error("ready Metis output cannot contain blocking gaps");
  if (parsed.readiness === "blocked" && parsed.blockingGaps.length === 0) throw new Error("blocked Metis output requires blocking gaps");
  return parsed;
}

export function applyMetisReview(brief: PlanningBrief, review: MetisOutput): PlanningBrief {
  if (review.briefHash !== brief.briefHash) throw new Error("Metis review is stale");
  return {
    ...brief,
    metis: {
      readiness: review.readiness,
      briefHash: review.briefHash,
      blockingGaps: review.blockingGaps,
      nonBlockingRisks: cleanList(review.nonBlockingRisks),
      directives: cleanList(review.directives),
      reviewedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function planSpec(plan: Pick<PlanDocument, "title" | "goal" | "briefSlug" | "briefHash" | "requirements" | "decisions" | "assumptions" | "constraints" | "outOfScope" | "repositoryEvidence" | "architecture" | "risks" | "tasks" | "finalChecks">) {
  return {
    title: plan.title,
    goal: plan.goal,
    briefSlug: plan.briefSlug,
    briefHash: plan.briefHash,
    requirements: plan.requirements,
    decisions: plan.decisions,
    assumptions: plan.assumptions,
    constraints: plan.constraints,
    outOfScope: plan.outOfScope,
    repositoryEvidence: plan.repositoryEvidence,
    architecture: plan.architecture,
    risks: plan.risks,
    tasks: plan.tasks.map(({ status: _status, completedAt: _completedAt, ...task }) => task),
    finalChecks: plan.finalChecks,
  };
}

export interface PlanInput {
  title: string;
  goal: string;
  architecture?: Array<{ fact: string; references: string[] }>;
  risks?: string[];
  tasks: Array<{
    title: string;
    outcome: string;
    satisfies: string[];
    decisions?: string[];
    references?: string[];
    dependsOn?: string[];
    expectedPaths: string[];
    acceptance: string[];
    workerChecks: Array<Omit<CheckSpec, "artifacts"> & { artifacts?: string[] }>;
    waveChecks?: Array<Omit<CheckSpec, "artifacts"> & { artifacts?: string[] }>;
  }>;
  finalChecks: Array<Omit<CheckSpec, "artifacts"> & { artifacts?: string[] }>;
}

export interface PlanPatchInput {
  expectedHash: string;
  title?: string;
  goal?: string;
  architecture?: Array<{ fact: string; references: string[] }>;
  risks?: string[];
  taskPatches?: Array<{ id: string } & Partial<PlanInput["tasks"][number]>>;
  finalChecks?: PlanInput["finalChecks"];
}

export function createPlan(input: PlanInput, brief: PlanningBrief, previous?: PlanDocument): PlanDocument {
  if (brief.metis.readiness !== "ready" || brief.metis.briefHash !== brief.briefHash) throw new Error("current Planning Brief requires Metis READY before plan generation");
  if (brief.openQuestions.length > 0) throw new Error("Planning Brief still has open questions");
  const title = input.title.trim();
  const goal = input.goal.trim();
  if (!title || !goal || input.tasks.length === 0) throw new Error("title, goal, and at least one task are required");
  const requirementIds = new Set(brief.requirements.map((item) => item.id));
  const decisionIds = new Set(brief.decisions.map((item) => item.id));
  const tasks: PlanTask[] = input.tasks.map((task, index) => {
    const id = `T${index + 1}`;
    const satisfies = cleanList(task.satisfies);
    const decisions = cleanList(task.decisions);
    if (!task.title.trim() || !task.outcome.trim()) throw new Error(`${id} requires title and outcome`);
    if (satisfies.length === 0 || satisfies.some((value) => !requirementIds.has(value))) throw new Error(`${id} has missing or unknown requirement IDs`);
    if (decisions.some((value) => !decisionIds.has(value))) throw new Error(`${id} has unknown decision IDs`);
    const acceptance = cleanList(task.acceptance);
    if (acceptance.length === 0) throw new Error(`${id} requires acceptance criteria`);
    const expectedPaths = cleanList(task.expectedPaths).map((value) => safeRelative(value, id));
    if (expectedPaths.length === 0) throw new Error(`${id} requires expected paths`);
    const workerChecks = task.workerChecks.map((check) => normalizeCheck(check, id));
    const waveChecks = (task.waveChecks ?? []).map((check) => normalizeCheck(check, `${id} wave`));
    const outsideArtifacts = [...workerChecks, ...waveChecks].flatMap((check) => check.artifacts).filter((artifact) => !expectedPaths.some((allowed) => artifact === allowed || artifact.startsWith(`${allowed}/`)));
    if (outsideArtifacts.length > 0) throw new Error(`${id} check artifacts are outside expected paths: ${outsideArtifacts.join(", ")}`);
    if (workerChecks.length === 0) throw new Error(`${id} requires worker checks`);
    return {
      id,
      title: task.title.trim(),
      outcome: task.outcome.trim(),
      satisfies,
      decisions,
      references: cleanList(task.references),
      dependsOn: cleanList(task.dependsOn),
      expectedPaths,
      acceptance,
      workerChecks,
      waveChecks,
      status: "pending",
    };
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`${task.id} has unknown dependency ${dependency}`);
      if (Number(dependency.slice(1)) >= Number(task.id.slice(1))) throw new Error(`${task.id} must depend only on an earlier task`);
    }
  }
  for (const requirement of requirementIds) {
    if (!tasks.some((task) => task.satisfies.includes(requirement))) throw new Error(`requirement ${requirement} is not satisfied by any task`);
  }
  const finalChecks = input.finalChecks.map((check) => normalizeCheck(check, "final"));
  const planPaths = tasks.flatMap((task) => task.expectedPaths);
  const outsideFinalArtifacts = finalChecks.flatMap((check) => check.artifacts).filter((artifact) => !planPaths.some((allowed) => artifact === allowed || artifact.startsWith(`${allowed}/`)));
  if (outsideFinalArtifacts.length > 0) throw new Error(`final check artifacts are outside plan paths: ${outsideFinalArtifacts.join(", ")}`);
  if (finalChecks.length === 0) throw new Error("at least one final check is required");
  const checkIds = [...tasks.flatMap((task) => [...task.workerChecks, ...task.waveChecks]), ...finalChecks].map((check) => check.id);
  if (new Set(checkIds).size !== checkIds.length) throw new Error("check IDs must be unique across the plan");
  const architecture = (input.architecture ?? []).map((item) => ({ fact: item.fact.trim(), references: cleanList(item.references) }));
  if (architecture.some((item) => !item.fact || item.references.length === 0)) throw new Error("architecture facts require references");
  const now = new Date().toISOString();
  const base: Omit<PlanDocument, "specHash"> = {
    version: 2,
    slug: previous?.slug ?? slugify(title),
    title,
    goal,
    briefSlug: brief.slug,
    briefHash: brief.briefHash,
    requirements: brief.requirements,
    decisions: brief.decisions,
    assumptions: brief.assumptions,
    constraints: brief.constraints,
    outOfScope: brief.outOfScope,
    repositoryEvidence: brief.repositoryEvidence,
    architecture,
    risks: cleanList([...(brief.metis.nonBlockingRisks ?? []), ...(input.risks ?? [])]),
    tasks,
    finalChecks,
    semanticDeltas: [],
    revision: (previous?.revision ?? 0) + 1,
    momus: { verdict: "pending", blockingFindings: [], nonBlockingNotes: [] },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  return { ...base, specHash: contentHash(planSpec(base as PlanDocument)) };
}

export function patchPlan(plan: PlanDocument, brief: PlanningBrief, patch: PlanPatchInput): PlanDocument {
  if (patch.expectedHash !== plan.specHash) throw new Error("plan patch expectedHash is stale");
  if (plan.tasks.some((task) => task.status !== "pending")) throw new Error("cannot patch a plan after execution has started");
  const patches = new Map((patch.taskPatches ?? []).map((item) => [item.id.trim(), item]));
  if (patches.size !== (patch.taskPatches ?? []).length || [...patches].some(([id]) => !plan.tasks.some((task) => task.id === id))) throw new Error("plan patch contains a duplicate or unknown task ID");
  const hasChange = patch.title !== undefined || patch.goal !== undefined || patch.architecture !== undefined || patch.risks !== undefined || patch.finalChecks !== undefined || patches.size > 0;
  if (!hasChange) throw new Error("plan patch contains no changes");
  const tasks: PlanInput["tasks"] = plan.tasks.map(({ id, status: _status, completedAt: _completedAt, ...task }) => {
    const taskPatch = patches.get(id);
    if (!taskPatch) return task;
    const { id: _id, ...changes } = taskPatch;
    return { ...task, ...changes };
  });
  return createPlan({
    title: patch.title ?? plan.title,
    goal: patch.goal ?? plan.goal,
    architecture: patch.architecture ?? plan.architecture,
    risks: patch.risks ?? plan.risks,
    tasks,
    finalChecks: patch.finalChecks ?? plan.finalChecks,
  }, brief, plan);
}

export function parseMomusOutput(output: string): MomusOutput {
  const parsed = parseObject<MomusOutput>(output, "Momus");
  assertKeys(parsed, ["planPath", "planHash", "verdict", "blockingFindings", "nonBlockingNotes"], "Momus output");
  if (!parsed.planPath?.trim() || !parsed.planHash?.trim()) throw new Error("Momus output is missing planPath or planHash");
  if (!(["approved", "rejected"] as unknown[]).includes(parsed.verdict)) throw new Error("Momus output has invalid verdict");
  if (!Array.isArray(parsed.blockingFindings) || !Array.isArray(parsed.nonBlockingNotes)) throw new Error("Momus output has invalid arrays");
  if (parsed.blockingFindings.some((finding) => { try { assertKeys(finding, ["requirementId", "taskIds", "issue", "reason", "requiredCorrection"], "Momus finding"); return (finding.requirementId !== undefined && typeof finding.requirementId !== "string") || !Array.isArray(finding.taskIds) || finding.taskIds.some((item) => typeof item !== "string") || !finding.issue?.trim() || !finding.reason?.trim() || !finding.requiredCorrection?.trim(); } catch { return true; } })) throw new Error("Momus output has an invalid blocking finding");
  if (parsed.nonBlockingNotes.some((item) => typeof item !== "string")) throw new Error("Momus output has invalid notes");
  if (parsed.verdict === "approved" && parsed.blockingFindings.length > 0) throw new Error("approved Momus output cannot contain blocking findings");
  if (parsed.verdict === "rejected" && parsed.blockingFindings.length === 0) throw new Error("rejected Momus output requires blocking findings");
  return parsed;
}

export function applyMomusReview(plan: PlanDocument, review: MomusOutput): PlanDocument {
  if (review.planHash !== plan.specHash) throw new Error("Momus review is stale");
  return {
    ...plan,
    momus: {
      verdict: review.verdict,
      planHash: review.planHash,
      blockingFindings: review.blockingFindings,
      nonBlockingNotes: cleanList(review.nonBlockingNotes),
      reviewedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function getReadyTasks(plan: PlanDocument): PlanTask[] {
  if (plan.tasks.some((task) => task.status === "implemented")) return [];
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return plan.tasks.filter((task) => task.status === "pending" && task.dependsOn.every((dependency) => completed.has(dependency)));
}

export function getImplementedTasks(plan: PlanDocument): PlanTask[] {
  return plan.tasks.filter((task) => task.status === "implemented");
}

export function getProgress(plan: PlanDocument): { completed: number; total: number; remaining: number } {
  const completed = plan.tasks.filter((task) => task.status === "completed").length;
  return { completed, total: plan.tasks.length, remaining: plan.tasks.length - completed };
}

export function createLease(plan: PlanDocument, baseline: Record<string, string>, previous?: ExecutionLease): ExecutionLease {
  const tasks = getReadyTasks(plan);
  if (tasks.length === 0) throw new Error("no dependency-ready tasks");
  return {
    id: randomUUID(),
    planHash: plan.specHash,
    taskIds: tasks.map((task) => task.id),
    baseline,
    attempt: (previous?.attempt ?? 0) + 1,
    createdAt: new Date().toISOString(),
  };
}

export function parseWorkerOutput(output: string): WorkerOutput {
  const parsed = parseObject<WorkerOutput>(output, "worker");
  assertKeys(parsed, ["leaseId", "attemptId", "planHash", "taskIds", "status", "summary", "changedPaths", "semanticDelta", "blocker"], "worker output");
  assertKeys(parsed.semanticDelta, ["accomplished", "architectureChanges", "decisions", "invalidatedAssumptions", "planDeviations", "newRisks", "userDecisionNeeded"], "worker semantic delta");
  if (!parsed.leaseId?.trim() || !parsed.attemptId?.trim() || !parsed.planHash?.trim() || !Array.isArray(parsed.taskIds) || parsed.taskIds.some((item) => typeof item !== "string")) throw new Error("worker output is missing execution identity");
  if (!(["implemented", "blocked"] as unknown[]).includes(parsed.status)) throw new Error("worker output has invalid status");
  if (!parsed.summary?.trim() || (parsed.blocker !== undefined && typeof parsed.blocker !== "string") || !Array.isArray(parsed.changedPaths) || parsed.changedPaths.some((item) => typeof item !== "string") || !parsed.semanticDelta) throw new Error("worker output is incomplete");
  const delta = parsed.semanticDelta;
  if (![delta.accomplished, delta.invalidatedAssumptions, delta.planDeviations, delta.newRisks, delta.userDecisionNeeded].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))) throw new Error("worker semantic delta has invalid text arrays");
  if (!Array.isArray(delta.architectureChanges) || delta.architectureChanges.some((item) => { try { assertKeys(item, ["fact", "rationale", "references"], "architecture change"); return !item.fact?.trim() || !item.rationale?.trim() || !Array.isArray(item.references) || item.references.some((reference) => typeof reference !== "string"); } catch { return true; } })) throw new Error("worker semantic delta has invalid architecture changes");
  if (!Array.isArray(delta.decisions) || delta.decisions.some((item) => { try { assertKeys(item, ["text", "rationale", "references"], "worker decision"); return !item.text?.trim() || !item.rationale?.trim() || !Array.isArray(item.references) || item.references.some((reference) => typeof reference !== "string"); } catch { return true; } })) throw new Error("worker semantic delta has invalid decisions");
  return parsed;
}

function normalizeDelta(leaseId: string, delta: WorkerOutput["semanticDelta"]): SemanticDelta {
  return {
    leaseId,
    accomplished: cleanList(delta.accomplished),
    architectureChanges: (delta.architectureChanges ?? []).map((item) => ({
      fact: item.fact.trim(), rationale: item.rationale.trim(), references: cleanList(item.references),
    })),
    decisions: (delta.decisions ?? []).map((item) => ({
      text: item.text.trim(), rationale: item.rationale.trim(), references: cleanList(item.references),
    })),
    invalidatedAssumptions: cleanList(delta.invalidatedAssumptions),
    planDeviations: cleanList(delta.planDeviations),
    newRisks: cleanList(delta.newRisks),
    userDecisionNeeded: cleanList(delta.userDecisionNeeded),
    recordedAt: new Date().toISOString(),
  };
}

export function recordSemanticDelta(plan: PlanDocument, leaseId: string, delta: WorkerOutput["semanticDelta"]): PlanDocument {
  const normalized = normalizeDelta(leaseId, delta);
  return { ...plan, semanticDeltas: [...plan.semanticDeltas.filter((item) => item.leaseId !== leaseId), normalized], updatedAt: normalized.recordedAt };
}

export function recordExecutionDecision(plan: PlanDocument, question: string, decision: string, rationale: string, references: string[]): PlanDocument {
  const text = decision.trim();
  const why = rationale.trim();
  if (!question.trim() || !text || !why) throw new Error("question, decision, and rationale are required");
  const recordedAt = new Date().toISOString();
  const semanticDeltas = plan.semanticDeltas.map((delta) => ({
    ...delta,
    userDecisionNeeded: delta.userDecisionNeeded.filter((item) => item !== question.trim()),
  }));
  semanticDeltas.push({
    leaseId: `decision-${contentHash({ question, text, why }).slice(0, 12)}`,
    accomplished: [], architectureChanges: [],
    decisions: [{ text, rationale: why, references: cleanList(references) }],
    invalidatedAssumptions: [], planDeviations: [], newRisks: [], userDecisionNeeded: [], recordedAt,
  });
  return { ...plan, semanticDeltas, updatedAt: recordedAt };
}

export function importWorkerOutput(plan: PlanDocument, lease: ExecutionLease, attemptId: string, output: WorkerOutput, actualChangedPaths: string[]): PlanDocument {
  if (output.leaseId !== lease.id || output.attemptId !== attemptId || output.planHash !== lease.planHash || output.planHash !== plan.specHash) throw new Error("worker output has stale execution identity");
  if (JSON.stringify(output.taskIds) !== JSON.stringify(lease.taskIds)) throw new Error("worker output task IDs do not match the lease");
  if (output.status === "blocked") throw new Error(output.blocker?.trim() || "worker reported a blocker");
  const expected = plan.tasks.filter((task) => lease.taskIds.includes(task.id));
  if (expected.length !== lease.taskIds.length || expected.some((task) => task.status === "completed")) throw new Error("lease tasks are no longer active");
  const allowedPaths = expected.flatMap((task) => task.expectedPaths);
  const outside = actualChangedPaths.filter((changed) => !allowedPaths.some((allowed) => changed === allowed || changed.startsWith(`${allowed}/`)));
  if (outside.length > 0) throw new Error(`worker modified paths outside the lease: ${outside.join(", ")}`);
  const withDelta = recordSemanticDelta(plan, lease.id, output.semanticDelta);
  return {
    ...withDelta,
    tasks: withDelta.tasks.map((task) => lease.taskIds.includes(task.id) ? { ...task, status: "implemented" } : task),
    updatedAt: new Date().toISOString(),
  };
}

export function completeLease(plan: PlanDocument, lease: ExecutionLease, receipts: CheckReceipt[]): PlanDocument {
  const tasks = plan.tasks.filter((task) => lease.taskIds.includes(task.id));
  if (tasks.length !== lease.taskIds.length || tasks.some((task) => task.status !== "implemented")) throw new Error("lease tasks are not implemented");
  const required = [...tasks.flatMap((task) => task.workerChecks), ...tasks.flatMap((task) => task.waveChecks)];
  for (const check of required) {
    const receipt = receipts.find((item) => item.id === check.id);
    if (!receipt || receipt.exitCode !== 0) throw new Error(`check ${check.id} has not passed`);
  }
  const completedAt = new Date().toISOString();
  return {
    ...plan,
    tasks: plan.tasks.map((task) => lease.taskIds.includes(task.id) ? { ...task, status: "completed", completedAt } : task),
    updatedAt: completedAt,
  };
}

export function renderStrategicContext(plan: PlanDocument): string {
  const list = (values: string[]) => cleanList(values).map((item) => `- ${item}`).join("\n") || "- none";
  const decisions = plan.decisions.map((item) => `- ${item.id}: ${item.text} — ${item.rationale}`);
  const architecture = plan.architecture.map((item) => `- ${item.fact} (${item.references.join(", ")})`);
  const executionDecisions = plan.semanticDeltas.flatMap((delta) => delta.decisions.map((item) => `- ${item.text} — ${item.rationale} (${item.references.join(", ") || "runtime discovery"})`));
  const executionArchitecture = plan.semanticDeltas.flatMap((delta) => delta.architectureChanges.map((item) => `- ${item.fact} — ${item.rationale} (${item.references.join(", ") || "runtime discovery"})`));
  const outcomes = plan.semanticDeltas.flatMap((delta) => delta.accomplished);
  const invalidated = plan.semanticDeltas.flatMap((delta) => delta.invalidatedAssumptions);
  const deviations = plan.semanticDeltas.flatMap((delta) => delta.planDeviations);
  const risks = [...plan.risks, ...plan.semanticDeltas.flatMap((delta) => delta.newRisks)];
  const decisionsNeeded = plan.semanticDeltas.flatMap((delta) => delta.userDecisionNeeded);
  const requirements = plan.requirements.map((item) => `${item.id}: ${item.text}`);
  const evidence = plan.repositoryEvidence.map((item) => `${item.claim} (${item.references.join(", ")})`);
  return `Goal: ${plan.goal}\nRequirements:\n${list(requirements)}\nConstraints:\n${list(plan.constraints)}\nOut of scope:\n${list(plan.outOfScope)}\nAssumptions:\n${list(plan.assumptions)}\nRepository evidence:\n${list(evidence)}\nApproved decisions:\n${decisions.join("\n") || "- none"}\nApproved architecture:\n${architecture.join("\n") || "- none"}\nExecution decisions:\n${executionDecisions.join("\n") || "- none"}\nExecution architecture discoveries:\n${executionArchitecture.join("\n") || "- none"}\nCompleted semantic outcomes:\n${list(outcomes)}\nInvalidated assumptions:\n${list(invalidated)}\nPlan deviations:\n${list(deviations)}\nRisks:\n${list(risks)}\nUser decisions needed:\n${list(decisionsNeeded)}`;
}

export function renderSemanticDelta(delta: SemanticDelta): string {
  const section = (title: string, values: string[]) => values.length > 0 ? `${title}:\n${values.map((item) => `- ${item}`).join("\n")}` : "";
  return [
    section("Accomplished", delta.accomplished),
    section("Architecture changes", delta.architectureChanges.map((item) => `${item.fact} — ${item.rationale} (${item.references.join(", ")})`)),
    section("Decisions", delta.decisions.map((item) => `${item.text} — ${item.rationale} (${item.references.join(", ")})`)),
    section("Invalidated assumptions", delta.invalidatedAssumptions),
    section("Plan deviations", delta.planDeviations),
    section("New risks", delta.newRisks),
    section("User decisions needed", delta.userDecisionNeeded),
  ].filter(Boolean).join("\n") || "No strategic context changes.";
}

export function renderPlanMarkdown(plan: PlanDocument): string {
  const tasks = plan.tasks.map((task) => {
    const mark = task.status === "completed" ? "x" : " ";
    const checks = [...task.workerChecks.map((check) => `worker:${check.id} \`${[check.program, ...check.args].join(" ")}\``), ...task.waveChecks.map((check) => `wave:${check.id} \`${[check.program, ...check.args].join(" ")}\``)].join("; ");
    return `- [${mark}] ${task.id}. ${task.title}\n  - Outcome: ${task.outcome}\n  - Requirements: ${task.satisfies.join(", ")}\n  - Depends on: ${task.dependsOn.join(", ") || "none"}\n  - Expected paths: ${task.expectedPaths.join(", ")}\n  - Acceptance: ${task.acceptance.join("; ")}\n  - Checks: ${checks}`;
  }).join("\n");
  return `# ${plan.title}\n\nGoal: ${plan.goal}\n\nSpec hash: \`${plan.specHash}\`\n\n## Strategic Context\n\n${renderStrategicContext(plan)}\n\n## Tasks\n\n${tasks}\n\n## Final Checks\n\n${plan.finalChecks.map((check) => `- ${check.id}: \`${[check.program, ...check.args].join(" ")}\``).join("\n")}\n\n## Momus\n\nVerdict: ${plan.momus.verdict}\n`;
}

export function workPaths(root: string) {
  const workDir = path.join(root, ".pi", "work");
  return {
    workDir,
    briefsDir: path.join(workDir, "briefs"),
    plansDir: path.join(workDir, "plans"),
    evidenceDir: path.join(workDir, "evidence"),
    statePath: path.join(workDir, "state.json"),
    runtimePath: path.join(workDir, "runtime.json"),
    lockPath: path.join(workDir, ".lock"),
  };
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filePath);
}

async function processStartId(pid: number): Promise<string | undefined> {
  try { return (await fs.readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[21]; }
  catch { return undefined; }
}

async function staleLock(lockPath: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: number; host?: string; processStartId?: string };
    if (!Number.isInteger(lock.pid) || lock.host !== os.hostname()) return false;
    try { process.kill(lock.pid!, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    const currentStart = await processStartId(lock.pid!);
    return Boolean(lock.processStartId && currentStart && lock.processStartId !== currentStart);
  } catch {
    try { return Date.now() - (await fs.stat(lockPath)).mtimeMs > 30_000; }
    catch { return false; }
  }
}

export async function withWorkLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const { workDir, lockPath } = workPaths(root);
  await fs.mkdir(workDir, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await fs.open(lockPath, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && await staleLock(lockPath)) {
        const quarantine = `${lockPath}.stale.${randomUUID()}`;
        try { await fs.rename(lockPath, quarantine); await fs.rm(quarantine, { force: true }); continue; }
        catch (renameError) { if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue; }
      }
      throw new Error("Plan -> Execute state is locked by another live or unidentifiable operation");
    }
  }
  if (!handle) throw new Error("failed to acquire Plan -> Execute state lock");
  const token = randomUUID();
  await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), processStartId: await processStartId(process.pid), createdAt: new Date().toISOString(), token }));
  try {
    return await fn();
  } finally {
    await handle.close();
    try {
      const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: string };
      if (current.token === token) await fs.rm(lockPath, { force: true });
    } catch { /* Never remove a replacement lock owned by another process. */ }
  }
}

function assertBrief(value: PlanningBrief): PlanningBrief {
  if (value.version !== 2 || !value.slug || !value.briefHash || !Array.isArray(value.requirements) || value.requirements.length === 0 || !Array.isArray(value.decisions) || !value.metis) {
    throw new Error("invalid Planning Brief");
  }
  if (!(value.metis.readiness === "pending" || value.metis.readiness === "ready" || value.metis.readiness === "blocked")) throw new Error("invalid Metis readiness");
  const { metis: _metis, revision: _revision, briefHash: _hash, version: _version, slug: _slug, createdAt: _created, updatedAt: _updated, ...spec } = value;
  if (contentHash(spec) !== value.briefHash) throw new Error("Planning Brief hash mismatch");
  return value;
}

function assertPlan(value: PlanDocument): PlanDocument {
  if (value.version !== 2 || !value.slug || !value.specHash || !Array.isArray(value.tasks) || value.tasks.length === 0 || !Array.isArray(value.finalChecks) || !value.momus) {
    throw new Error("invalid Plan document");
  }
  const ids = new Set(value.tasks.map((task) => task.id));
  if (ids.size !== value.tasks.length) throw new Error("Plan contains duplicate task IDs");
  for (const task of value.tasks) {
    if (!(task.status === "pending" || task.status === "implemented" || task.status === "completed")) throw new Error(`invalid status for ${task.id}`);
    if (!Array.isArray(task.expectedPaths) || !Array.isArray(task.workerChecks) || task.workerChecks.length === 0) throw new Error(`invalid task ${task.id}`);
    if (task.dependsOn.some((dependency) => !ids.has(dependency))) throw new Error(`${task.id} has an unknown dependency`);
  }
  if (contentHash(planSpec(value)) !== value.specHash) throw new Error("Plan spec hash mismatch");
  return value;
}

export async function writeBrief(root: string, brief: PlanningBrief): Promise<{ jsonPath: string }> {
  const jsonPath = path.join(workPaths(root).briefsDir, `${brief.slug}.json`);
  await atomicWrite(jsonPath, brief);
  return { jsonPath };
}

export async function readBrief(root: string, slug: string): Promise<PlanningBrief> {
  const parsed = JSON.parse(await fs.readFile(path.join(workPaths(root).briefsDir, `${slugify(slug)}.json`), "utf8")) as PlanningBrief;
  return assertBrief(parsed);
}

export async function writePlan(root: string, plan: PlanDocument): Promise<{ jsonPath: string; markdownPath: string }> {
  const paths = workPaths(root);
  const jsonPath = path.join(paths.plansDir, `${plan.slug}.json`);
  const markdownPath = path.join(paths.plansDir, `${plan.slug}.md`);
  await atomicWrite(jsonPath, plan);
  await fs.writeFile(markdownPath, renderPlanMarkdown(plan));
  return { jsonPath, markdownPath };
}

export async function readPlan(root: string, slug: string): Promise<PlanDocument> {
  const parsed = JSON.parse(await fs.readFile(path.join(workPaths(root).plansDir, `${slugify(slug)}.json`), "utf8")) as PlanDocument;
  return assertPlan(parsed);
}

export async function listPlans(root: string): Promise<PlanDocument[]> {
  const { plansDir } = workPaths(root);
  const entries = await fs.readdir(plansDir).catch(() => [] as string[]);
  const plans: PlanDocument[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    try { plans.push(await readPlan(root, entry.slice(0, -5))); }
    catch { /* Ignore legacy or malformed plans during discovery; explicit reads still report the error. */ }
  }
  return plans;
}

export async function writeRuntime(root: string, plan: PlanDocument, state: WorkState): Promise<void> {
  const checkpoint: RuntimeCheckpoint = { version: 2, plan, state, writtenAt: new Date().toISOString() };
  await atomicWrite(workPaths(root).runtimePath, checkpoint);
  await writePlan(root, plan);
  await writeWorkState(root, state);
}

function assertWorkState(value: WorkState, plan?: PlanDocument): WorkState {
  if (value.version !== 2 || !value.planSlug || !value.planHash || !Number.isInteger(value.generation) || value.generation < 0 || !(["planned", "active", "paused", "completed", "stopped", "abandoned"] as unknown[]).includes(value.status) || !(["dispatch", "verify"] as unknown[]).includes(value.stage) || !Array.isArray(value.receipts)) throw new Error("invalid work state");
  if (plan && (value.planSlug !== plan.slug || value.planHash !== plan.specHash)) throw new Error("runtime checkpoint identity mismatch");
  if (["active", "paused", "stopped"].includes(value.status) && !value.lease) throw new Error("nonterminal execution is missing its lease");
  if (value.stage === "verify" && (!value.lease || plan?.tasks.filter((task) => value.lease!.taskIds.includes(task.id)).some((task) => task.status !== "implemented"))) throw new Error("verify state does not match implemented lease tasks");
  if (value.workerAttempt && (!value.lease || value.workerAttempt.number < 1 || !/^[a-zA-Z0-9-]+$/.test(value.workerAttempt.id) || !["reserved", "running", "unresolved", "terminal"].includes(value.workerAttempt.status) || !value.workerAttempt.startedAt || (value.workerAttempt.status === "terminal" && !value.workerAttempt.endedAt))) throw new Error("worker attempt is invalid");
  if (value.verificationAttempt && (!/^[a-zA-Z0-9-]+$/.test(value.verificationAttempt.id) || !["running", "terminal"].includes(value.verificationAttempt.status) || !value.verificationAttempt.startedAt)) throw new Error("verification attempt is invalid");
  return value;
}

export async function readRuntime(root: string): Promise<RuntimeCheckpoint | undefined> {
  try {
    const checkpoint = JSON.parse(await fs.readFile(workPaths(root).runtimePath, "utf8")) as RuntimeCheckpoint;
    if (checkpoint.version !== 2 || !checkpoint.plan || !checkpoint.state) throw new Error("invalid runtime checkpoint");
    const plan = assertPlan(checkpoint.plan);
    const state = assertWorkState(checkpoint.state, plan);
    return { ...checkpoint, plan, state };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeWorkState(root: string, state: WorkState): Promise<void> {
  await atomicWrite(workPaths(root).statePath, state);
}

export async function readWorkState(root: string): Promise<WorkState | undefined> {
  try {
    const state = JSON.parse(await fs.readFile(workPaths(root).statePath, "utf8")) as WorkState;
    return assertWorkState(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
