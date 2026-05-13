import { close } from "../db.ts";
import { KenError } from "./err.ts";

type RunFn = (args: Record<string, unknown>) => Promise<void>;
type CittyCtx = { args: Record<string, unknown> };

export function withErrors(fn: RunFn) {
  return async (ctx: CittyCtx) => {
    try {
      await fn(ctx.args);
      close();
    } catch (err) {
      close();
      const wantsJson = Boolean(ctx.args.json);
      if (err instanceof KenError) {
        if (wantsJson) {
          process.stderr.write(JSON.stringify({ error: err.code, message: err.message, hint: err.hint }) + "\n");
        } else {
          process.stderr.write(`error (${err.code}): ${err.message}\n`);
          if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
        }
        process.exit(err.exitCode);
      }
      const e = err as Error;
      if (wantsJson) {
        process.stderr.write(JSON.stringify({ error: "UNKNOWN", message: e.message ?? String(err) }) + "\n");
      } else {
        process.stderr.write(`error: ${e.message ?? String(err)}\n`);
      }
      process.exit(1);
    }
  };
}
