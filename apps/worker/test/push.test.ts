import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, apptCustomerId, createShop, mailer, pusher, reset, signToken, tue, uniq, type Shop } from "./helpers";

beforeEach(reset);

const P256 = "B".repeat(87);
const AUTH = "A".repeat(22);
const sub = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: P256, auth: AUTH } });
void mailer;

describe("assinaturas Web Push", () => {
  it("config indica se o push está ativo", async () => {
    const t = await signToken({ uid: uniq("u-") });
    expect((await api("GET", "/api/me/push/config", { token: t })).body).toEqual({ enabled: true, publicKey: "teste" });
    pusher.enabled = false;
    expect((await api("GET", "/api/me/push/config", { token: t })).body).toEqual({ enabled: false, publicKey: null });
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: sub("x1") })).status).toBe(409);
  });

  it("exige login, valida formato e bloqueia endpoints fora da allowlist (SSRF)", async () => {
    const t = await signToken({ uid: uniq("u-") });
    expect((await api("POST", "/api/me/push/subscriptions", { body: sub("x") })).status).toBe(401);
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://169.254.169.254/latest", "https://fcm.googleapis.com.evil.com/x"]) {
      const r = await api("POST", "/api/me/push/subscriptions", { token: t, body: { endpoint, keys: { p256dh: P256, auth: AUTH } } });
      expect(r.status, endpoint).toBe(400);
    }
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: { endpoint: sub("x").endpoint, keys: { p256dh: "curta", auth: AUTH } } })).status).toBe(400);
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: { ...sub("x"), extra: 1 } })).status).toBe(400);
  });

  it("registra, é idempotente por endpoint, limita a 10 aparelhos e remove", async () => {
    const t = await signToken({ uid: uniq("u-") });
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: sub("a1") })).status).toBe(201);
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: sub("a1") })).status).toBe(201);
    for (let i = 2; i <= 10; i++) expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: sub(`a${i}`) })).status).toBe(201);
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: sub("a11") })).status).toBe(409);
    expect((await api("DELETE", "/api/me/push/subscriptions", { token: t, body: { endpoint: sub("a1").endpoint } })).status).toBe(200);
    expect((await api("POST", "/api/me/push/subscriptions", { token: t, body: sub("a11") })).status).toBe(201);
  });

  it("o mesmo aparelho muda de dono ao logar com outra conta (sem duplicar)", async () => {
    const t1 = await signToken({ uid: uniq("u-") });
    const t2 = await signToken({ uid: uniq("u-") });
    await api("POST", "/api/me/push/subscriptions", { token: t1, body: sub("shared") });
    await api("POST", "/api/me/push/subscriptions", { token: t2, body: sub("shared") });
    const rows = await E.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").bind(sub("shared").endpoint).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });
});

describe("push ao receber/enviar mensagem de chat", () => {
  let S: Shop;
  beforeEach(async () => {
    S = await createShop("pch");
  });

  async function customerWithAccount(): Promise<{ token: string; customerId: string }> {
    const uid = uniq("cli-");
    const email = `${uid}@teste.local`;
    const token = await signToken({ uid, email });
    await adminBook(S, tue(10), { customer: { name: "Cliente Push", phone: "71955554444", email } });
    await api("GET", "/api/me", { token }); // vincula por e-mail verificado
    return { token, customerId: await apptCustomerId((await E.DB.prepare("SELECT id FROM appointments WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(S.orgId).first<{ id: string }>())!.id) };
  }

  it("mensagem do cliente → push para o dono; resposta da equipe → push para o cliente; assinatura expirada é apagada", async () => {
    const cust = await customerWithAccount();
    await api("POST", "/api/me/push/subscriptions", { token: S.ownerToken, body: sub("owner-dev") });
    await api("POST", "/api/me/push/subscriptions", { token: cust.token, body: sub("cust-dev") });

    const send = await api("POST", `/api/me/chat/${S.slug}/messages`, { token: cust.token, body: { body: "Posso chegar 10 min atrasado?" } });
    expect(send.status, JSON.stringify(send.body)).toBe(201);
    expect(pusher.sent.map((p) => p.endpoint)).toEqual([sub("owner-dev").endpoint]);
    expect(JSON.parse(pusher.sent[0]!.payload)).toMatchObject({ title: "Mensagem de Cliente Push", url: "/app/chat" });

    const threads = await api("GET", `/api/orgs/${S.orgId}/chat/threads`, { token: S.ownerToken });
    const reply = await api("POST", `/api/orgs/${S.orgId}/chat/threads/${threads.body.threads[0].id}/messages`, { token: S.ownerToken, body: { body: "Pode sim!" } });
    expect(reply.status).toBe(201);
    expect(pusher.sent.map((p) => p.endpoint)).toContain(sub("cust-dev").endpoint);

    pusher.goneEndpoints.add(sub("cust-dev").endpoint);
    await api("POST", `/api/orgs/${S.orgId}/chat/threads/${threads.body.threads[0].id}/messages`, { token: S.ownerToken, body: { body: "Até já" } });
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?").bind(sub("cust-dev").endpoint).first<{ n: number }>())!.n).toBe(0);
  });

  it("falha do serviço de push não derruba o chat (mensagem salva e 201)", async () => {
    const cust = await customerWithAccount();
    await api("POST", "/api/me/push/subscriptions", { token: S.ownerToken, body: sub("owner-dev2") });
    pusher.failWith = "push_service_500";
    const r = await api("POST", `/api/me/chat/${S.slug}/messages`, { token: cust.token, body: { body: "Olá" } });
    expect(r.status).toBe(201);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE organization_id = ?").bind(S.orgId).first<{ n: number }>())!.n).toBe(1);
  });

  it("push desligado: tudo funciona, nada é enviado", async () => {
    const cust = await customerWithAccount();
    pusher.enabled = false;
    expect((await api("POST", `/api/me/chat/${S.slug}/messages`, { token: cust.token, body: { body: "Olá" } })).status).toBe(201);
    expect(pusher.sent).toHaveLength(0);
    void addStaff;
  });
});
