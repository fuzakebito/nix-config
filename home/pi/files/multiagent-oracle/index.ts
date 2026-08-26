import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { asyncRunId, buildWorkflowScript, spawnViaRpc, waitForAsyncCompletion } from "./core.ts";

async function launch(pi: ExtensionAPI, target: string, ctx: ExtensionContext, signal?: AbortSignal) {
  const data = await spawnViaRpc(pi.events, {
    workflowScript: buildWorkflowScript(target),
    async: true,
    context: "fresh",
    mission: false,
    intercomBridge: { mode: "off" },
    cwd: ctx.cwd,
  });
  const runId = asyncRunId(data);
  const output = await waitForAsyncCompletion(pi.events, runId, signal);
  return { runId, output };
}

export default function multiagentOracleExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "multiagent_oracle",
    label: "Multiagent Oracle",
    description: "Run a fixed multi-provider oracle workflow. TypeScript controls all fanout, dynamic Luna perspective selection, and staged synthesis; the call blocks until the final oracle result is ready.",
    promptSnippet: "Launch a model-diverse read-only oracle workflow for a concrete decision, proposal, or review target",
    promptGuidelines: [
      "Use multiagent_oracle when model-family diversity materially improves a difficult decision or review; call it once with the complete target and let the extension own all subagent orchestration.",
    ],
    parameters: Type.Object({
      target: Type.String({ minLength: 1, description: "Complete question or review target, including constraints, evidence paths, repository scope, and authority boundary." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await launch(pi, params.target, ctx, signal);
      return {
        content: [{ type: "text", text: result.output }],
        details: { runId: result.runId },
      };
    },
  });

  pi.registerCommand("multiagent-oracle", {
    description: "Ask the main agent to run the multi-provider oracle workflow",
    handler: async (args, ctx: ExtensionCommandContext) => {
      let target = args.trim();
      if (!target && ctx.hasUI) target = (await ctx.ui.editor("Multiagent oracle target", ""))?.trim() ?? "";
      if (!target) {
        ctx.ui.notify("Usage: /multiagent-oracle <target>", "error");
        return;
      }
      pi.sendUserMessage(
        "Call the multiagent_oracle tool exactly once with the complete target below. Wait for the blocking tool call to finish, then present its final oracle answer to me. Do not start unrelated work while it runs.\n\nTarget:\n" + target,
        { deliverAs: "followUp" },
      );
    },
  });
}
