import { defineCommand } from "citty";
import { searchHybrid } from "../db.ts";
import { embedOne } from "../embed.ts";
import { loadConfig } from "../config.ts";
import { KenError } from "../util/err.ts";
import { parseTags } from "../util/io.ts";
import { asJson, formatList } from "../util/fmt.ts";
import { withErrors } from "../util/cli.ts";

export const searchCmd = defineCommand({
  meta: { name: "search", description: "Search memories by semantic + keyword similarity" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    tags: { type: "string", description: "Filter by tags (comma-separated, all required)", default: "" },
    limit: { type: "string", alias: "n", description: "Max results", default: "" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run: withErrors(async (args) => {
    const cfg = loadConfig();
    const query = (args.query as string).trim();
    if (!query) throw new KenError("BAD_INPUT", "empty query");

    const limit = parseInt(args.limit as string, 10) || cfg.defaults.search_limit;
    const vec = await embedOne(query);

    const hits = searchHybrid({
      query,
      vector: vec,
      model: cfg.embedding.model,
      tags: parseTags(args.tags as string),
      limit,
    });

    if (args.json) console.log(asJson(hits));
    else console.log(formatList(hits));
  }),
});
