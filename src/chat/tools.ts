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
import {
  searchEmails as imapSearchEmails,
  getEmail as imapGetEmail,
  sendEmail as imapSendEmail,
  archiveEmails as imapArchiveEmails,
  trashEmails as imapTrashEmails,
  unsubscribeEmail as imapUnsubscribeEmail,
} from "../integrations/email.ts";

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

  // ---- email tools (Gmail via `gws` CLI) ----
  {
    name: "email_search",
    description: "Read tool. Search the user's inbox. On Gmail, accepts Gmail query syntax: 'from:alice@example.com', 'newer_than:7d', 'is:unread', 'subject:invoice'. Returns id, sender, subject, date, and a short snippet for each match. The snippet may be truncated — if you need the full body, call email_get with the id.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (Gmail-style on Gmail; basic terms on other providers)" },
        limit: { type: "integer", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "email_get",
    description: "Read tool. Fetch a single email's full body and headers by id (the id comes from email_search results). Use this when the snippet from search isn't enough — e.g. to draft a contextual reply or summarize.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Email id from email_search" },
      },
      required: ["id"],
    },
  },
  {
    name: "email_send",
    description: "REQUIRES USER APPROVAL — show the full draft (To, Subject, Body) in chat and get an explicit yes before calling. Sends an email via the user's Gmail account. Plain text only. For replies on an existing thread, pass the original email's id as in_reply_to to keep the thread together.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain text body" },
        in_reply_to: { type: "string", description: "Optional message id from email_search results — if present, the send is threaded as a reply" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "email_archive",
    description: "REQUIRES USER APPROVAL — list what you're about to archive (subjects/senders) and get an explicit yes before calling. Removes emails from the inbox (does not delete them — they stay searchable in 'All Mail').",
    input_schema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Message ids from email_search results" },
      },
      required: ["ids"],
    },
  },
  {
    name: "email_trash",
    description: "REQUIRES USER APPROVAL — list what you're about to trash and get an explicit yes before calling. Moves emails to Trash (Gmail keeps them recoverable for 30 days). Never use for permanent deletion.",
    input_schema: {
      type: "object" as const,
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Message ids from email_search results" },
      },
      required: ["ids"],
    },
  },
  {
    name: "email_unsubscribe",
    description: "REQUIRES USER APPROVAL — identify the sender and get an explicit yes before calling. Attempts to unsubscribe from a mailing list using the email's List-Unsubscribe header. Returns the outcome: 'unsubscribed' on success (RFC 8058 one-click), 'manual_required' with a URL if only a link is available, or 'no_unsubscribe_method' if the email has no header.",
    input_schema: {
      type: "object" as const,
      properties: {
        email_id: { type: "string", description: "Message id from email_search" },
      },
      required: ["email_id"],
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

    case "email_search": {
      const query = String(input.query ?? "").trim();
      if (!query) return { error: "empty query" };
      const limit = typeof input.limit === "number" ? input.limit : 10;
      const results = await imapSearchEmails(query, limit);
      return { count: results.length, results };
    }

    case "email_get": {
      const id = String(input.id ?? "").trim();
      if (!id) return { error: "id required" };
      const m = await imapGetEmail(id);
      if (!m) return { error: `email ${id} not found` };
      return m;
    }

    case "email_send": {
      const to = String(input.to ?? "").trim();
      const subject = String(input.subject ?? "").trim();
      const body = String(input.body ?? "").trim();
      const inReplyTo = input.in_reply_to ? String(input.in_reply_to) : undefined;
      if (!to || !subject || !body) return { error: "to, subject, and body are required" };
      const { messageId } = await imapSendEmail({ to, subject, body, inReplyToId: inReplyTo });
      return { sent: true, to, subject, threaded: !!inReplyTo, message_id: messageId };
    }

    case "email_archive": {
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
      if (ids.length === 0) return { error: "no ids" };
      const archived = await imapArchiveEmails(ids);
      return { archived };
    }

    case "email_trash": {
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
      if (ids.length === 0) return { error: "no ids" };
      const trashed = await imapTrashEmails(ids);
      return { trashed };
    }

    case "email_unsubscribe": {
      const id = String(input.email_id ?? "").trim();
      if (!id) return { error: "email_id required" };
      return await imapUnsubscribeEmail(id);
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
