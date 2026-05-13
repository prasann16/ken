import { KenError } from "./err.ts";

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhdw])$/.exec(s.trim());
  if (!m) throw new KenError("BAD_INPUT", `invalid duration: ${s}`, { hint: "use e.g. 30s, 5m, 2h, 7d, 1w" });
  return Number(m[1]) * UNITS[m[2]!]!;
}

export function relative(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
