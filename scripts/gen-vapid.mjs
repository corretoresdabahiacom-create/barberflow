// Gera um par de chaves VAPID (P-256) para Web Push. Uso: node scripts/gen-vapid.mjs
// Guarde a PRIVADA só como segredo (wrangler secret put VAPID_PRIVATE_KEY); a pública vai em vars + no front.
import { webcrypto as crypto } from "node:crypto";
const b64u = (b) => Buffer.from(b).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log("VAPID_PUBLIC_KEY =", b64u(pub));
console.log("VAPID_PRIVATE_KEY =", jwk.d, "(segredo: não commitar)");
