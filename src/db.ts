import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { ulid } from "ulid";
import { loadConfig, paths } from "./config.ts";
import { KenError } from "./util/err.ts";
import type { MemoryRow } from "./util/fmt.ts";
import schemaSQL from "./schema.sql" with { type: "text" };

let _db: Database | null = null;
let _vecTablesReady = new Set<string>();

function loadVecExtension(conn: Database): void {
  const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const sibling = join(dirname(process.execPath), `vec0.${ext}`);
  if (existsSync(sibling)) {
    conn.loadExtension(sibling);
    return;
  }
  sqliteVec.load(conn);
}

export function db(): Database {
  if (_db) return _db;
  const cfg = loadConfig();

  // setCustomSQLite is needed on macOS where Apple's bundled SQLite has OMIT_LOAD_EXTENSION.
  // On Linux/Windows, Bun's bundled SQLite supports extension loading — skip the override.
  if (cfg.storage.sqlite_lib && existsSync(cfg.storage.sqlite_lib)) {
    try {
      Database.setCustomSQLite(cfg.storage.sqlite_lib);
    } catch (e) {
      throw new KenError("DB_LOCKED", `failed to load custom SQLite at ${cfg.storage.sqlite_lib}: ${(e as Error).message}`, {
        hint: "install Homebrew SQLite: brew install sqlite",
      });
    }
  }

  const conn = new Database(paths().db);
  conn.exec("PRAGMA journal_mode=WAL");
  conn.exec("PRAGMA foreign_keys=ON");
  conn.exec("PRAGMA busy_timeout=5000");

  try {
    loadVecExtension(conn);
  } catch (e) {
    throw new KenError("MIGRATION_FAILED", `failed to load sqlite-vec: ${(e as Error).message}`);
  }

  try {
    conn.exec(schemaSQL);
  } catch (e) {
    throw new KenError("MIGRATION_FAILED", `schema migration failed: ${(e as Error).message}`);
  }

  _db = conn;
  ensureVecTable(cfg.embedding.model, cfg.embedding.dim);
  return conn;
}

export function vecTableName(model: string): string {
  return "vec_" + model.replace(/[^a-zA-Z0-9]/g, "_");
}

export function ensureVecTable(model: string, dim: number): string {
  const name = vecTableName(model);
  if (_vecTablesReady.has(name)) return name;
  const conn = _db!;
  conn.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${dim}])`,
  );
  _vecTablesReady.add(name);
  return name;
}

export type InsertInput = {
  body: string;
  tags: string[];
  source?: string;
};

export function insertMemory(input: InsertInput): MemoryRow {
  const conn = db();
  const id = ulid();
  const now = Date.now();
  conn.prepare(
    `INSERT INTO memories (id, body, tags, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.body, JSON.stringify(input.tags), input.source ?? null, now, now);
  return getMemory(id)!;
}

export function getMemory(id: string): MemoryRow | null {
  const conn = db();
  const row = conn.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as RawRow | undefined;
  return row ? hydrate(row) : null;
}

export function updateMemoryBody(id: string, body: string): MemoryRow {
  const conn = db();
  const now = Date.now();
  const result = conn.prepare(
    `UPDATE memories SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).run(body, now, id);
  if (result.changes === 0) throw new KenError("NOT_FOUND", `memory ${id} not found`);
  return getMemory(id)!;
}

export function softDeleteMemory(id: string): void {
  const conn = db();
  const result = conn.prepare(
    `UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), id);
  if (result.changes === 0) throw new KenError("NOT_FOUND", `memory ${id} not found or already deleted`);
}

export function restoreMemory(id: string): void {
  const conn = db();
  const result = conn.prepare(
    `UPDATE memories SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
  ).run(id);
  if (result.changes === 0) throw new KenError("NOT_FOUND", `memory ${id} not found or not deleted`);
}

export function getMemoriesMissingEmbedding(model: string, limit = 10000): { id: string; body: string }[] {
  const conn = db();
  return conn.prepare(
    `SELECT id, body FROM memories
     WHERE deleted_at IS NULL
       AND id NOT IN (SELECT memory_id FROM embeddings WHERE model = ?)
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(model, limit) as { id: string; body: string }[];
}

export function upsertEmbedding(memory_id: string, model: string, vector: Float32Array): void {
  const conn = db();
  const dim = vector.length;
  const tbl = ensureVecTable(model, dim);
  const json = JSON.stringify(Array.from(vector));
  const now = Date.now();

  conn.prepare(
    `INSERT OR REPLACE INTO embeddings (memory_id, model, dim, vector, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(memory_id, model, dim, new Uint8Array(vector.buffer), now);

  conn.prepare(`DELETE FROM ${tbl} WHERE memory_id = ?`).run(memory_id);
  conn.prepare(`INSERT INTO ${tbl} (memory_id, embedding) VALUES (?, ?)`).run(memory_id, json);
}

export type ListFilters = {
  tags?: string[];
  since?: number;
  limit?: number;
  includeDeleted?: boolean;
};

export function listMemories(f: ListFilters = {}): MemoryRow[] {
  const conn = db();
  const where: string[] = [];
  const params: unknown[] = [];

  if (!f.includeDeleted) where.push("deleted_at IS NULL");
  if (f.since) {
    where.push("created_at >= ?");
    params.push(f.since);
  }
  if (f.tags?.length) {
    for (const t of f.tags) {
      where.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)");
      params.push(t);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = f.limit ?? 20;
  const sql = `SELECT * FROM memories ${whereSql} ORDER BY created_at DESC LIMIT ?`;
  const rows = conn.prepare(sql).all(...params, limit) as RawRow[];
  return rows.map(hydrate);
}

export type SearchInput = {
  query: string;
  vector: Float32Array;
  model: string;
  tags?: string[];
  limit?: number;
};

export function searchHybrid(input: SearchInput): MemoryRow[] {
  const conn = db();
  const limit = input.limit ?? 5;
  const fanout = Math.max(20, limit * 4);
  const tbl = ensureVecTable(input.model, input.vector.length);

  const vecSql = `
    SELECT memory_id
    FROM ${tbl}
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `;
  const vecHits = conn.prepare(vecSql).all(JSON.stringify(Array.from(input.vector)), fanout) as { memory_id: string }[];

  const ftsTokens = sanitizeFts(input.query);
  let ftsHits: { memory_id: string }[] = [];
  if (ftsTokens) {
    const ftsSql = `
      SELECT memory_id
      FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY bm25(memories_fts)
      LIMIT ?
    `;
    ftsHits = conn.prepare(ftsSql).all(ftsTokens, fanout) as { memory_id: string }[];
  }

  const RRF_K = 60;
  const VEC_WEIGHT = 1.0;
  const FTS_WEIGHT = 0.7;
  const merged = new Map<string, number>();
  vecHits.forEach((h, i) => {
    merged.set(h.memory_id, (merged.get(h.memory_id) ?? 0) + VEC_WEIGHT / (RRF_K + i + 1));
  });
  ftsHits.forEach((h, i) => {
    merged.set(h.memory_id, (merged.get(h.memory_id) ?? 0) + FTS_WEIGHT / (RRF_K + i + 1));
  });

  if (merged.size === 0) return [];
  const ids = [...merged.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const where: string[] = [`id IN (${placeholders})`, "deleted_at IS NULL"];
  const params: unknown[] = [...ids];
  if (input.tags?.length) {
    for (const t of input.tags) {
      where.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)");
      params.push(t);
    }
  }
  const rows = conn.prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")}`).all(...params) as RawRow[];

  const now = Date.now();
  const scored = rows.map((r) => {
    const base = merged.get(r.id) ?? 0;
    const ageDays = (now - r.created_at) / 86_400_000;
    const recencyBoost = 0.001 / (1 + ageDays / 30);
    return { row: hydrate(r), score: base + recencyBoost };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => Object.assign(s.row, { score: s.score }));
}

export function getPinnedMemories(): MemoryRow[] {
  const conn = db();
  const rows = conn.prepare(
    `SELECT * FROM memories
     WHERE deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = 'pin')
     ORDER BY created_at DESC`,
  ).all() as RawRow[];
  return rows.map(hydrate);
}

export function updateMemoryTags(id: string, tags: string[]): MemoryRow {
  const conn = db();
  const now = Date.now();
  const result = conn.prepare(
    `UPDATE memories SET tags = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).run(JSON.stringify(tags), now, id);
  if (result.changes === 0) throw new KenError("NOT_FOUND", `memory ${id} not found`);
  return getMemory(id)!;
}

export function togglePin(id: string): { row: MemoryRow; pinned: boolean } {
  const m = getMemory(id);
  if (!m || m.deleted_at) throw new KenError("NOT_FOUND", `memory ${id} not found`);
  const has = m.tags.includes("pin");
  const newTags = has ? m.tags.filter((t) => t !== "pin") : [...m.tags, "pin"];
  const row = updateMemoryTags(id, newTags);
  return { row, pinned: !has };
}

export function getTopTags(limit: number): { tag: string; count: number }[] {
  const conn = db();
  return conn.prepare(
    `SELECT je.value AS tag, COUNT(*) AS count
     FROM memories, json_each(memories.tags) je
     WHERE memories.deleted_at IS NULL
     GROUP BY je.value
     ORDER BY count DESC, tag ASC
     LIMIT ?`,
  ).all(limit) as { tag: string; count: number }[];
}

export function close(): void {
  if (_db) {
    _db.close();
    _db = null;
    _vecTablesReady.clear();
  }
}

type RawRow = {
  id: string;
  tags: string;
  body: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

function hydrate(r: RawRow): MemoryRow {
  let tags: string[];
  try {
    tags = JSON.parse(r.tags);
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }
  return {
    id: r.id,
    tags,
    body: r.body,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

function sanitizeFts(input: string): string {
  const tokens = input
    .replace(/["'()*:^]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return tokens.join(" OR ");
}
