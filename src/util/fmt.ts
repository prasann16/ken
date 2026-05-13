import { relative } from "./time.ts";

export type MemoryRow = {
  id: string;
  tags: string[];
  body: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  score?: number;
};

export function asJson(value: unknown): string {
  return JSON.stringify(value);
}

export function asJsonPretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function displayName(body: string): string {
  const first = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 80 ? first.slice(0, 77) + "..." : first || "(empty)";
}

export function formatList(rows: MemoryRow[]): string {
  if (rows.length === 0) return "(no results)";
  const lines: string[] = [];
  for (const r of rows) {
    const pin = r.tags.includes("pin") ? "📌 " : "   ";
    const name = displayName(r.body);
    lines.push(`${r.id}  ${pad(relative(r.created_at), 10)}  ${pin}${name}`);
  }
  return lines.join("\n");
}

export function formatOne(row: MemoryRow): string {
  return [
    `id:       ${row.id}`,
    `tags:     ${row.tags.join(", ") || "(none)"}`,
    `created:  ${new Date(row.created_at).toISOString()}  (${relative(row.created_at)})`,
    `updated:  ${new Date(row.updated_at).toISOString()}`,
    "",
    row.body,
  ].join("\n");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
