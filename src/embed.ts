import { loadConfig } from "./config.ts";
import { KenError } from "./util/err.ts";

export async function embed(input: string | string[], modelOverride?: string): Promise<Float32Array[]> {
  const cfg = loadConfig();
  const model = modelOverride ?? cfg.embedding.model;
  const items = Array.isArray(input) ? input : [input];

  if (cfg.embedding.provider === "openai") {
    return embedOpenAI(items, model);
  }
  return embedOllama(items, model, cfg.embedding.url);
}

export async function embedOne(input: string, modelOverride?: string): Promise<Float32Array> {
  const [v] = await embed([input], modelOverride);
  if (!v) throw new KenError("EMBEDDING_DOWN", "embedding provider returned no vector");
  return v;
}

async function embedOpenAI(input: string[], model: string): Promise<Float32Array[]> {
  const apiKey = process.env.OPENAI_API_KEY || loadConfig().transcription.api_key;
  if (!apiKey) {
    throw new KenError("EMBEDDING_DOWN", "no OpenAI API key configured", {
      hint: "export OPENAI_API_KEY=sk-... or set transcription.api_key in ~/.ken/config.toml",
    });
  }

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input }),
    });
  } catch (e) {
    throw new KenError("EMBEDDING_DOWN", `cannot reach OpenAI: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new KenError("EMBEDDING_DOWN", `OpenAI error ${res.status}: ${body.slice(0, 200)}`, {
      hint: res.status === 401 ? "check OPENAI_API_KEY" : undefined,
    });
  }

  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  if (!json.data || !Array.isArray(json.data)) {
    throw new KenError("EMBEDDING_DOWN", `unexpected OpenAI response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data.map((d) => Float32Array.from(d.embedding));
}

async function embedOllama(input: string[], model: string, url: string): Promise<Float32Array[]> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
  } catch (e) {
    throw new KenError("EMBEDDING_DOWN", `cannot reach Ollama at ${url}`, {
      hint: "is ollama running? try: brew services start ollama",
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new KenError("EMBEDDING_DOWN", `Ollama error ${res.status}: ${body}`, {
      hint: model ? `pulled the model? try: ollama pull ${model}` : undefined,
    });
  }

  const json = (await res.json()) as { embeddings?: number[][] };
  if (!json.embeddings || !Array.isArray(json.embeddings)) {
    throw new KenError("EMBEDDING_DOWN", `unexpected Ollama response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.embeddings.map((arr) => Float32Array.from(arr));
}
