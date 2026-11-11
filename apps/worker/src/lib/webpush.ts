/**
 * Web Push com WebCrypto: VAPID (RFC 8292, ES256) + criptografia de mensagem aes128gcm (RFC 8291).
 * Sem dependências externas. A criptografia é validada contra o vetor de teste do próprio RFC 8291.
 */
import { b64urlToBytes } from "./util";

const enc = new TextEncoder();

export const toB64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
}

export interface EphemeralKey {
  /** ponto público não comprimido (65 bytes) */
  publicRaw: Uint8Array;
  privateKey: CryptoKey;
}

export async function generateEphemeral(): Promise<EphemeralKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { publicRaw: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer), privateKey: pair.privateKey };
}

/** Criptografa `plaintext` para a assinatura (p256dh/auth em base64url). `eph` e `salt` só são injetados em testes. */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  opts: { eph?: EphemeralKey; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const ua = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (ua.length !== 65 || ua[0] !== 4 || authSecret.length !== 16) throw new Error("invalid_subscription_keys");
  const eph = opts.eph ?? (await generateEphemeral());
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await crypto.subtle.importKey("raw", ua as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, eph.privateKey, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), ua, eph.publicRaw);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  if (plaintext.length > 3993) throw new Error("payload_too_large"); // 4096 − 86 de cabeçalho − 17 (delimitador + tag)
  const padded = concat(plaintext, new Uint8Array([2])); // delimitador do último (único) registro
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aes, padded as BufferSource));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([eph.publicRaw.length]), eph.publicRaw, ct);
}

/** JWT VAPID (ES256). `privateB64` = chave privada bruta (32 bytes) e `publicB64` = ponto público (65 bytes), ambos base64url. */
export async function vapidAuthHeader(endpoint: string, subject: string, publicB64: string, privateB64: string, nowSec: number): Promise<string> {
  const pub = b64urlToBytes(publicB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("invalid_vapid_public_key");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)), d: privateB64, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const header = toB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = toB64url(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`)));
  return `vapid t=${header}.${payload}.${toB64url(sig)}, k=${publicB64}`;
}

/** Apenas serviços de push conhecidos: o Worker nunca faz requisição para um host arbitrário informado pelo usuário (SSRF). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && u.port === "" && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}
