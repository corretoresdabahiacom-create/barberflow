import { describe, expect, it } from "vitest";
import { b64urlToBytes } from "../src/lib/util";
import { encryptPayload, isAllowedPushEndpoint, toB64url, vapidAuthHeader, type EphemeralKey } from "../src/lib/webpush";

// Vetor de teste do RFC 8291, seção 5 / Apêndice A.
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function ephFromVector(): Promise<EphemeralKey> {
  const pub = b64urlToBytes(V.asPublic);
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)), d: V.asPrivate, ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { publicRaw: pub, privateKey };
}

describe("Web Push (RFC 8291 / RFC 8292)", () => {
  it("reproduz exatamente o vetor de teste do RFC 8291", async () => {
    const out = await encryptPayload(new TextEncoder().encode(V.plaintext), V.uaPublic, V.authSecret, { eph: await ephFromVector(), salt: b64urlToBytes(V.salt) });
    expect(toB64url(out)).toBe(V.body);
  });

  it("round-trip com chaves aleatórias: o receptor (user agent) decifra o que foi enviado", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const uaPub = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const msg = JSON.stringify({ title: "Olá", body: "Mensagem com acentuação ção" });
    const body = await encryptPayload(new TextEncoder().encode(msg), toB64url(uaPub), toB64url(authSecret));

    // decifragem do lado do navegador (RFC 8291 §3.4)
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const asPub = body.slice(21, 21 + idlen);
    const ct = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, ua.privateKey, 256));
    const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
      new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
    const e = new TextEncoder();
    const ikm = await hk(authSecret, ecdh, new Uint8Array([...e.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
    const cek = await hk(salt, ikm, e.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hk(salt, ikm, e.encode("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
    expect(plain[plain.length - 1]).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(msg);
  });

  it("recusa chaves de assinatura inválidas e payload grande demais", async () => {
    await expect(encryptPayload(new Uint8Array([1]), "AAAA", V.authSecret)).rejects.toThrow(/invalid_subscription_keys/);
    await expect(encryptPayload(new Uint8Array(4000), V.uaPublic, V.authSecret)).rejects.toThrow(/payload_too_large/);
  });

  it("VAPID: JWT ES256 verificável com a chave pública, aud = origem do endpoint", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const priv = ((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey).d!;
    const h = await vapidAuthHeader("https://fcm.googleapis.com/fcm/send/abc", "mailto:contato@exemplo.com", toB64url(pub), priv, 1_800_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(toB64url(pub));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[2]!)));
    expect(payload).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:contato@exemplo.com", exp: 1_800_000_000 + 12 * 3600 });
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64urlToBytes(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });

  it("allowlist de endpoints (anti-SSRF)", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.com/x", "https://localhost/x", "https://169.254.169.254/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "not a url"]) expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });
});
