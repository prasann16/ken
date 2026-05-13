import type Anthropic from "@anthropic-ai/sdk";
import {
  listMemories,
  searchHybrid,
  getPinnedMemories,
  getMemory,
  updateMemoryBody,
  upsertEmbedding,
  softDeleteMemory,
  togglePin,
  getTopTags,
} from "../db.ts";
import { embedOne } from "../embed.ts";
import { loadConfig } from "../config.ts";
import { getClient } from "../chat/anthropic.ts";
import { buildSystemText, runAgenticTurn, greetingFor, type Sink } from "../chat/agent.ts";
import { KenError } from "../util/err.ts";
import indexHtml from "./index.html" with { type: "text" };
import markedJs from "./marked.umd.js" with { type: "text" };

const sessions = new Map<string, Anthropic.MessageParam[]>();
const systemTextCache = new Map<string, string>();

function ndjson(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

type Ref = { id: string; name: string };
function extractRefs(toolName: string, result: unknown): Ref[] {
  if (!result || typeof result !== "object") return [];
  const r = result as {
    id?: string;
    name?: string;
    results?: Array<{ id: string; name?: string }>;
  };
  if ((toolName === "add_memory" || toolName === "edit_memory") && r.id) {
    return [{ id: r.id, name: r.name ?? "" }];
  }
  if (
    (toolName === "search_memories" || toolName === "list_memories" || toolName === "get_pinned") &&
    Array.isArray(r.results)
  ) {
    return r.results.slice(0, 8).map((item) => ({ id: item.id, name: item.name ?? "" }));
  }
  return [];
}

const MANIFEST_JSON = JSON.stringify({
  name: "ken",
  short_name: "ken",
  description: "personal memory assistant",
  start_url: "/",
  display: "standalone",
  background_color: "#F5F1EA",
  theme_color: "#C75D3F",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
});

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" fill="#F5F1EA"/>
  <text x="96" y="135" text-anchor="middle" font-family="Georgia, serif" font-size="140" font-weight="600" fill="#1F1B16">k</text>
  <circle cx="148" cy="135" r="8" fill="#C75D3F"/>
</svg>`;

export type ServerHandle = { port: number; stop: () => void; url: string };

type StartOptions = {
  port: number;
  bind?: string;
  token?: string;
};

export function startServer(opts: StartOptions): ServerHandle {
  const cfg = loadConfig();
  const token = opts.token ?? "";
  const bind = opts.bind ?? "127.0.0.1";

  // Top-level fetch handler — auth + simple routing.
  // Using fetch() directly (not the routes API) gives us reliable middleware.
  const server = Bun.serve({
    port: opts.port,
    hostname: bind,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      // Public routes (no auth)
      if (pathname === "/" && method === "GET") {
        return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/manifest.json" && method === "GET") {
        return new Response(MANIFEST_JSON, {
          headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" },
        });
      }
      if (pathname === "/icon.svg" && method === "GET") {
        return new Response(ICON_SVG, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" },
        });
      }
      if (pathname === "/marked.umd.js" && method === "GET") {
        return new Response(markedJs, {
          headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
        });
      }
      if (pathname === "/api/auth/check" && method === "GET") {
        if (!token) return Response.json({ ok: true, auth: false });
        const header = req.headers.get("authorization");
        if (header === `Bearer ${token}`) return Response.json({ ok: true, auth: true });
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // Auth gate for /api/*
      if (pathname.startsWith("/api/") && token) {
        const header = req.headers.get("authorization");
        if (header !== `Bearer ${token}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      // Routing
      if (pathname === "/api/list" && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
        return Response.json(listMemories({ limit }));
      }

      if (pathname === "/api/search" && method === "GET") {
        const query = url.searchParams.get("q")?.trim();
        if (!query) return Response.json({ error: "missing q" }, { status: 400 });
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        try {
          const vec = await embedOne(query);
          const hits = searchHybrid({ query, vector: vec, model: cfg.embedding.model, limit });
          return Response.json(hits);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      }

      if (pathname === "/api/pinned" && method === "GET") {
        return Response.json(getPinnedMemories());
      }

      if (pathname === "/api/tags" && method === "GET") {
        return Response.json(getTopTags(50));
      }

      if (pathname === "/api/greeting" && method === "GET") {
        return Response.json({ text: greetingFor() });
      }

      // /api/memory/:id and /api/memory/:id/pin
      const memMatch = pathname.match(/^\/api\/memory\/([A-Z0-9]+)(\/pin)?$/i);
      if (memMatch) {
        const id = memMatch[1]!;
        const isPinRoute = !!memMatch[2];
        if (isPinRoute && method === "POST") {
          try {
            const result = togglePin(id);
            return Response.json({ pinned: result.pinned, row: result.row });
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 404 });
          }
        }
        if (!isPinRoute && method === "GET") {
          const m = getMemory(id);
          return m ? Response.json(m) : Response.json({ error: "not found" }, { status: 404 });
        }
        if (!isPinRoute && method === "PATCH") {
          const { body } = (await req.json()) as { body?: string };
          if (!body || !body.trim()) {
            return Response.json({ error: "empty body" }, { status: 400 });
          }
          try {
            const updated = updateMemoryBody(id, body);
            const vec = await embedOne(body);
            upsertEmbedding(id, cfg.embedding.model, vec);
            return Response.json(updated);
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 500 });
          }
        }
        if (!isPinRoute && method === "DELETE") {
          try {
            softDeleteMemory(id);
            return Response.json({ ok: true });
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 404 });
          }
        }
      }

      if (pathname === "/api/transcribe" && method === "POST") {
        const apiKey = process.env.OPENAI_API_KEY || cfg.transcription.api_key;
        if (!apiKey) {
          return Response.json({
            error: "no OpenAI API key configured",
            hint: "set OPENAI_API_KEY env var or transcription.api_key in config.toml",
          }, { status: 500 });
        }
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return Response.json({ error: "invalid form data" }, { status: 400 });
        }
        const audioField = formData.get("file");
        if (!(audioField instanceof File) && !(audioField instanceof Blob)) {
          return Response.json({ error: "missing audio file" }, { status: 400 });
        }
        const filename = (audioField as File).name || "audio.webm";

        const upstream = new FormData();
        upstream.append("file", audioField, filename);
        upstream.append("model", cfg.transcription.model);

        try {
          const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: upstream,
          });
          if (!res.ok) {
            const errText = await res.text();
            return Response.json({ error: "transcription failed", detail: errText.slice(0, 200) }, { status: 502 });
          }
          const data = (await res.json()) as { text?: string };
          return Response.json({ text: data.text ?? "" });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      }

      if (pathname === "/api/chat" && method === "POST") {
        let payload: { session_id?: string; user_message?: string; reset?: boolean };
        try {
          payload = await req.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const sessionId = payload.session_id ?? "default";
        if (payload.reset) {
          sessions.delete(sessionId);
          systemTextCache.delete(sessionId);
          return Response.json({ ok: true });
        }
        const userMessage = (payload.user_message ?? "").trim();
        if (!userMessage) return Response.json({ error: "empty user_message" }, { status: 400 });

        let client;
        try {
          client = getClient();
        } catch (e) {
          if (e instanceof KenError && e.code === "LLM_AUTH") {
            return Response.json({ error: e.message, hint: e.hint }, { status: 500 });
          }
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }

        const history = sessions.get(sessionId) ?? [];
        history.push({ role: "user", content: userMessage });

        let systemText = systemTextCache.get(sessionId);
        if (!systemText) {
          systemText = buildSystemText();
          systemTextCache.set(sessionId, systemText);
        }

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const sink: Sink = {
              onText(delta) { controller.enqueue(enc.encode(ndjson({ type: "text", delta }))); },
              onToolStart(name) { controller.enqueue(enc.encode(ndjson({ type: "tool_start", name }))); },
              onToolEnd(name, result) {
                const refs = extractRefs(name, result);
                controller.enqueue(enc.encode(ndjson({ type: "tool_end", name, refs })));
              },
            };
            try {
              const result = await runAgenticTurn(
                client,
                cfg.chat.model,
                cfg.chat.max_tokens,
                systemText!,
                history,
                sink,
              );
              history.push(...result.appendedMessages);
              sessions.set(sessionId, history);
              controller.enqueue(enc.encode(ndjson({ type: "done" })));
            } catch (e) {
              controller.enqueue(enc.encode(ndjson({ type: "error", message: (e as Error).message })));
              history.pop();
              sessions.set(sessionId, history);
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-cache",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return Response.json({ error: err.message }, { status: 500 });
    },
  });

  const displayHost = bind === "0.0.0.0" ? "localhost" : bind;
  return {
    port: server.port,
    url: `http://${displayHost}:${server.port}`,
    stop: () => server.stop(),
  };
}
