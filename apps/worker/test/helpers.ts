import { env } from "cloudflare:workers";
import { createApp } from "../src/app";
import { verifyIdTokenWith } from "../src/auth/firebase";
import type { AppDeps, Env } from "../src/env";
import { resetRateLimits } from "../src/lib/http";

const PROJECT = "naregua-test";
const KID = "test-key-1";

const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uJson = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));

const genPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
const keyPair = await genPair();
const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
// Segunda chave, desconhecida do verificador: simula token assinado por terceiro.
const rogue = await genPair();

/** Relógio controlável: sexta-feira 2026-11-06 15:00Z (12:00 em São Paulo). */
export const clock = { ms: Date.UTC(2026, 10, 6, 15, 0, 0) };

export interface TokenOpts {
  uid: string;
  email?: string | null;
  verified?: boolean;
  name?: string;
  iat?: number;
  exp?: number;
  aud?: string;
  iss?: string;
  rogue?: boolean;
}

export async function signToken(o: TokenOpts): Promise<string> {
  const nowSec = Math.floor(clock.ms / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const payload = {
    iss: o.iss ?? `https://securetoken.google.com/${PROJECT}`,
    aud: o.aud ?? PROJECT,
    sub: o.uid,
    iat: o.iat ?? nowSec,
    exp: o.exp ?? nowSec + 3600,
    auth_time: nowSec,
    ...(o.email !== null ? { email: o.email ?? `${o.uid}@teste.local`, email_verified: o.verified ?? true } : {}),
    ...(o.name ? { name: o.name } : {}),
  };
  const data = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (o.rogue ? rogue.privateKey : keyPair.privateKey),
    new TextEncoder().encode(data),
  );
  return `${data}.${b64u(sig)}`;
}

/** Remetente falso controlável: registra envios e falha sob demanda. */
export const mailer = {
  enabled: true,
  sent: [] as { to: string; subject: string; body: string }[],
  failWith: null as string | null,
};

export const testDeps: AppDeps = {
  // MESMO código de verificação de produção; só a fonte das chaves públicas muda.
  verifyToken: async (token) =>
    verifyIdTokenWith(token, PROJECT, async (kid) => (kid === KID ? publicJwk : null), Math.floor(clock.ms / 1000)),
  verifyTurnstile: async (token) => token === "turnstile-ok",
  now: () => new Date(clock.ms),
  email: {
    enabled: () => mailer.enabled,
    send: async (m) => {
      if (mailer.failWith) throw new Error(mailer.failWith);
      mailer.sent.push(m);
    },
  },
};

export const app = createApp(testDeps);
export const E = env as unknown as Env;

export function reset(): void {
  resetRateLimits();
  mailer.enabled = true;
  mailer.sent = [];
  mailer.failWith = null;
  clock.ms = Date.UTC(2026, 10, 6, 15, 0, 0);
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(
    new Request(`https://naregua.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    E,
  );
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

let counter = 0;
export const uniq = (p: string): string => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface Shop {
  ownerToken: string;
  ownerUid: string;
  orgId: string;
  unitId: string;
  slug: string;
  serviceId: string;
  proId: string;
}

/** Cria dono + organização + unidade + serviço (R$ 50, 30 min) + profissional com agenda seg-sáb 09:00–18:00. */
export async function createShop(label = "loja"): Promise<Shop> {
  const ownerUid = uniq(`own-${label}-`);
  const ownerToken = await signToken({ uid: ownerUid });
  const slug = uniq(`${label}-`).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const org = await api("POST", "/api/orgs", { token: ownerToken, body: { name: `Barbearia ${label}`, unit: { name: "Matriz", slug } } });
  if (org.status !== 201) throw new Error(`createShop org: ${org.status} ${JSON.stringify(org.body)}`);
  const orgId: string = org.body.organizationId;
  const unitId: string = org.body.unitId;
  const svc = await api("POST", `/api/orgs/${orgId}/services`, { token: ownerToken, body: { name: "Corte", priceCents: 5000, durationMin: 30 } });
  const pro = await api("POST", `/api/orgs/${orgId}/professionals`, { token: ownerToken, body: { name: "João", unitIds: [unitId] } });
  const serviceId: string = svc.body.id;
  const proId: string = pro.body.id;
  await api("PUT", `/api/orgs/${orgId}/professionals/${proId}/services`, { token: ownerToken, body: { services: [{ serviceId }] } });
  const days = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));
  const sch = await api("PUT", `/api/orgs/${orgId}/professionals/${proId}/schedules`, { token: ownerToken, body: { unitId, days } });
  if (sch.status !== 200) throw new Error(`createShop schedule: ${sch.status} ${JSON.stringify(sch.body)}`);
  return { ownerToken, ownerUid, orgId, unitId, slug, serviceId, proId };
}

/** 2026-11-10 (terça) às HH:MM em São Paulo (UTC-3) → ISO UTC. */
export const tue = (hh: number, mm = 0): string => new Date(Date.UTC(2026, 10, 10, hh + 3, mm)).toISOString();

export interface Staff {
  token: string;
  uid: string;
  email: string;
  membershipId: string;
}

/** Cria usuário (login) e o vincula à unidade com o papel dado, via API do dono. */
export async function addStaff(shop: Shop, role: "unit_admin" | "manager" | "barber", opts: { unitId?: string; canReceivePayments?: boolean } = {}): Promise<Staff> {
  const uid = uniq(`${role}-`);
  const email = `${uid}@teste.local`;
  const token = await signToken({ uid, email });
  await api("GET", "/api/me", { token }); // cria o usuário local
  const r = await api("POST", `/api/orgs/${shop.orgId}/members`, {
    token: shop.ownerToken,
    body: { email, role, unitId: opts.unitId ?? shop.unitId, canReceivePayments: opts.canReceivePayments },
  });
  if (r.status !== 201) throw new Error(`addStaff ${role}: ${r.status} ${JSON.stringify(r.body)}`);
  return { token, uid, email, membershipId: r.body.id };
}

export async function adminBook(shop: Shop, startsAt: string, extra: Record<string, unknown> = {}, token = shop.ownerToken, phone = "71988887777") {
  return api("POST", `/api/orgs/${shop.orgId}/appointments`, {
    token,
    body: {
      unitId: shop.unitId, professionalId: shop.proId, serviceIds: [shop.serviceId], startsAt,
      customer: { name: "Cliente Teste", phone }, ...extra,
    },
  });
}

/** Move o relógio para depois do início do atendimento, renova o token do dono e conclui (confirma antes, se preciso). */
export async function completeAppt(shop: Shop, apptId: string): Promise<Res> {
  const row = await E.DB.prepare("SELECT starts_at FROM appointments WHERE id = ?").bind(apptId).first<{ starts_at: string }>();
  clock.ms = Date.parse(row!.starts_at) + 60 * 60_000;
  shop.ownerToken = await signToken({ uid: shop.ownerUid });
  await api("POST", `/api/orgs/${shop.orgId}/appointments/${apptId}/confirm`, { token: shop.ownerToken });
  return api("POST", `/api/orgs/${shop.orgId}/appointments/${apptId}/complete`, { token: shop.ownerToken });
}

export const apptCustomerId = async (apptId: string): Promise<string> =>
  (await E.DB.prepare("SELECT customer_id AS c FROM appointments WHERE id = ?").bind(apptId).first<{ c: string }>())!.c;
