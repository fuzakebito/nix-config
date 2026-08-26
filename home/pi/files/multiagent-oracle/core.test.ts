import { describe, expect, test } from "bun:test";
import { asyncRunId, buildWorkflowScript, PERSPECTIVE_CATALOG, spawnViaRpc } from "./core.ts";

describe("multiagent oracle workflow", () => {
  test("builds extension-owned staged oracle orchestration", () => {
    const script = buildWorkflowScript("Review auth refresh behavior");

    expect(script).toContain('key: "perspective-planner"');
    expect(script.match(/agent: "oracle"/g)?.length).toBeGreaterThanOrEqual(10);
    expect(script).toContain('model: "openai-codex/gpt-5.6-luna"');
    expect(script).toContain('runs.run("luna-synthesis"');
    expect(script).toContain('runs.run("final-synthesis"');
    expect(script).toContain('resume: planner.runId');
    expect(script).toContain('"perspective-revision-" + revision');
    expect(script).toContain("remained invalid after two revision requests");
    expect(script).toContain("return finalSynthesis.output");
    expect(script).not.toContain('agent: "multiagent-oracle"');
    expect(script).not.toContain('agent: "luna-oracle"');
  });

  test("ships a broad catalog without a fixed-output fallback", () => {
    expect(PERSPECTIVE_CATALOG.length).toBeGreaterThanOrEqual(16);
    const script = buildWorkflowScript("Review X");
    expect(script).not.toContain("const fallback");
    expect(script).not.toContain("FALLBACK_PERSPECTIVES");
  });

  test("escapes the target as workflow data", () => {
    const target = 'Review `x`\n"quoted" ${notCode}';
    const script = buildWorkflowScript(target);
    expect(script).toContain(JSON.stringify(target));
    expect(() => buildWorkflowScript("  ")).toThrow("must not be empty");
  });

  test("launches through the pi-subagents RPC event bus", async () => {
    const handlers = new Map<string, Set<(data: unknown) => void>>();
    let request: any;
    const events = {
      on(channel: string, handler: (data: unknown) => void) {
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => set.delete(handler);
      },
      emit(channel: string, data: any) {
        if (channel === "subagents:rpc:v1:request") {
          request = data;
          queueMicrotask(() => events.emit(`subagents:rpc:v1:reply:${data.requestId}`, {
            version: 1,
            requestId: data.requestId,
            success: true,
            data: { details: { asyncId: "run-rpc" } },
          }));
        }
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
    };
    const result = await spawnViaRpc(events, { workflowScript: "return 1", async: true });
    expect(request).toMatchObject({ version: 1, method: "spawn", params: { async: true } });
    expect(asyncRunId(result)).toBe("run-rpc");
  });

  test("extracts async run identity from RPC details", () => {
    expect(asyncRunId({ details: { asyncId: "run-1" } })).toBe("run-1");
    expect(asyncRunId({ details: { runId: "run-2" } })).toBe("run-2");
    expect(() => asyncRunId({ details: {} })).toThrow("async run id");
  });
});
