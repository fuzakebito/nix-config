import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface Perspective {
  key: string;
  title: string;
  instruction: string;
}

export const PERSPECTIVE_CATALOG = [
  "hidden assumptions and ambiguous requirements",
  "formal logic, contradictions, and minimal counterexamples",
  "system boundaries, coupling, and integration behavior",
  "second-order effects and feedback loops",
  "evidence quality, uncertainty, and falsifiability",
  "security, abuse cases, and privilege boundaries",
  "data loss, corruption, and recovery",
  "operational failure and observability",
  "performance, scaling, and resource ceilings",
  "reversibility, migration, and rollback",
  "maintenance burden and long-term drift",
  "simpler alternatives and accidental complexity",
  "opportunity cost and displaced work",
  "stakeholder impact and incentive alignment",
  "accessibility and excluded users",
  "privacy, compliance, and legal exposure",
  "concurrency, ordering, and partial failure",
  "compatibility and version skew",
  "human factors and likely misuse",
  "adversarial challenge to the expected consensus",
] as const;

export const PERSPECTIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["perspectives"],
  properties: {
    perspectives: {
      type: "array",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "instruction"],
        properties: {
          key: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" },
          title: { type: "string", minLength: 2, maxLength: 80 },
          instruction: { type: "string", minLength: 20, maxLength: 500 },
        },
      },
    },
  },
} as const;

const ORACLE_SECTIONS = `Return the normal oracle shape: Inherited decisions, Diagnosis, Drift / contradiction check, Recommendation, Risks, Need from main agent, and Suggested execution prompt.`;
const NO_ESCALATION = `This workflow is self-contained. Never call contact_supervisor, intercom, or any coordination/progress tool. Do not ask the main agent questions during execution. Resolve uncertainty from the supplied target and repository evidence; record any remaining uncertainty under Need from main agent in your final output. This rule overrides the generic oracle coordination instructions.`;

export function buildWorkflowScript(rawTarget: string): string {
  const target = rawTarget.trim();
  if (!target) throw new Error("Multiagent oracle target must not be empty.");

  return `
const target = ${JSON.stringify(target)};
const catalog = ${JSON.stringify(PERSPECTIVE_CATALOG)};
const perspectiveSchema = ${JSON.stringify(PERSPECTIVE_SCHEMA)};
const oracleSections = ${JSON.stringify(ORACLE_SECTIONS)};
const noEscalation = ${JSON.stringify(NO_ESCALATION)};
function workflowTask(instruction) {
  return noEscalation + "\\n\\n" + instruction;
}
function oracleTask(emphasis) {
  return workflowTask("Analyze the target below as an independent read-only oracle. This fresh task is the authoritative contract. Inspect repository evidence directly when applicable; do not edit project/source files. Emphasis: " + emphasis + "\\n\\n" + oracleSections + "\\n\\nTarget:\\n" + target);
}
function renderResults(results) {
  return results.map(function (result) {
    return "## " + result.key + " [" + (result.ok ? "ok" : "failed") + "]\\n" + result.output;
  }).join("\\n\\n");
}
function normalizePerspective(item) {
  if (!item || typeof item !== "object") return null;
  const key = typeof item.key === "string" ? item.key.trim() : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const instruction = typeof item.instruction === "string" ? item.instruction.trim() : "";
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(key)) return null;
  if (title.length < 2 || title.length > 80) return null;
  if (instruction.length < 20 || instruction.length > 500) return null;
  return { key: key, title: title, instruction: instruction };
}
const independentPromise = runs.all([
  { key: "oracle-sol", agent: "oracle", model: "openai-codex/gpt-5.6-sol", thinking: "max", context: "fresh", task: oracleTask("first-principles derivation and internal consistency") },
  { key: "oracle-fable", agent: "oracle", model: "anthropic/claude-fable-5", thinking: "max", context: "fresh", task: oracleTask("intent, ambiguity, human constraints, and reframing") },
  { key: "oracle-gemini", agent: "oracle", model: "openrouter/google/gemini-3.7-flash", thinking: "high", context: "fresh", task: oracleTask("broad hypothesis search and cross-domain interactions") },
  { key: "oracle-kimi", agent: "oracle", model: "openrouter/moonshotai/kimi-k3", thinking: "high", context: "fresh", task: oracleTask("causal chains, long-horizon effects, and hidden dependencies") },
  { key: "oracle-grok", agent: "oracle", model: "openrouter/x-ai/grok-4.6", thinking: "high", context: "fresh", task: oracleTask("adversarial challenge, counterexamples, and uncomfortable failure modes") },
  { key: "oracle-glm", agent: "oracle", model: "openrouter/z-ai/glm-5.3", thinking: "high", context: "fresh", task: oracleTask("alternative decomposition and an independent model-family check") }
]);
let planner = await runs.run("perspective-planner", {
  agent: "oracle",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "max",
  context: "fresh",
  task: workflowTask("Select 6-8 distinct, task-specific reasoning perspectives for GPT-5.6 Luna oracle calls. Select, adapt, combine, or replace catalog examples; invent a better perspective when the target warrants it. Avoid overlapping generic labels. Each instruction must identify a concrete question or failure class for this target. Use the required structured output only; this task-specific contract overrides the oracle prose format.\\n\\nCatalog:\\n" + catalog.map(function (item) { return "- " + item; }).join("\\n") + "\\n\\nTarget:\\n" + target),
  outputSchema: perspectiveSchema
});
function validatePlanner(result) {
  const errors = [];
  if (!result.ok) errors.push("planner run failed: " + (result.error || result.output));
  const candidates = result.structuredOutput && Array.isArray(result.structuredOutput.perspectives)
    ? result.structuredOutput.perspectives
    : null;
  if (!candidates) return { perspectives: [], errors: errors.concat(["structured output must contain a perspectives array"]) };
  if (candidates.length < 6 || candidates.length > 8) errors.push("perspectives must contain 6-8 items; received " + candidates.length);
  const perspectives = [];
  const usedKeys = new Set();
  for (let index = 0; index < candidates.length; index++) {
    const normalized = normalizePerspective(candidates[index]);
    if (!normalized) {
      errors.push("perspectives[" + index + "] has an invalid key, title, or instruction");
      continue;
    }
    if (usedKeys.has(normalized.key)) {
      errors.push("duplicate perspective key: " + normalized.key);
      continue;
    }
    usedKeys.add(normalized.key);
    perspectives.push(normalized);
  }
  return { perspectives: perspectives, errors: errors };
}
let selection = validatePlanner(planner);
for (let revision = 1; selection.errors.length > 0 && revision <= 2; revision++) {
  if (!planner.runId) throw new Error("Perspective planner output was rejected but cannot be returned for revision: " + selection.errors.join("; "));
  planner = await runs.run("perspective-revision-" + revision, {
    resume: planner.runId,
    task: workflowTask("Your perspective selection was rejected. Correct every validation error and resubmit the complete structured output only. Do not defend the previous output.\\n\\nValidation errors:\\n- " + selection.errors.join("\\n- "))
  });
  selection = validatePlanner(planner);
}
if (selection.errors.length > 0) {
  throw new Error("Perspective planner output remained invalid after two revision requests: " + selection.errors.join("; "));
}
const perspectives = selection.perspectives;
const lunaResults = await runs.all(perspectives.map(function (perspective) {
  return {
    key: "luna-" + perspective.key,
    agent: "oracle",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "max",
    context: "fresh",
    task: oracleTask(perspective.title + ": " + perspective.instruction)
  };
}));
const lunaSynthesis = await runs.run("luna-synthesis", {
  agent: "oracle",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "max",
  context: "fresh",
  task: workflowTask("Synthesize the GPT-5.6 Luna oracle results below into one read-only oracle recommendation. Treat convergence as correlated evidence from one model family, not independent votes. Preserve material dissent, identify failed lanes, and return exactly the normal oracle shape. Do not expose orchestration narration.\\n\\nTarget:\\n" + target + "\\n\\nLuna results:\\n" + renderResults(lunaResults))
});
const independentResults = await independentPromise;
const finalSynthesis = await runs.run("final-synthesis", {
  agent: "oracle",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "max",
  context: "fresh",
  task: workflowTask("Produce the final multi-provider oracle recommendation from the advisory results below. Judge evidence and reasoning rather than vote count. Preserve material dissent and what would resolve it. Treat the Luna synthesis as one correlated OpenAI-family lane; also account for correlation between this synthesizer and oracle-sol. Name failed lanes under Risks and mark validation degraded when any lane failed. Return only the normal oracle shape with no raw transcripts or orchestration narration.\\n\\nTarget:\\n" + target + "\\n\\nIndependent oracle results:\\n" + renderResults(independentResults) + "\\n\\nLuna synthesis [" + (lunaSynthesis.ok ? "ok" : "failed") + "]:\\n" + lunaSynthesis.output)
});
return finalSynthesis.output;
`.trim();
}

interface RpcEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

type RpcReply =
  | { version: 1; requestId: string; success: true; data: unknown }
  | { version: 1; requestId: string; success: false; error: { code: string; message: string } };

export function spawnViaRpc(events: RpcEventBus, params: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = events.on(`subagents:rpc:v1:reply:${requestId}`, (raw) => {
      const reply = raw as RpcReply;
      if (!reply || reply.version !== 1 || reply.requestId !== requestId || settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (reply.success) resolve(reply.data);
      else reject(new Error(`pi-subagents RPC ${reply.error.code}: ${reply.error.message}`));
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error("pi-subagents RPC spawn timed out; confirm the pi-subagents extension is loaded."));
    }, timeoutMs);
    timer.unref?.();
    events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "spawn", params });
  });
}

export function asyncRunId(data: unknown): string {
  if (!data || typeof data !== "object") throw new Error("pi-subagents RPC returned an invalid spawn response.");
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== "object") throw new Error("pi-subagents RPC spawn response did not include details.");
  const id = (details as { asyncId?: unknown; runId?: unknown }).asyncId ?? (details as { runId?: unknown }).runId;
  if (typeof id !== "string" || !id) throw new Error("pi-subagents RPC spawn response did not include an async run id.");
  return id;
}

interface CompletionEvent {
  runId?: unknown;
  id?: unknown;
  state?: unknown;
  success?: unknown;
  archivePath?: unknown;
  workflow?: unknown;
  output?: unknown;
  finalOutput?: unknown;
  error?: unknown;
}

async function completionText(event: CompletionEvent): Promise<string> {
  if (event.workflow && typeof event.workflow === "object") {
    const value = (event.workflow as { value?: unknown }).value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (typeof event.archivePath === "string" && event.archivePath) {
    const archive = JSON.parse(await readFile(event.archivePath, "utf8")) as { entries?: Array<{ path?: unknown; text?: unknown; truncated?: unknown }> };
    for (const entry of archive.entries ?? []) {
      if (typeof entry.path !== "string" || !entry.path) continue;
      const text = (await readFile(entry.path, "utf8")).trim();
      if (text) return text;
    }
    const text = archive.entries?.map((entry) => typeof entry.text === "string" ? entry.text.trim() : "").filter(Boolean).join("\n\n");
    if (text && !archive.entries?.some((entry) => entry.truncated === true)) return text;
  }
  if (typeof event.finalOutput === "string" && event.finalOutput.trim()) return event.finalOutput.trim();
  if (event.success === false && typeof event.error === "string" && event.error) return event.error;
  throw new Error("Multiagent oracle completed, but its full workflow return value was unavailable; refusing to return a truncated completion preview.");
}

export function waitForAsyncCompletion(
  events: RpcEventBus,
  runId: string,
  signal?: AbortSignal,
  timeoutMs = 60 * 60 * 1000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(output ?? "");
    };
    const onAbort = () => finish(new Error("Multiagent oracle wait was cancelled."));
    const unsubscribe = events.on("subagent:async-complete", (raw) => {
      if (!raw || typeof raw !== "object") return;
      const event = raw as CompletionEvent;
      const id = event.runId ?? event.id;
      if (id !== runId) return;
      void completionText(event).then((output) => {
        if (event.success === false) finish(new Error(output));
        else finish(undefined, output);
      }, (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    timer = setTimeout(() => finish(new Error(`Multiagent oracle ${runId} did not complete within the wait timeout.`)), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
