import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { KenError } from "./err.ts";

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function openEditor(initial: string, suffix = ".md"): string {
  const dir = mkdtempSync(join(tmpdir(), "ken-"));
  const path = join(dir, `memory${suffix}`);
  writeFileSync(path, initial);
  const editor = process.env.EDITOR || "vi";
  const result = spawnSync(editor, [path], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new KenError("BAD_INPUT", `editor exited with status ${result.status}`);
  }
  return readFileSync(path, "utf8");
}

export function parseTags(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
