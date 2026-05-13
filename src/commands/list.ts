import { defineCommand } from "citty";
import { listMemories } from "../db.ts";
import { loadConfig } from "../config.ts";
import { parseTags } from "../util/io.ts";
import { parseDuration } from "../util/time.ts";
import { asJson, formatList } from "../util/fmt.ts";
import { withErrors } from "../util/cli.ts";

export const listCmd = defineCommand({
  meta: { name: "list", description: "List memories (newest first)" },
  args: {
    tags: { type: "string", description: "Filter by tags (comma-separated, all required)", default: "" },
    since: { type: "string", description: "Only entries newer than e.g. 7d, 24h", default: "" },
    limit: { type: "string", alias: "n", description: "Max results", default: "" },
    "include-deleted": { type: "boolean", description: "Include soft-deleted entries", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run: withErrors(async (args) => {
    const cfg = loadConfig();
    const limit = parseInt(args.limit as string, 10) || cfg.defaults.list_limit;
    const sinceMs = (args.since as string) ? Date.now() - parseDuration(args.since as string) : undefined;

    const rows = listMemories({
      tags: parseTags(args.tags as string),
      since: sinceMs,
      limit,
      includeDeleted: Boolean(args["include-deleted"]),
    });

    if (args.json) console.log(asJson(rows));
    else console.log(formatList(rows));
  }),
});
