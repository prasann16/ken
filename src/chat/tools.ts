import type Anthropic from "@anthropic-ai/sdk";
import {
  insertMemory,
  upsertEmbedding,
  searchHybrid,
  listMemories,
  getMemory,
  updateMemoryBody,
  softDeleteMemory,
  getPinnedMemories,
} from "../db.ts";
import { embedOne } from "../embed.ts";
import { loadConfig } from "../config.ts";
import { displayName } from "../util/fmt.ts";

// Some models (especially smaller ones) double-escape newlines in tool inputs,
// sending the literal two-character sequence \n instead of a real newline.
// Normalize so list bodies render correctly.
function normalizeBody(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "add_memory",
    description:
      "Save what the user just told you. ALWAYS include 1-3 tags from this convention: pin (always-load — only on explicit pin / always-remember), task (a SINGLE actionable to-do — one thing), list (a multi-item checklist with [ ] lines — use INSTEAD of task), done (a completed single task), idea (half-formed thought). task and list are mutually exclusive. Plus topical tags (work, family, health, morning, project name) reused from the system prompt's existing-tags list when fitting.",
    input_schema: {
      type: "object" as const,
      properties: {
        body: { type: "string", description: "The actual content to save (canonical text — write times, names, numbers, anything specific into the body so search finds it later)" },
        tags: { type: "array", items: { type: "string" }, description: "1-3 short tags. Reuse existing tags from the system prompt when possible." },
        source: { type: "string", description: "Optional origin (e.g. 'walk', 'morning')" },
      },
      required: ["body", "tags"],
    },
  },
  {
    name: "search_memories",
    description: "Find what the user has previously told you, by semantic + keyword similarity. Use when they ask about something they've captured.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language query" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tag filter (all required)" },
        limit: { type: "integer", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_memories",
    description: "List recent captures (newest first). Use when the user wants to browse rather than search by meaning, or filter by tag like 'task' to surface open to-dos.",
    input_schema: {
      type: "object" as const,
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Optional tag filter (e.g. ['task'] for open to-dos)" },
        since_days: { type: "integer", description: "Only entries from the last N days" },
        limit: { type: "integer", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "edit_memory",
    description: "Replace a memory's body. Re-embeds on save. Use this when the user wants to update an existing capture (e.g. mark a task done by rewriting it, or correct a detail).",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Memory id (ulid)" },
        new_body: { type: "string", description: "New body text" },
      },
      required: ["id", "new_body"],
    },
  },
  {
    name: "delete_memory",
    description: "Soft-delete a memory. Reversible from the CLI but not from chat. Use sparingly — only when the user explicitly says to delete.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Memory id (ulid)" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_pinned",
    description: "Return memories tagged 'pin' — the user's always-loaded set. Usually already in the system prompt; call this only if the user explicitly asks 'what's pinned' / 'what do you always know about me'.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
];

type Compact = {
  id: string;
  name: string;
  tags: string[];
  body: string;
  created_at: number;
};

function compact(rows: { id: string; tags: string[]; body: string; created_at: number }[]): Compact[] {
  return rows.map((r) => ({
    id: r.id,
    name: displayName(r.body),
    tags: r.tags,
    body: r.body,
    created_at: r.created_at,
  }));
}

export async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const cfg = loadConfig();
  switch (name) {
    case "add_memory": {
      const body = normalizeBody(String(input.body ?? "")).trim();
      if (!body) return { error: "empty body" };
      const tags = Array.isArray(input.tags) ? (input.tags as string[]).slice(0, 5) : [];
      const source = input.source ? String(input.source) : undefined;
      const m = insertMemory({ body, tags, source });
      const vec = await embedOne(body);
      upsertEmbedding(m.id, cfg.embedding.model, vec);
      return { id: m.id, name: displayName(m.body), tags };
    }

    case "search_memories": {
      const query = String(input.query ?? "").trim();
      if (!query) return { error: "empty query" };
      const limit = typeof input.limit === "number" ? input.limit : cfg.defaults.search_limit;
      const tags = Array.isArray(input.tags) ? (input.tags as string[]) : [];
      const vec = await embedOne(query);
      const hits = searchHybrid({ query, vector: vec, model: cfg.embedding.model, tags, limit });
      return { count: hits.length, results: compact(hits) };
    }

    case "list_memories": {
      const limit = typeof input.limit === "number" ? input.limit : cfg.defaults.list_limit;
      const tags = Array.isArray(input.tags) ? (input.tags as string[]) : [];
      const since = typeof input.since_days === "number"
        ? Date.now() - input.since_days * 86_400_000
        : undefined;
      const rows = listMemories({ tags, since, limit });
      return { count: rows.length, results: compact(rows) };
    }

    case "edit_memory": {
      const id = String(input.id ?? "");
      const newBody = normalizeBody(String(input.new_body ?? "")).trim();
      if (!id || !newBody) return { error: "id and new_body required" };
      const existing = getMemory(id);
      if (!existing || existing.deleted_at) return { error: `memory ${id} not found` };
      const updated = updateMemoryBody(id, newBody);
      const vec = await embedOne(newBody);
      upsertEmbedding(id, cfg.embedding.model, vec);
      return { id: updated.id, name: displayName(updated.body) };
    }

    case "delete_memory": {
      const id = String(input.id ?? "");
      if (!id) return { error: "id required" };
      try {
        softDeleteMemory(id);
        return { id, deleted: true };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    case "get_pinned": {
      const rows = getPinnedMemories();
      return { count: rows.length, results: compact(rows) };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
