import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.ts";
import { insertMemory, upsertEmbedding } from "../db.ts";
import { embedOne } from "../embed.ts";
import { KenError } from "../util/err.ts";
import { parseTags } from "../util/io.ts";
import { getClient } from "./anthropic.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";
import { buildSystemText, runAgenticTurn, greetingFor, type Sink } from "./agent.ts";

type RunOptions = {
  model?: string;
  maxTokens?: number;
};

const BANNER = "ken — your daily notebook. /help for commands, /exit to quit.\n";

export async function runRepl(opts: RunOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const client = getClient();

  let model = opts.model || cfg.chat.model;
  const maxTokens = opts.maxTokens || cfg.chat.max_tokens;

  let systemText = buildSystemText();
  const messages: Anthropic.MessageParam[] = [];
  let lastAssistantText = "";

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(BANNER);
  process.stdout.write(`\n${greetingFor()}\n\n`);

  const stdoutSink: Sink = {
    onText: (delta) => process.stdout.write(delta),
    onToolStart: (name) => process.stdout.write(`\n[${name}…]`),
    onToolEnd: () => {},
  };

  while (true) {
    let line: string;
    try {
      line = (await rl.question("> ")).trim();
    } catch {
      break;
    }

    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") { printHelp(); continue; }
    if (line === "/clear") {
      messages.length = 0;
      systemText = buildSystemText();
      lastAssistantText = "";
      process.stdout.write("(history cleared)\n");
      continue;
    }
    if (line.startsWith("/model ")) {
      const newModel = line.slice("/model ".length).trim();
      if (newModel) { model = newModel; process.stdout.write(`(model: ${model})\n`); }
      continue;
    }
    if (line.startsWith("/save")) {
      handleSave(line, lastAssistantText, cfg.embedding.model);
      continue;
    }
    if (line.startsWith("ken ")) {
      runRawCli(line.slice("ken ".length));
      continue;
    }

    messages.push({ role: "user", content: line });

    try {
      const result = await runAgenticTurn(client, model, maxTokens, systemText, messages, stdoutSink);
      messages.push(...result.appendedMessages);
      lastAssistantText = result.text;
      process.stdout.write("\n");
    } catch (err) {
      if (err instanceof KenError) {
        process.stderr.write(`\n[error ${err.code}: ${err.message}]\n`);
        if (err.hint) process.stderr.write(`[hint: ${err.hint}]\n`);
      } else {
        process.stderr.write(`\n[error: ${(err as Error).message}]\n`);
      }
      messages.pop();
    }
  }

  rl.close();
  process.stdout.write("\nbye.\n");
}

function handleSave(line: string, lastAssistantText: string, embeddingModel: string): void {
  const parts = line.split(/\s+/);
  const tagInput = parts.slice(1).join(",");
  const tags = parseTags(tagInput);
  const body = lastAssistantText.trim();
  if (!body) {
    process.stdout.write("(no assistant message to save yet)\n");
    return;
  }
  const m = insertMemory({ body, tags, source: "ken-chat" });
  embedOne(body)
    .then((vec) => upsertEmbedding(m.id, embeddingModel, vec))
    .catch((e) => process.stderr.write(`(saved row but embedding failed: ${(e as Error).message})\n`));
  process.stdout.write(`saved (${m.id})${tags.length ? ` tags: ${tags.join(", ")}` : ""}\n`);
}

function runRawCli(args: string): void {
  const result = spawnSync("ken", args.split(/\s+/), { stdio: "inherit" });
  if (result.error) process.stderr.write(`(could not run ken: ${result.error.message})\n`);
}

function printHelp(): void {
  process.stdout.write(`
slash commands:
  /help                     this message
  /exit, /quit              exit
  /clear                    reset history
  /save [tag,tag]           save the last reply as a memory (no type — just tags)
  /model <name>             switch model

other patterns:
  ken <args>                run a raw ken CLI command (bypasses LLM)

available tools the model can call:
${TOOL_DEFINITIONS.map((t) => `  - ${t.name}`).join("\n")}

`);
}
