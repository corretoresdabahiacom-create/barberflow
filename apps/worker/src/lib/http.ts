import type { Context } from "hono";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const notFound = () => new HttpError(404, "not_found", "Recurso não encontrado");
export const forbidden = () => new HttpError(403, "forbidden", "Sem permissão para esta ação");

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Corpo da requisição inválido");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, "validation_error", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) {
    throw new HttpError(400, "validation_error", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}

/** Limitador em memória por isolate: proteção best-effort; a barreira forte é Turnstile + limites no banco. */
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number, nowMs: number): void {
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= nowMs) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= nowMs) {
    buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > limit) throw new HttpError(429, "rate_limited", "Muitas tentativas. Aguarde um pouco.");
}

export function resetRateLimits(): void {
  buckets.clear();
}
