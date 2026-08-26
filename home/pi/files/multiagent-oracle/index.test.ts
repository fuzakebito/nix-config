import { describe, expect, test } from "bun:test";

describe("multiagent oracle extension surface", () => {
  test("registers one tool and one command using the shared RPC launcher", async () => {
    const source = await Bun.file("home/pi/files/multiagent-oracle/index.ts").text();

    expect([...source.matchAll(/name: "([a-z_]+)",/g)].map((match) => match[1])).toEqual(["multiagent_oracle"]);
    expect([...source.matchAll(/registerCommand\("([a-z-]+)"/g)].map((match) => match[1])).toEqual(["multiagent-oracle"]);
    expect(source).toContain("spawnViaRpc(pi.events");
    expect(source).toContain("workflowScript: buildWorkflowScript(target)");
    expect(source).toContain('async: true');
    expect(source).toContain('context: "fresh"');
    expect(source).toContain('intercomBridge: { mode: "off" }');
    expect(source).toContain("waitForAsyncCompletion(pi.events, runId, signal)");
    expect(source).toContain("text: result.output");
    expect(source).toContain("pi.sendUserMessage(");
    expect(source).toContain("Call the multiagent_oracle tool exactly once");
    expect(source.match(/await launch\(/g)?.length).toBe(1);
    expect(source).not.toContain("launched asynchronously");
    expect(source).not.toContain("runs.all");
  });
});
