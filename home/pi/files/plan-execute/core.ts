import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type PlanTaskKind = "implementation" | "verification";
export type PlanTaskStatus = "pending" | "completed";
export type ReviewVerdict = "pending" | "approved" | "rejected";
export type WorkStatus = "planned" | "active" | "paused" | "completed" | "stopped";

export interface PlanTask {
  id: string;
  title: string;
  details: string;
  references: string[];
  acceptance: string[];
  verification: string[];
  dependsOn: string[];
  wave: number;
  ownedPaths: string[];
  kind: PlanTaskKind;
  status: PlanTaskStatus;
  completedAt?: string;
}

export interface PlanDocument {
  version: 1;
  slug: string;
  title: string;
  goal: string;
  constraints: string[];
  outOfScope: string[];
  tasks: PlanTask[];
  analysis: string;
  revision: number;
  reviewToken: string;
  review: {
    verdict: ReviewVerdict;
    findings: string[];
    rounds: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WorkState {
  version: 1;
  planSlug: string;
  planPath: string;
  projectRoot: string;
  worktreePath: string;
  status: WorkStatus;
  currentTask?: string;
  currentWave?: number;
  waveToken?: string;
  waveBaseline: Record<string, string>;
  sessionIds: string[];
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  stopReason?: string;
}

export interface PlanReviewOutput {
  planPath: string;
  reviewToken: string;
  verdict: Exclude<ReviewVerdict, "pending">;
  findings: string[];
}

export interface CompletionEvidence {
  taskId: string;
  summary: string;
  commands: string[];
  artifact?: string;
  adversarialChecks: string[];
  cleanup: string[];
  timestamp: string;
}

const FINAL_TASKS: Array<Pick<PlanTask, "id" | "title" | "details">> = [
  { id: "F1", title: "Plan compliance audit", details: "Verify every planned requirement and constraint against the implementation." },
  { id: "F2", title: "Code quality review", details: "Review correctness, maintainability, tests, and repository conventions." },
  { id: "F3", title: "Real QA", details: "Run the user-visible workflow and preserve concrete evidence." },
  { id: "F4", title: "Scope fidelity check", details: "Confirm required scope is complete and unrelated changes were not introduced." },
];

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `plan-${Date.now()}`;
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function createPlan(input: {
  title: string;
  goal: string;
  constraints?: string[];
  outOfScope?: string[];
  analysis: string;
  tasks: Array<{
    title: string;
    details: string;
    references?: string[];
    acceptance: string[];
    verification: string[];
    dependsOn?: string[];
    wave: number;
    ownedPaths: string[];
  }>;
}, previous?: PlanDocument): PlanDocument {
  const title = input.title.trim();
  const goal = input.goal.trim();
  const analysis = input.analysis.trim();
  if (!title || !goal || !analysis) throw new Error("title, goal, and pre-plan analysis are required");
  if (input.tasks.length === 0) throw new Error("at least one implementation task is required");

  const implementationTasks: PlanTask[] = input.tasks.map((task, index) => {
    const id = String(index + 1);
    const acceptance = cleanList(task.acceptance);
    const verification = cleanList(task.verification);
    if (!task.title.trim() || !task.details.trim()) throw new Error(`task ${id} requires title and details`);
    if (acceptance.length === 0) throw new Error(`task ${id} requires acceptance criteria`);
    if (verification.length === 0) throw new Error(`task ${id} requires verification steps`);
    if (!Number.isInteger(task.wave) || task.wave < 1) throw new Error(`task ${id} requires a positive integer wave`);
    if (cleanList(task.ownedPaths).length === 0) throw new Error(`task ${id} requires at least one owned path`);
    return {
      id,
      title: task.title.trim(),
      details: task.details.trim(),
      references: cleanList(task.references),
      acceptance,
      verification,
      dependsOn: cleanList(task.dependsOn),
      wave: task.wave,
      ownedPaths: cleanList(task.ownedPaths).map((ownedPath) => ownedPath.replaceAll("\\", "/").replace(/\/+$/, "")),
      kind: "implementation",
      status: "pending",
    };
  });

  const implementationById = new Map(implementationTasks.map((task) => [task.id, task]));
  for (const task of implementationTasks) {
    for (const ownedPath of task.ownedPaths) {
      if (!ownedPath || ownedPath === "." || path.isAbsolute(ownedPath) || ownedPath.split("/").includes("..")) {
        throw new Error(`task ${task.id} has unsafe owned path ${ownedPath || "(empty)"}`);
      }
    }
    for (const dependency of task.dependsOn) {
      const dependencyTask = implementationById.get(dependency);
      if (!dependencyTask) throw new Error(`task ${task.id} has unknown dependency ${dependency}`);
      if (dependency === task.id) throw new Error(`task ${task.id} cannot depend on itself`);
      if (Number(dependency) >= Number(task.id)) throw new Error(`task ${task.id} must depend only on an earlier task`);
      if (dependencyTask.wave >= task.wave) throw new Error(`task ${task.id} must run in a later wave than dependency ${dependency}`);
    }
  }
  for (let leftIndex = 0; leftIndex < implementationTasks.length; leftIndex++) {
    const left = implementationTasks[leftIndex];
    for (const right of implementationTasks.slice(leftIndex + 1)) {
      if (left.wave !== right.wave) continue;
      for (const leftPath of left.ownedPaths) {
        for (const rightPath of right.ownedPaths) {
          if (leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`)) {
            throw new Error(`wave ${left.wave} has overlapping owned paths: ${leftPath} and ${rightPath}`);
          }
        }
      }
    }
  }

  const allImplementationIds = implementationTasks.map((task) => task.id);
  const finalWave = Math.max(...implementationTasks.map((task) => task.wave)) + 1;
  const verificationTasks: PlanTask[] = FINAL_TASKS.map((task) => ({
    ...task,
    references: [],
    acceptance: [`${task.title} returns PASS with concrete evidence`],
    verification: [task.details],
    dependsOn: [...allImplementationIds],
    wave: finalWave,
    ownedPaths: [],
    kind: "verification",
    status: "pending",
  }));

  const now = new Date().toISOString();
  return {
    version: 1,
    slug: previous?.slug ?? slugify(title),
    title,
    goal,
    constraints: cleanList(input.constraints),
    outOfScope: cleanList(input.outOfScope),
    tasks: [...implementationTasks, ...verificationTasks],
    analysis,
    revision: (previous?.revision ?? 0) + 1,
    reviewToken: randomUUID(),
    review: { verdict: "pending", findings: [], rounds: previous?.review.rounds ?? 0 },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export function parsePlanReviewOutput(output: string): PlanReviewOutput {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("reviewer output is not a JSON object");
  const parsed = JSON.parse(output.slice(start, end + 1)) as Partial<PlanReviewOutput>;
  if (!parsed.planPath?.trim()) throw new Error("reviewer output is missing planPath");
  if (!parsed.reviewToken?.trim()) throw new Error("reviewer output is missing reviewToken");
  if (!(["approved", "rejected"] as unknown[]).includes(parsed.verdict)) throw new Error("reviewer output has invalid verdict");
  if (!Array.isArray(parsed.findings) || parsed.findings.some((finding) => typeof finding !== "string")) {
    throw new Error("reviewer output has invalid findings");
  }
  if (parsed.verdict === "rejected" && parsed.findings.length === 0) throw new Error("a rejected review requires findings");
  return parsed as PlanReviewOutput;
}

export function reviewPlan(plan: PlanDocument, verdict: Exclude<ReviewVerdict, "pending">, findings: string[]): PlanDocument {
  const cleaned = cleanList(findings);
  if (verdict === "rejected" && cleaned.length === 0) throw new Error("a rejected plan requires findings");
  return {
    ...plan,
    review: { verdict, findings: cleaned, rounds: plan.review.rounds + 1 },
    updatedAt: new Date().toISOString(),
  };
}

export function getProgress(plan: PlanDocument): { completed: number; total: number; remaining: number } {
  const completed = plan.tasks.filter((task) => task.status === "completed").length;
  return { completed, total: plan.tasks.length, remaining: plan.tasks.length - completed };
}

export function getReadyWave(plan: PlanDocument): PlanTask[] {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  const ready = plan.tasks.filter(
    (task) => task.status === "pending" && task.dependsOn.every((dependency) => completed.has(dependency)),
  );
  if (ready.length === 0) return [];
  const wave = Math.min(...ready.map((task) => task.wave));
  return ready.filter((task) => task.wave === wave);
}

export function getNextTask(plan: PlanDocument): PlanTask | undefined {
  return getReadyWave(plan)[0];
}

export function completeTask(plan: PlanDocument, evidence: CompletionEvidence): PlanDocument {
  const task = plan.tasks.find((candidate) => candidate.id === evidence.taskId);
  if (!task) throw new Error(`unknown task ${evidence.taskId}`);
  if (task.status === "completed") throw new Error(`task ${task.id} is already completed`);
  const ready = getReadyWave(plan);
  if (!ready.some((candidate) => candidate.id === task.id)) {
    throw new Error(`task ${task.id} is blocked; ready wave contains ${ready.map((candidate) => candidate.id).join(", ") || "none"}`);
  }
  if (!evidence.summary.trim()) throw new Error("completion summary is required");
  if (cleanList(evidence.commands).length === 0) throw new Error("at least one verification command or check is required");
  if (!evidence.artifact?.trim()) throw new Error("a QA or review artifact is required");
  if (cleanList(evidence.adversarialChecks).length === 0) throw new Error("at least one adversarial check is required");
  if (cleanList(evidence.cleanup).length === 0) throw new Error("cleanup receipts are required; use 'none required' when applicable");

  const tasks = plan.tasks.map((candidate) =>
    candidate.id === task.id ? { ...candidate, status: "completed" as const, completedAt: evidence.timestamp } : candidate,
  );
  return { ...plan, tasks, updatedAt: evidence.timestamp };
}

export function renderPlanMarkdown(plan: PlanDocument): string {
  const renderList = (values: string[], empty: string) => values.map((value) => `- ${value}`).join("\n") || `- ${empty}`;
  const renderTask = (task: PlanTask) => {
    const check = task.status === "completed" ? "x" : " ";
    const lines = [`- [${check}] ${task.id}. ${task.title}`, `  - Wave: ${task.wave}`, `  - What: ${task.details}`];
    if (task.ownedPaths.length > 0) lines.push(`  - Owns: ${task.ownedPaths.join(", ")}`);
    if (task.dependsOn.length > 0) lines.push(`  - Depends on: ${task.dependsOn.join(", ")}`);
    for (const reference of task.references) lines.push(`  - Reference: ${reference}`);
    for (const criterion of task.acceptance) lines.push(`  - Acceptance: ${criterion}`);
    for (const verification of task.verification) lines.push(`  - Verify: ${verification}`);
    return lines.join("\n");
  };

  const implementation = plan.tasks.filter((task) => task.kind === "implementation").map(renderTask).join("\n\n");
  const verification = plan.tasks.filter((task) => task.kind === "verification").map(renderTask).join("\n\n");
  return `<!-- Generated from ${plan.slug}.json by the Plan -> Execute extension. Edit through /plan, not by hand. -->\n\n# Plan: ${plan.title}\n\n- Revision: ${plan.revision}\n\n## Goal\n${plan.goal}\n\n## Constraints\n${renderList(plan.constraints, "None")}\n\n## Out of Scope\n${renderList(plan.outOfScope, "None")}\n\n## Pre-plan Analysis\n${plan.analysis}\n\n## TODOs\n${implementation}\n\n## Final Verification Wave\n${verification}\n\n## Review\n- Verdict: ${plan.review.verdict}\n- Rounds: ${plan.review.rounds}\n${renderList(plan.review.findings, "No findings recorded")}\n`;
}

export function workPaths(root: string) {
  const workDir = path.join(root, ".pi", "work");
  return {
    workDir,
    plansDir: path.join(workDir, "plans"),
    statePath: path.join(workDir, "state.json"),
    ledgerPath: path.join(workDir, "ledger.jsonl"),
    evidenceDir: path.join(workDir, "evidence"),
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export async function withWorkLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(workPaths(root).workDir, "mutation.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(await fs.readFile(lockPath, "utf8").catch(() => ""), 10);
      let alive = Number.isFinite(owner);
      if (alive) {
        try {
          process.kill(owner, 0);
        } catch {
          alive = false;
        }
      }
      if (alive || attempt > 0) throw new Error("Plan -> Execute state is being updated by another process");
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
  if (!handle) throw new Error("failed to acquire Plan -> Execute mutation lock");
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export async function writePlan(root: string, plan: PlanDocument): Promise<{ jsonPath: string; markdownPath: string }> {
  const { plansDir } = workPaths(root);
  const jsonPath = path.join(plansDir, `${plan.slug}.json`);
  const markdownPath = path.join(plansDir, `${plan.slug}.md`);
  await atomicWrite(jsonPath, `${JSON.stringify(plan, null, 2)}\n`);
  await atomicWrite(markdownPath, renderPlanMarkdown(plan));
  return { jsonPath, markdownPath };
}

export async function readPlan(root: string, slug: string): Promise<PlanDocument> {
  const filePath = path.join(workPaths(root).plansDir, `${slugify(slug)}.json`);
  const plan = JSON.parse(await fs.readFile(filePath, "utf8")) as PlanDocument;
  if (plan.version !== 1 || plan.slug !== slugify(slug) || !Array.isArray(plan.tasks)) throw new Error(`invalid plan ${slug}`);
  plan.revision ??= 1;
  plan.reviewToken ??= plan.updatedAt;
  return plan;
}

export async function listPlans(root: string): Promise<PlanDocument[]> {
  const { plansDir } = workPaths(root);
  let names: string[];
  try {
    names = await fs.readdir(plansDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const plans = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readPlan(root, name.slice(0, -5))),
  );
  return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function writeWorkState(root: string, state: WorkState): Promise<void> {
  await atomicWrite(workPaths(root).statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function readWorkState(root: string): Promise<WorkState | undefined> {
  try {
    const state = JSON.parse(await fs.readFile(workPaths(root).statePath, "utf8")) as WorkState;
    if (state.version !== 1 || !state.planSlug || !state.projectRoot) throw new Error("invalid work state");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function appendLedger(root: string, record: CompletionEvidence & { planSlug: string; sessionId?: string }): Promise<void> {
  const { ledgerPath } = workPaths(root);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
