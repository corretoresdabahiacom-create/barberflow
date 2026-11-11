import { b64urlToBytes } from "./util";
import { toB64url } from "./webpush";

/** Token de descadastro assinado (HMAC-SHA256): `base64url(orgId.customerId).assinatura`. Não expira (o descadastro deve sempre funcionar). */
const hmacKey = (secret: string, usage: ("sign" | "verify")[]) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

export async function makeUnsubToken(secret: string, orgId: string, customerId: string): Promise<string> {
  const payload = toB64url(new TextEncoder().encode(`${orgId}.${customerId}`));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), new TextEncoder().encode(payload)));
  return `${payload}.${toB64url(sig)}`;
}

export async function verifyUnsubToken(secret: string, token: string): Promise<{ orgId: string; customerId: string } | null> {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), b64urlToBytes(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!ok) return null;
    const [orgId, customerId, more] = new TextDecoder().decode(b64urlToBytes(payload)).split(".");
    if (!orgId || !customerId || more !== undefined) return null;
    return { orgId, customerId };
  } catch {
    return null;
  }
}
