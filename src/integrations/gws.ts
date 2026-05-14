// Shell-out wrapper for Google Workspace CLI (`gws`).
// Spawns the subprocess, captures stdout/stderr, parses JSON, surfaces errors as KenError.

import { KenError } from "../util/err.ts";

type GwsErrorPayload = {
  error?: {
    code?: number;
    message?: string;
    reason?: string;
  };
};

export async function gws(args: string[]): Promise<unknown> {
  let proc;
  try {
    proc = Bun.spawn(["gws", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new KenError("EXTERNAL_TOOL", `cannot spawn gws: ${(e as Error).message}`, {
      hint: "install gws — https://github.com/googleworkspace/cli",
    });
  }

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // gws emits structured JSON errors to stdout even on failure.
  let parsed: unknown = null;
  if (stdoutText.trim()) {
    try { parsed = JSON.parse(stdoutText); } catch { /* not JSON, keep raw */ }
  }

  const errObj = (parsed as GwsErrorPayload | null)?.error;
  if (errObj) {
    const code = errObj.code ?? 0;
    const msg = errObj.message ?? "unknown gws error";
    const hint = code === 401
      ? "run `gws auth login` to authenticate the gws CLI with your Google account"
      : code === 403
        ? "this Google account doesn't have permission for that action; check the scopes granted to gws"
        : undefined;
    throw new KenError("EXTERNAL_TOOL", `gws ${args[0] ?? ""}: ${msg.trim()}`, { hint });
  }

  if (exitCode !== 0) {
    throw new KenError(
      "EXTERNAL_TOOL",
      `gws exited ${exitCode}: ${stderrText.trim() || stdoutText.trim() || "no output"}`,
    );
  }

  return parsed ?? stdoutText;
}
