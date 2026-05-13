import { defineCommand } from "citty";
import { runRepl } from "../chat/repl.ts";
import { withErrors } from "../util/cli.ts";

export const chatCmd = defineCommand({
  meta: {
    name: "chat",
    description: "Open a conversational REPL with memory access (Anthropic-backed)",
  },
  args: {
    model: { type: "string", description: "Override default model (e.g. claude-sonnet-4-6)", default: "" },
    "max-tokens": { type: "string", description: "Max tokens per response", default: "" },
  },
  run: withErrors(async (args) => {
    const maxTokens = parseInt(args["max-tokens"] as string, 10);
    await runRepl({
      model: (args.model as string) || undefined,
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
    });
  }),
});
