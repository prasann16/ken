import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.ts";
import { KenError } from "../util/err.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client) return _client;
  const cfg = loadConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY || cfg.chat.api_key;
  if (!apiKey) {
    throw new KenError("LLM_AUTH", "no Anthropic API key configured", {
      hint: "export ANTHROPIC_API_KEY=sk-ant-... or set chat.api_key in ~/.ken/config.toml",
    });
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  _client = baseURL ? new Anthropic({ apiKey, baseURL }) : new Anthropic({ apiKey });
  return _client;
}

export function buildToolsWithCache(): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = TOOL_DEFINITIONS.map((t) => ({ ...t }));
  const last = tools[tools.length - 1];
  if (last && "name" in last) {
    (last as Anthropic.Tool & { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
  }
  return tools;
}

export function buildSystem(systemText: string): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: systemText,
      cache_control: { type: "ephemeral" },
    },
  ];
}
