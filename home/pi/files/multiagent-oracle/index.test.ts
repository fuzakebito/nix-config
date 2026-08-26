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
    expect(source).toContain("pi-subagents will deliver the final oracle result");
    expect(source).not.toContain("runs.all");
  });
});
