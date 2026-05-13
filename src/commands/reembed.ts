import { defineCommand } from "citty";
import { getMemoriesMissingEmbedding, upsertEmbedding } from "../db.ts";
import { embedOne } from "../embed.ts";
import { loadConfig, saveConfig } from "../config.ts";
import { withErrors } from "../util/cli.ts";
import { KenError } from "../util/err.ts";

type Provider = "openai" | "ollama";

const PROVIDER_DEFAULTS: Record<Provider, { model: string; dim: number }> = {
  openai: { model: "text-embedding-3-small", dim: 1536 },
  ollama: { model: "nomic-embed-text", dim: 768 },
};

const KNOWN_MODELS: Record<string, { provider: Provider; dim: number }> = {
  "text-embedding-3-small": { provider: "openai", dim: 1536 },
  "text-embedding-3-large": { provider: "openai", dim: 3072 },
  "nomic-embed-text": { provider: "ollama", dim: 768 },
  "mxbai-embed-large": { provider: "ollama", dim: 1024 },
  "all-minilm": { provider: "ollama", dim: 384 },
};

export const reembedCmd = defineCommand({
  meta: {
    name: "reembed",
    description: "Backfill embeddings; optionally switch provider/model and persist to config",
  },
  args: {
    provider: { type: "string", description: "Switch embedding provider (openai|ollama) and persist", default: "" },
    model: { type: "string", description: "Switch embedding model (overrides provider's default) and persist", default: "" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run: withErrors(async (args) => {
    const cfg = loadConfig();

    const providerArg = (args.provider as string).trim();
    const modelArg = (args.model as string).trim();

    if (providerArg && providerArg !== "openai" && providerArg !== "ollama") {
      throw new KenError("BAD_INPUT", `unknown provider: ${providerArg}`, {
        hint: "use --provider=openai or --provider=ollama",
      });
    }

    if (providerArg || modelArg) {
      const provider: Provider = providerArg
        ? (providerArg as Provider)
        : (KNOWN_MODELS[modelArg]?.provider ?? cfg.embedding.provider);

      const defaults = PROVIDER_DEFAULTS[provider];
      const model = modelArg || defaults.model;
      const dim = KNOWN_MODELS[model]?.dim ?? defaults.dim;

      cfg.embedding.provider = provider;
      cfg.embedding.model = model;
      cfg.embedding.dim = dim;
      saveConfig(cfg);

      if (!args.json) {
        console.log(`switched config → provider=${provider} model=${model} dim=${dim}`);
      }
    }

    const model = cfg.embedding.model;
    const pending = getMemoriesMissingEmbedding(model);

    if (pending.length === 0) {
      if (args.json) console.log(JSON.stringify({ model, processed: 0 }));
      else console.log(`nothing to do — all memories already embedded for ${model}`);
      return;
    }

    if (!args.json) console.log(`re-embedding ${pending.length} memories with ${model}...`);

    let done = 0;
    for (const m of pending) {
      const vec = await embedOne(m.body, model);
      upsertEmbedding(m.id, model, vec);
      done++;
      if (!args.json && (done % 10 === 0 || done === pending.length)) {
        process.stdout.write(`  ${done}/${pending.length}\n`);
      }
    }

    if (args.json) console.log(JSON.stringify({ model, processed: done }));
    else console.log(`done — ${done} memories embedded with ${model}`);
  }),
});
