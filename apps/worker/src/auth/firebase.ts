import type { Env, TokenClaims } from "../env";
import { b64urlToBytes } from "../lib/util";

/**
 * Verificação de ID token do Firebase Authentication (RS256) com WebCrypto.
 * Custo de CPU baixo (uma verificação RSA), compatível com o limite do plano Free do Workers.
 * Senhas nunca passam pelo Worker: o Firebase Auth cuida de credenciais.
 */

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_SEC = 60;

type GetKey = (kid: string) => Promise<JsonWebKey | null>;

const dec = (s: string) => new TextDecoder().decode(b64urlToBytes(s));

export async function verifyIdTokenWith(
  token: string,
  projectId: string,
  getKey: GetKey,
  nowSec: number,
): Promise<TokenClaims | null> {
  if (!projectId) return null;
  const segs = token.split(".");
  if (segs.length !== 3) return null;
  const [h, p, s] = segs as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(dec(h));
    payload = JSON.parse(dec(p));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const jwk = await getKey(header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const { iss, aud, exp, iat, sub, auth_time } = payload as Record<string, unknown>;
  if (iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (aud !== projectId) return null;
  if (typeof exp !== "number" || exp <= nowSec) return null;
  if (typeof iat !== "number" || iat > nowSec + CLOCK_SKEW_SEC) return null;
  if (typeof auth_time === "number" && auth_time > nowSec + CLOCK_SKEW_SEC) return null;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) return null;

  return {
    uid: sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
    iat,
  };
}

// ---- Provedor de chaves públicas (JWKS) com cache por isolate ----
let cache: { keys: Map<string, JsonWebKey>; expiresAt: number; lastFetch: number } | null = null;

async function fetchJwks(nowMs: number): Promise<void> {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`jwks_fetch_failed:${res.status}`);
  const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const ttl = Math.min(Math.max(Number(maxAge ?? 3600), 300), 86400) * 1000;
  cache = {
    keys: new Map(body.keys.map((k) => [k.kid, k])),
    expiresAt: nowMs + ttl,
    lastFetch: nowMs,
  };
}

async function getGoogleKey(kid: string): Promise<JsonWebKey | null> {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) await fetchJwks(now);
  let k = cache?.keys.get(kid) ?? null;
  // chave desconhecida: no máximo uma nova busca por minuto (evita amplificação por tokens forjados)
  if (!k && cache && now - cache.lastFetch > 60_000) {
    await fetchJwks(now);
    k = cache?.keys.get(kid) ?? null;
  }
  return k;
}

export async function verifyFirebaseToken(token: string, env: Env): Promise<TokenClaims | null> {
  try {
    return await verifyIdTokenWith(token, env.FIREBASE_PROJECT_ID, getGoogleKey, Math.floor(Date.now() / 1000));
  } catch {
    return null;
  }
}
