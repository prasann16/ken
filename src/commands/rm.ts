import { defineCommand } from "citty";
import { softDeleteMemory, restoreMemory } from "../db.ts";
import { KenError } from "../util/err.ts";
import { withErrors } from "../util/cli.ts";

export const rmCmd = defineCommand({
  meta: { name: "rm", description: "Soft-delete a memory" },
  args: {
    id: { type: "positional", description: "Memory id (ulid)", required: true },
    yes: { type: "boolean", alias: "y", description: "Confirm the delete", default: false },
    restore: { type: "boolean", description: "Restore a soft-deleted memory instead", default: false },
  },
  run: withErrors(async (args) => {
    const id = args.id as string;
    if (args.restore) {
      restoreMemory(id);
      console.log(`restored: ${id}`);
      return;
    }
    if (!args.yes) {
      throw new KenError("BAD_INPUT", "destructive op refused without --yes", {
        hint: `run: ken rm ${id} --yes`,
      });
    }
    softDeleteMemory(id);
    console.log(`deleted: ${id}`);
  }),
});
