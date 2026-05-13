import { defineCommand } from "citty";
import { getPinnedMemories } from "../db.ts";
import { asJson, formatList } from "../util/fmt.ts";
import { withErrors } from "../util/cli.ts";

export const pinCmd = defineCommand({
  meta: {
    name: "pin",
    description: "Show pinned memories (those tagged 'pin') — the always-loaded set",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run: withErrors(async (args) => {
    const rows = getPinnedMemories();
    if (args.json) console.log(asJson(rows));
    else console.log(formatList(rows));
  }),
});
