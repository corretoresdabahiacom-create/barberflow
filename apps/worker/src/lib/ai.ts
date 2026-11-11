import type { AiClient, AiRequest, AiResult, Env } from "../env";

/**
 * Cadeia de provedores de IA (fallback). NENHUM deles foi chamado de verdade nesta fase (sem chaves):
 * os formatos de requisição seguem a documentação pública de cada provedor e são cobertos por testes com `fetch` falso.
 * Todos têm timeout; qualquer erro/vazio passa para o próximo.
 */
export const AI_TIMEOUT_MS = 15_000;
export const DEFAULT_ORDER = ["gemini", "groq", "openrouter", "workers-ai", "xai"];

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Provider {
  id: string;
  enabled: (env: Env) => boolean;
  run: (req: AiRequest, env: Env, f: FetchLike) => Promise<string>;
}

class ProviderError extends Error {}

async function postJson(f: FetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!res.ok) throw new ProviderError(`http_${res.status}`);
  return res.json();
}

/** Formato "OpenAI-compatível" (Groq, OpenRouter, xAI/Grok). */
function openAiCompatible(id: string, url: string, key: (e: Env) => string | undefined, model: (e: Env) => string | undefined): Provider {
  return {
    id,
    enabled: (e) => Boolean(key(e) && model(e)),
    run: async (req, env, f) => {
      const data = (await postJson(f, url, { authorization: `Bearer ${key(env)}` }, {
        model: model(env),
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        max_tokens: req.maxTokens,
        temperature: 0.7,
      })) as { choices?: { message?: { content?: unknown } }[] };
      const t = data.choices?.[0]?.message?.content;
      return typeof t === "string" ? t : "";
    },
  };
}

const PROVIDERS: Provider[] = [
  {
    id: "gemini",
    enabled: (e) => Boolean(e.GEMINI_API_KEY),
    run: async (req, env, f) => {
      const model = encodeURIComponent(env.GEMINI_MODEL || "gemini-2.5-flash");
      const data = (await postJson(f, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": env.GEMINI_API_KEY! }, {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { maxOutputTokens: req.maxTokens, temperature: 0.7 },
      })) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };
      return (data.candidates?.[0]?.content?.parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    },
  },
  openAiCompatible("groq", "https://api.groq.com/openai/v1/chat/completions", (e) => e.GROQ_API_KEY, (e) => e.GROQ_MODEL || "llama-3.3-70b-versatile"),
  openAiCompatible("openrouter", "https://openrouter.ai/api/v1/chat/completions", (e) => e.OPENROUTER_API_KEY, (e) => e.OPENROUTER_MODEL || "openrouter/free"),
  {
    id: "workers-ai",
    enabled: (e) => Boolean(e.AI),
    run: async (req, env) => {
      const out = (await env.AI!.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        max_tokens: req.maxTokens,
      })) as { response?: unknown };
      return typeof out?.response === "string" ? out.response : "";
    },
  },
  openAiCompatible("xai", "https://api.x.ai/v1/chat/completions", (e) => e.XAI_API_KEY, (e) => e.XAI_MODEL),
];

export function createAiClient(f: FetchLike = (u, i) => fetch(u, i)): AiClient {
  const chain = (env: Env): Provider[] => {
    const order = (env.AI_PROVIDER_ORDER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ids = order.length ? order : DEFAULT_ORDER;
    return ids.map((id) => PROVIDERS.find((p) => p.id === id)).filter((p): p is Provider => !!p && p.enabled(env));
  };
  return {
    available: (env) => chain(env).map((p) => p.id),
    generate: async (req, env): Promise<AiResult> => {
      for (const p of chain(env)) {
        try {
          const text = (await p.run(req, env, f)).trim();
          if (text) return { text, provider: p.id };
        } catch (e) {
          // Só metadados no log: nunca o prompt nem a resposta.
          console.error("ai_provider_failed", p.id, e instanceof Error ? e.message.slice(0, 60) : "unknown");
        }
      }
      throw new Error("ai_unavailable");
    },
  };
}
