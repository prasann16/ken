import { defineCommand } from "citty";
import { getMemory, updateMemoryBody, upsertEmbedding } from "../db.ts";
import { embedOne } from "../embed.ts";
import { loadConfig } from "../config.ts";
import { KenError } from "../util/err.ts";
import { openEditor } from "../util/io.ts";
import { withErrors } from "../util/cli.ts";

export const editCmd = defineCommand({
  meta: { name: "edit", description: "Edit a memory's body in $EDITOR; re-embeds on save" },
  args: {
    id: { type: "positional", description: "Memory id (ulid)", required: true },
  },
  run: withErrors(async (args) => {
    const cfg = loadConfig();
    const id = args.id as string;
    const m = getMemory(id);
    if (!m) throw new KenError("NOT_FOUND", `memory ${id} not found`);
    if (m.deleted_at) throw new KenError("NOT_FOUND", `memory ${id} is deleted; restore it first`);

    const edited = openEditor(m.body).trim();
    if (!edited) throw new KenError("BAD_INPUT", "empty body — refusing to save");
    if (edited === m.body) {
      console.log("(no changes)");
      return;
    }

    const updated = updateMemoryBody(id, edited);
    const vec = await embedOne(edited);
    upsertEmbedding(id, cfg.embedding.model, vec);
    console.log(`updated: ${updated.id}`);
  }),
});
