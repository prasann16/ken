import { defineCommand } from "citty";
import { insertMemory, upsertEmbedding } from "../db.ts";
import { embedOne } from "../embed.ts";
import { loadConfig } from "../config.ts";
import { KenError } from "../util/err.ts";
import { readStdin, openEditor, parseTags } from "../util/io.ts";
import { withErrors } from "../util/cli.ts";

export const addCmd = defineCommand({
  meta: { name: "add", description: "Add a new memory" },
  args: {
    body: { type: "positional", description: "Memory body text", required: false },
    tags: { type: "string", description: "Comma-separated tags", default: "" },
    stdin: { type: "boolean", description: "Read body from stdin", default: false },
    source: { type: "string", description: "Source label (e.g. 'walk', 'meeting')", default: "" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run: withErrors(async (args) => {
    const cfg = loadConfig();
    let body = (args.body as string | undefined) ?? "";
    if (args.stdin) {
      body = await readStdin();
    } else if (!body) {
      body = openEditor("");
    }
    body = body.trim();
    if (!body) throw new KenError("BAD_INPUT", "empty body — nothing to save");

    const tags = parseTags(args.tags as string);
    const source = (args.source as string) || undefined;

    const m = insertMemory({ body, tags, source });
    const vec = await embedOne(body);
    upsertEmbedding(m.id, cfg.embedding.model, vec);

    if (args.json) console.log(JSON.stringify({ id: m.id, tags: m.tags }));
    else console.log(`saved: ${m.id}`);
  }),
});
