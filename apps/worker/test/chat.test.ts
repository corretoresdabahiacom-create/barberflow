import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, bookedCustomer, createShop, reset, signToken, tue, uniq, type Shop } from "./helpers";

beforeEach(reset);

describe("chat cliente ↔ barbearia", () => {
  let S: Shop;
  let o: string;
  beforeEach(async () => {
    S = await createShop("chat");
    o = `/api/orgs/${S.orgId}`;
  });
  const say = (token: string, body: unknown, slug = S.slug) => api("POST", `/api/me/chat/${slug}/messages`, { token, body });
  const threads = async (token = S.ownerToken) => (await api("GET", `${o}/chat/threads`, { token })).body.threads as { id: string; staff_unread: number; customer_name: string; last_body: string; status: string }[];

  it("só conversa quem já agendou naquela unidade, com vínculo verificado", async () => {
    const stranger = await signToken({ uid: uniq("x-") });
    expect((await say(stranger, { body: "oi" })).body.error.code).toBe("chat_unavailable");
    // agendou por telefone, sem e-mail verificado vinculado → também não
    await adminBook(S, tue(11), { customer: { name: "Sem Conta", phone: "71944443333" } });
    expect((await say(stranger, { body: "oi" })).status).toBe(403);
    expect((await api("GET", `/api/me/chat/${S.slug}/messages`, { token: stranger })).status).toBe(403);
    expect((await api("GET", "/api/me/chat", { token: stranger })).body.chats).toEqual([]);
  });

  it("cliente da matriz não conversa com a filial onde nunca agendou (mesma organização)", async () => {
    const c = await bookedCustomer(S);
    const slug2 = uniq("fil-").toLowerCase();
    expect((await api("POST", `${o}/units`, { token: S.ownerToken, body: { name: "Filial", slug: slug2 } })).status).toBe(201);
    expect((await say(c.token, { body: "oi" }, slug2)).body.error.code).toBe("chat_unavailable");
    expect((await api("GET", `/api/me/chat/${slug2}/messages`, { token: c.token })).status).toBe(403);
    expect((await api("GET", "/api/me/chat", { token: c.token })).body.chats.map((x: { unit_slug: string }) => x.unit_slug)).toEqual([S.slug]);
  });

  it("fluxo completo: mensagem, não lidas, resposta, ordem e leitura", async () => {
    const c = await bookedCustomer(S);
    expect((await api("GET", "/api/me/chat", { token: c.token })).body.chats[0]).toMatchObject({ unit_slug: S.slug, thread_id: null, unread: 0 });
    expect((await say(c.token, { body: "Posso chegar mais tarde?" })).status).toBe(201);
    expect((await say(c.token, { body: "Uns 10 minutos" })).status).toBe(201);
    const [t] = await threads();
    expect(t).toMatchObject({ staff_unread: 2, customer_name: "Cliente Chat", last_body: "Uns 10 minutos" });

    const read = await api("GET", `${o}/chat/threads/${t!.id}/messages`, { token: S.ownerToken });
    expect(read.body.messages.map((m: { body: string }) => m.body)).toEqual(["Posso chegar mais tarde?", "Uns 10 minutos"]);
    expect((await threads())[0]!.staff_unread).toBe(0);

    expect((await api("POST", `${o}/chat/threads/${t!.id}/messages`, { token: S.ownerToken, body: { body: "Pode vir!" } })).status).toBe(201);
    expect((await api("GET", "/api/me/chat", { token: c.token })).body.chats[0].unread).toBe(1);
    const mine = await api("GET", `/api/me/chat/${S.slug}/messages`, { token: c.token });
    expect(mine.body.messages.map((m: { sender_kind: string }) => m.sender_kind)).toEqual(["customer", "customer", "staff"]);
    expect((await api("GET", "/api/me/chat", { token: c.token })).body.chats[0].unread).toBe(0);
  });

  it("valida mensagem (vazia, longa, campo extra) e limita a 20 mensagens por 10 min", async () => {
    const c = await bookedCustomer(S);
    expect((await say(c.token, { body: "   " })).status).toBe(400);
    expect((await say(c.token, { body: "x".repeat(1001) })).status).toBe(400);
    expect((await say(c.token, { body: "ok", extra: 1 })).status).toBe(400);
    for (let i = 0; i < 20; i++) expect((await say(c.token, { body: `m${i}` })).status).toBe(201);
    expect((await say(c.token, { body: "demais" })).status).toBe(429);
  });

  it("equipe bloqueia/reabre a conversa", async () => {
    const c = await bookedCustomer(S);
    await say(c.token, { body: "oi" });
    const t = (await threads())[0]!;
    expect((await api("PATCH", `${o}/chat/threads/${t.id}`, { token: S.ownerToken, body: { status: "blocked" } })).status).toBe(200);
    expect((await say(c.token, { body: "ainda aí?" })).status).toBe(403);
    expect((await api("POST", `${o}/chat/threads/${t.id}/messages`, { token: S.ownerToken, body: { body: "x" } })).status).toBe(409);
    await api("PATCH", `${o}/chat/threads/${t.id}`, { token: S.ownerToken, body: { status: "open" } });
    expect((await say(c.token, { body: "voltei" })).status).toBe(201);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND action LIKE 'chat.%'").bind(S.orgId).first<{ n: number }>())!.n).toBe(2);
  });

  it("mensagens são imutáveis; cada cliente só vê a própria conversa; aviso interno para a equipe", async () => {
    const a = await bookedCustomer(S, { hour: 10, phone: "71955554444" });
    const b = await bookedCustomer(S, { hour: 11, phone: "71966665555", name: "Outro Cliente" });
    await say(a.token, { body: "segredo do A" });
    expect((await api("GET", `/api/me/chat/${S.slug}/messages`, { token: b.token })).body.messages).toEqual([]);
    await expect(E.DB.prepare("UPDATE chat_messages SET body = 'x' WHERE organization_id = ?").bind(S.orgId).run()).rejects.toThrow(/append_only/);
    const n = await api("GET", "/api/me/notifications", { token: S.ownerToken });
    expect(n.body.notifications.some((x: { title: string }) => x.title === "Mensagem de Cliente Chat")).toBe(true);
  });

  it("permissões: barbeiro não acessa; gerente sim; gerente de outra unidade não", async () => {
    const c = await bookedCustomer(S);
    await say(c.token, { body: "oi" });
    const t = (await threads())[0]!;
    const barber = await addStaff(S, "barber");
    const manager = await addStaff(S, "manager");
    expect((await api("GET", `${o}/chat/threads`, { token: barber.token })).status).toBe(403);
    expect((await api("GET", `${o}/chat/threads/${t.id}/messages`, { token: barber.token })).status).toBe(403);
    expect((await api("POST", `${o}/chat/threads/${t.id}/messages`, { token: barber.token, body: { body: "x" } })).status).toBe(403);
    expect((await api("GET", `${o}/chat/threads/${t.id}/messages`, { token: manager.token })).status).toBe(200);

    const u2 = await api("POST", `${o}/units`, { token: S.ownerToken, body: { name: "Filial", slug: uniq("fil-").toLowerCase() } });
    const t2 = uniq("th-") + "0123456789";
    await E.DB.prepare("INSERT INTO chat_threads (id, organization_id, unit_id, customer_id, status, customer_unread, staff_unread, last_message_at, created_at) VALUES (?, ?, ?, ?, 'open', 0, 0, '2026-11-06T15:00:00Z', '2026-11-06T15:00:00Z')").bind(t2, S.orgId, u2.body.id, c.customerId).run();
    expect((await api("GET", `${o}/chat/threads/${t2}/messages`, { token: manager.token })).status).toBe(403);
    expect((await api("GET", `${o}/chat/threads`, { token: manager.token })).body.threads.map((x: { id: string }) => x.id)).not.toContain(t2);
    expect((await api("GET", `${o}/chat/threads?unitId=${u2.body.id}`, { token: manager.token })).status).toBe(403);
  });

  it("isolamento: outra barbearia não lê/escreve nem lista conversas; cliente não usa chat de unidade onde nunca agendou", async () => {
    const c = await bookedCustomer(S);
    await say(c.token, { body: "oi" });
    const t = (await threads())[0]!;
    const B = await createShop("chatB");
    const ob = `/api/orgs/${B.orgId}`;
    expect((await api("GET", `${ob}/chat/threads`, { token: B.ownerToken })).body.threads).toEqual([]);
    expect((await api("GET", `${ob}/chat/threads/${t.id}/messages`, { token: B.ownerToken })).status).toBe(404);
    expect((await api("POST", `${ob}/chat/threads/${t.id}/messages`, { token: B.ownerToken, body: { body: "x" } })).status).toBe(404);
    expect((await api("PATCH", `${ob}/chat/threads/${t.id}`, { token: B.ownerToken, body: { status: "blocked" } })).status).toBe(404);
    expect((await api("GET", `${o}/chat/threads`, { token: B.ownerToken })).status).toBe(404);
    expect((await say(c.token, { body: "oi" }, B.slug)).status).toBe(403); // nunca agendou na B
  });

  it("LGPD: exportação inclui o chat; anonimização apaga conversas e esvazia e-mails pendentes", async () => {
    const c = await bookedCustomer(S);
    await say(c.token, { body: "meu telefone é 71 9999" });
    const exp = await api("GET", `${o}/customers/${c.customerId}/export`, { token: S.ownerToken });
    expect(exp.body.chatMessages.map((m: { body: string }) => m.body)).toContain("meu telefone é 71 9999");
    await E.DB.prepare("INSERT INTO outbox (id, organization_id, customer_id, kind, to_email, subject, body, status, attempts, next_attempt_at, dedupe_key, created_at) VALUES (?, ?, ?, 'reminder', 'a@b.co', 'S', 'B', 'pending', 0, '2026-11-06T15:00:00Z', ?, '2026-11-06T15:00:00Z')").bind(uniq("ob-"), S.orgId, c.customerId, uniq("dk-")).run();
    expect((await api("POST", `${o}/customers/${c.customerId}/anonymize`, { token: S.ownerToken })).status).toBe(200);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE organization_id = ?").bind(S.orgId).first<{ n: number }>())!.n).toBe(0);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE organization_id = ?").bind(S.orgId).first<{ n: number }>())!.n).toBe(0);
    const ob = await E.DB.prepare("SELECT status, to_email, body FROM outbox WHERE customer_id = ?").bind(c.customerId).first<{ status: string; to_email: string; body: string }>();
    expect(ob).toEqual({ status: "skipped", to_email: "removido", body: "" });
    expect((await say(c.token, { body: "oi" })).status).toBe(403); // vínculo da conta removido
  });
});
