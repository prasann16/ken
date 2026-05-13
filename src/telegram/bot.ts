import type Anthropic from "@anthropic-ai/sdk";
import { runAgenticTurn, buildSystemText, type Sink, greetingFor } from "../chat/agent.ts";
import { getClient } from "../chat/anthropic.ts";
import { loadConfig } from "../config.ts";

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
};

type TgMessage = {
  message_id: number;
  chat: { id: number; type: string; first_name?: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
};

export type BotOptions = {
  token: string;
  allowedChatIds: Set<number>;
};

export async function runBot(opts: BotOptions): Promise<void> {
  const { token, allowedChatIds } = opts;
  const API = `https://api.telegram.org/bot${token}`;
  const FILE_API = `https://api.telegram.org/file/bot${token}`;

  const sessions = new Map<number, Anthropic.MessageParam[]>();
  const queues = new Map<number, Promise<void>>();

  const cfg = loadConfig();
  const systemText = buildSystemText();
  const client = getClient();

  async function tg<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result as T;
  }

  async function transcribe(fileId: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY || cfg.transcription.api_key;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const fileInfo = await tg<{ file_path: string }>("getFile", { file_id: fileId });
    const audioRes = await fetch(`${FILE_API}/${fileInfo.file_path}`);
    if (!audioRes.ok) throw new Error(`download failed: ${audioRes.status}`);
    const audioBlob = await audioRes.blob();
    const form = new FormData();
    form.append("file", audioBlob, "audio.ogg");
    form.append("model", cfg.transcription.model);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`whisper: ${err.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }

  async function send(chatId: number, text: string) {
    const MAX = 4000;
    if (text.length <= MAX) {
      await tg("sendMessage", { chat_id: chatId, text });
      return;
    }
    for (let i = 0; i < text.length; i += MAX) {
      await tg("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX) });
    }
  }

  async function typing(chatId: number) {
    try {
      await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // best-effort
    }
  }

  async function handleMessage(msg: TgMessage) {
    const chatId = msg.chat.id;
    if (!allowedChatIds.has(chatId)) {
      await send(chatId, `not authorized. your chat_id is ${chatId}.`);
      return;
    }

    if (msg.text === "/start") {
      await send(chatId, greetingFor());
      return;
    }
    if (msg.text === "/help") {
      await send(chatId, "just talk to me. i'll remember things.\n\n/start — greeting\n/reset — clear chat history\n/help — this");
      return;
    }
    if (msg.text === "/reset") {
      sessions.delete(chatId);
      await send(chatId, "cleared. fresh slate.");
      return;
    }

    let userText = msg.text?.trim() ?? "";
    if (!userText && msg.voice) {
      await typing(chatId);
      try {
        userText = await transcribe(msg.voice.file_id);
      } catch (e) {
        await send(chatId, `voice failed: ${(e as Error).message}`);
        return;
      }
      if (!userText) {
        await send(chatId, "(couldn't make out the audio)");
        return;
      }
    }
    if (!userText) return;

    await typing(chatId);

    const history = sessions.get(chatId) ?? [];
    history.push({ role: "user", content: userText });

    const sink: Sink = {
      onText() {},
      onToolStart() { void typing(chatId); },
      onToolEnd() { void typing(chatId); },
    };

    try {
      const result = await runAgenticTurn(client, cfg.chat.model, cfg.chat.max_tokens, systemText, history, sink);
      history.push(...result.appendedMessages);
      sessions.set(chatId, history);
      const reply = result.text.trim();
      if (reply) await send(chatId, reply);
    } catch (e) {
      history.pop();
      sessions.set(chatId, history);
      await send(chatId, `error: ${(e as Error).message}`);
    }
  }

  function enqueue(chatId: number, work: () => Promise<void>) {
    const prev = queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(work, work).catch((e) => console.error("handler error:", e));
    queues.set(chatId, next);
  }

  let offset = 0;
  console.log(`ken-telegram: polling started — ${allowedChatIds.size} allowed chat(s)`);
  while (true) {
    try {
      const updates = await tg<TgUpdate[]>("getUpdates", { offset, timeout: 30 });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          const msg = update.message;
          enqueue(msg.chat.id, () => handleMessage(msg));
        }
      }
    } catch (e) {
      console.error("poll error:", (e as Error).message);
      await Bun.sleep(2000);
    }
  }
}
