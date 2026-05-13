import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { KenError } from "./util/err.ts";

export type Config = {
  embedding: {
    provider: "openai" | "ollama";
    model: string;
    url: string;
    dim: number;
  };
  storage: {
    sqlite_lib: string;
  };
  defaults: {
    search_limit: number;
    list_limit: number;
  };
  backup: {
    enabled: boolean;
    git_remote: string;
  };
  chat: {
    provider: "anthropic";
    model: string;
    api_key: string;
    max_tokens: number;
  };
  transcription: {
    provider: "openai";
    model: string;
    api_key: string;
  };
  server: {
    token: string;
  };
};

const HOME_DIR = process.env.KEN_HOME || join(homedir(), ".ken");
const CONFIG_PATH = join(HOME_DIR, "config.toml");
const DB_PATH = join(HOME_DIR, "ken.db");
const LOG_DIR = join(HOME_DIR, "logs");

const DEFAULTS: Config = {
  embedding: {
    provider: "ollama",
    model: "nomic-embed-text",
    url: "http://localhost:11434",
    dim: 768,
  },
  storage: {
    sqlite_lib: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  },
  defaults: {
    search_limit: 5,
    list_limit: 20,
  },
  backup: {
    enabled: false,
    git_remote: "",
  },
  chat: {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    api_key: "",
    max_tokens: 2048,
  },
  transcription: {
    provider: "openai",
    model: "whisper-1",
    api_key: "",
  },
  server: {
    token: "",
  },
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true });
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  let parsed: Partial<Config> = {};
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, stringify(DEFAULTS as unknown as Record<string, unknown>));
  } else {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      parsed = parse(raw) as unknown as Partial<Config>;
    } catch (e) {
      throw new KenError("CONFIG", `failed to read ${CONFIG_PATH}: ${(e as Error).message}`);
    }
  }
  cached = applyEnvOverrides(mergeDefaults(parsed));
  return cached;
}

export function paths() {
  return { home: HOME_DIR, config: CONFIG_PATH, db: DB_PATH, logs: LOG_DIR };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, stringify(cfg as unknown as Record<string, unknown>));
  cached = cfg;
}

function mergeDefaults(p: Partial<Config>): Config {
  return {
    embedding: { ...DEFAULTS.embedding, ...(p.embedding ?? {}) },
    storage: { ...DEFAULTS.storage, ...(p.storage ?? {}) },
    defaults: { ...DEFAULTS.defaults, ...(p.defaults ?? {}) },
    backup: { ...DEFAULTS.backup, ...(p.backup ?? {}) },
    chat: { ...DEFAULTS.chat, ...(p.chat ?? {}) },
    transcription: { ...DEFAULTS.transcription, ...(p.transcription ?? {}) },
    server: { ...DEFAULTS.server, ...(p.server ?? {}) },
  };
}

function applyEnvOverrides(c: Config): Config {
  if (process.env.OLLAMA_URL) c.embedding.url = process.env.OLLAMA_URL;
  if (process.env.KEN_TOKEN) c.server.token = process.env.KEN_TOKEN;
  if (process.env.KEN_SQLITE_LIB !== undefined) c.storage.sqlite_lib = process.env.KEN_SQLITE_LIB;
  if (process.env.OPENAI_API_KEY) c.transcription.api_key = process.env.OPENAI_API_KEY;
  return c;
}
