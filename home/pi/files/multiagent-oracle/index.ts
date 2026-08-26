import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { asyncRunId, buildWorkflowScript, spawnViaRpc } from "./core.ts";

async function launch(pi: ExtensionAPI, target: string, ctx: ExtensionContext): Promise<string> {
  const data = await spawnViaRpc(pi.events, {
    workflowScript: buildWorkflowScript(target),
    async: true,
    context: "fresh",
    mission: false,
    cwd: ctx.cwd,
  });
  return asyncRunId(data);
}

export default function multiagentOracleExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "multiagent_oracle",
    label: "Multiagent Oracle",
    description: "Launch a fixed multi-provider oracle workflow. TypeScript controls all fanout, dynamic Luna perspective selection, and staged synthesis; the final oracle result is delivered asynchronously by pi-subagents.",
    promptSnippet: "Launch a model-diverse read-only oracle workflow for a concrete decision, proposal, or review target",
    promptGuidelines: [
      "Use multiagent_oracle when model-family diversity materially improves a difficult decision or review; call it once with the complete target and let the extension own all subagent orchestration.",
    ],
    parameters: Type.Object({
      target: Type.String({ minLength: 1, description: "Complete question or review target, including constraints, evidence paths, repository scope, and authority boundary." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runId = await launch(pi, params.target, ctx);
      return {
        content: [{ type: "text", text: `Multiagent oracle launched asynchronously: ${runId}. pi-subagents will deliver the final oracle result when the workflow completes.` }],
        details: { runId },
      };
    },
  });

  pi.registerCommand("multiagent-oracle", {
    description: "Launch the multi-provider oracle workflow",
    handler: async (args, ctx: ExtensionCommandContext) => {
      let target = args.trim();
      if (!target && ctx.hasUI) target = (await ctx.ui.editor("Multiagent oracle target", ""))?.trim() ?? "";
      if (!target) {
        ctx.ui.notify("Usage: /multiagent-oracle <target>", "error");
        return;
      }
      const runId = await launch(pi, target, ctx);
      ctx.ui.notify(`Multiagent oracle launched: ${runId}`, "info");
    },
  });
}
