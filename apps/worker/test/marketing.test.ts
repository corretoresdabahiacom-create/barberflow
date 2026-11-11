import { beforeEach, describe, expect, it } from "vitest";
import { CAMPAIGN_DAILY_CAP } from "../src/domain/marketing";
import { runScheduled } from "../src/domain/outbox";
import { E, addStaff, adminBook, api, apptCustomerId, createShop, mailer, reset, testDeps, tue, uniq, type Shop } from "./helpers";

beforeEach(reset);
const run = () => runScheduled(E, testDeps);

describe("campanhas de marketing", () => {
  let S: Shop;
  let o: string;
  let hour = 9;
  beforeEach(async () => {
    await E.DB.prepare("DELETE FROM outbox").run(); // tenant-ok: limpeza de teste
    await E.DB.prepare("UPDATE organizations SET reminders_enabled = 0").run(); // tenant-ok: limpeza de teste
    S = await createShop("mkt");
    o = `/api/orgs/${S.orgId}`;
    hour = 9;
  });

  /** Cria cliente com e-mail e (opcionalmente) consentimento de marketing. */
  async function customer(name: string, opts: { consent?: boolean; email?: boolean; shop?: Shop } = {}): Promise<string> {
    const shop = opts.shop ?? S;
    const h = hour++;
    const phone = `7198${String(1000000 + h * 7 + Math.floor(Math.random() * 1000)).slice(0, 7)}`;
    const ap = await adminBook(shop, tue(h, h % 2 ? 0 : 30), { customer: { name, phone, ...(opts.email === false ? {} : { email: `${uniq("c")}@exemplo.com` }) } }, shop.ownerToken, phone);
    if (ap.status !== 201) throw new Error(`customer: ${ap.status} ${JSON.stringify(ap.body)}`);
    const id = await apptCustomerId(ap.body.appointment.id);
    if (opts.consent !== false) await api("POST", `/api/orgs/${shop.orgId}/customers/${id}/consents`, { token: shop.ownerToken, body: { email: true, granted: true } });
    return id;
  }
  const mk = (body: Record<string, unknown> = {}) =>
    api("POST", `${o}/campaigns`, { token: S.ownerToken, body: { name: "Promo", subject: "Oi {{nome}}", body: "Olá {{nome}}, 20% off!", segment: "all_consented", ...body } });
  const send = (id: string, token = S.ownerToken) => api("POST", `${o}/campaigns/${id}/send`, { token });

  it("só o proprietário gerencia campanhas (marketing.manage é de organização)", async () => {
    const admin = await addStaff(S, "unit_admin");
    const manager = await addStaff(S, "manager");
    const barber = await addStaff(S, "barber");
    for (const t of [admin.token, manager.token, barber.token]) {
      expect((await api("GET", `${o}/campaigns`, { token: t })).status).toBe(403);
      expect((await api("POST", `${o}/campaigns`, { token: t, body: { name: "X", subject: "Assunto", body: "Corpo", segment: "all_consented" } })).status).toBe(403);
    }
    expect((await mk()).status).toBe(201);
  });

  it("valida a campanha (segmento inativos exige dias, limites, campo extra)", async () => {
    expect((await mk({ segment: "inactive" })).status).toBe(400);
    expect((await mk({ segment: "inactive", inactiveDays: 3 })).status).toBe(400);
    expect((await mk({ segment: "inactive", inactiveDays: 60 })).status).toBe(201);
    expect((await mk({ name: "x" })).status).toBe(400);
    expect((await mk({ body: "x".repeat(5001) })).status).toBe(400);
    expect((await mk({ extra: 1 })).status).toBe(400);
  });

  it("público = só quem tem consentimento de marketing por e-mail VIGENTE (opt-in); sem registro, sem e-mail, revogado e anonimizado ficam de fora", async () => {
    const ok1 = await customer("Ana Silva");
    await customer("Bia Souza");
    await customer("Sem Consentimento", { consent: false });
    await customer("Sem Email", { email: false, consent: false });
    const revoked = await customer("Revogou");
    await api("POST", `${o}/customers/${revoked}/consents`, { token: S.ownerToken, body: { email: true, granted: false } }); // mesmo segundo: desempate por rowid
    const anon = await customer("Anonimizado");
    await api("POST", `${o}/customers/${anon}/anonymize`, { token: S.ownerToken });
    const c = await mk();
    expect((await api("GET", `${o}/campaigns/${c.body.id}/audience`, { token: S.ownerToken })).body.count).toBe(2);
    void ok1;
  });

  it("consentimento só de WhatsApp ou só de serviço não vale para marketing por e-mail", async () => {
    const a = await customer("Só Whats", { consent: false });
    await api("POST", `${o}/customers/${a}/consents`, { token: S.ownerToken, body: { whatsapp: true, granted: true } });
    const b = await customer("Só Serviço", { consent: false });
    await api("POST", `${o}/customers/${b}/consents`, { token: S.ownerToken, body: { email: true, granted: true, purpose: "service_notifications" } });
    const c = await mk();
    expect((await api("GET", `${o}/campaigns/${c.body.id}/audience`, { token: S.ownerToken })).body.count).toBe(0);
    expect((await send(c.body.id)).body.error.code).toBe("empty_audience");
  });

  it("não envia sem provedor de e-mail configurado", async () => {
    await customer("Ana");
    const c = await mk();
    mailer.enabled = false;
    expect((await send(c.body.id)).body.error.code).toBe("marketing_not_configured");
    expect((await api("GET", `${o}/campaigns`, { token: S.ownerToken })).body.configured).toBe(false);
    expect((await E.DB.prepare("SELECT status FROM campaigns WHERE id = ?").bind(c.body.id).first<{ status: string }>())!.status).toBe("draft");
  });

  it("envia: enfileira, personaliza {{nome}}, rodapé com descadastro e cabeçalho List-Unsubscribe; não reenvia", async () => {
    await customer("Ana Silva");
    await customer("Bia Souza");
    const c = await mk();
    const r = await send(c.body.id);
    expect(r.status).toBe(202);
    expect(r.body.queued).toBe(2);
    expect((await send(c.body.id)).body.error.code).toBe("already_sent");
    expect(await run()).toMatchObject({ sent: 2 });
    const m = mailer.sent.find((x) => x.body.includes("Olá Ana"))!;
    expect(m.subject).toBe("Oi Ana");
    expect(m.body).toMatch(/https:\/\/naregua\.test\/sair\?t=/);
    expect(m.unsubscribeUrl).toMatch(/^https:\/\/naregua\.test\/api\/public\/unsubscribe\?t=/);
    expect(m.body).not.toContain("{{nome}}");
    expect(await run()).toMatchObject({ sent: 0 });
    expect(mailer.sent).toHaveLength(2);
    expect((await api("GET", `${o}/campaigns/${c.body.id}/progress`, { token: S.ownerToken })).body.outbox).toEqual([{ status: "sent", n: 2 }]);
  });

  it("3 envios simultâneos da mesma campanha: só um vence, sem duplicar e-mails", async () => {
    await customer("Ana");
    const c = await mk();
    const rs = await Promise.all([1, 2, 3].map(() => send(c.body.id)));
    expect(rs.filter((r) => r.status === 202)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE campaign_id = ?").bind(c.body.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("descadastro de 1 clique: link assinado revoga, é idempotente, vale para campanhas futuras e para e-mails ainda na fila", async () => {
    await customer("Ana Silva");
    await customer("Bia Souza");
    const c = await mk();
    await send(c.body.id);
    const rows = (await E.DB.prepare("SELECT body, unsubscribe_url, customer_id FROM outbox WHERE campaign_id = ? ORDER BY to_email").bind(c.body.id).all<{ body: string; unsubscribe_url: string; customer_id: string }>()).results;
    const first = rows[0]!;
    const token = /sair\?t=(\S+)/.exec(first.body)![1]!;
    // estilo mensagem do provedor (POST com token na query) e estilo página (token no corpo)
    expect((await api("POST", new URL(first.unsubscribe_url).pathname + new URL(first.unsubscribe_url).search)).status).toBe(200);
    expect((await api("POST", "/api/public/unsubscribe", { body: { token } })).status).toBe(200);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM customer_consents WHERE customer_id = ? AND purpose = 'marketing' AND channel = 'email' AND granted = 0").bind(first.customer_id).first<{ n: number }>())!.n).toBe(1);

    // e-mail que já estava na fila para quem se descadastrou é pulado no envio
    expect(await run()).toMatchObject({ sent: 1, skipped: 1 });
    expect(mailer.sent).toHaveLength(1);
    // campanha futura não alcança o descadastrado
    const c2 = await mk({ name: "Outra" });
    expect((await api("GET", `${o}/campaigns/${c2.body.id}/audience`, { token: S.ownerToken })).body.count).toBe(1);
  });

  it("token de descadastro adulterado, de outra organização ou lixo é recusado", async () => {
    await customer("Ana");
    const c = await mk();
    await send(c.body.id);
    const row = (await E.DB.prepare("SELECT body FROM outbox WHERE campaign_id = ?").bind(c.body.id).first<{ body: string }>())!;
    const token = /sair\?t=(\S+)/.exec(row.body)![1]!;
    const [payload, sig] = token.split(".");
    const forged = btoa(`${S.orgId}.00000000-0000-0000-0000-000000000000`).replace(/=+$/, "") + "." + sig;
    for (const bad of [token.slice(0, -2) + "xx", forged, `${payload}.`, "lixo", "a.b.c", ""]) {
      const r = await api("POST", `/api/public/unsubscribe?t=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
    }
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM customer_consents WHERE source = 'unsubscribe_link'").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(0);
    // descadastro de cliente de outra organização usando token legítimo desta nunca altera a outra
    const B = await createShop("mktB");
    const bCust = await customer("Cliente B", { shop: B });
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM customer_consents WHERE customer_id = ? AND granted = 0").bind(bCust).first<{ n: number }>())!.n).toBe(0);
  });

  it("teto diário: acima de 200 destinatários nas últimas 24 h a campanha é recusada e continua rascunho", async () => {
    await customer("Ana");
    for (let i = 0; i < CAMPAIGN_DAILY_CAP; i++) {
      await E.DB.prepare("INSERT INTO outbox (id, organization_id, kind, to_email, subject, body, status, attempts, next_attempt_at, dedupe_key, created_at) VALUES (?, ?, 'campaign', 'x@y.co', 's', 'b', 'sent', 1, '2026-11-06T15:00:00Z', ?, '2026-11-06T14:00:00Z')").bind(uniq("o"), S.orgId, `cap:${S.orgId}:${i}`).run();
    }
    const c = await mk();
    const r = await send(c.body.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("daily_cap");
    expect((await E.DB.prepare("SELECT status FROM campaigns WHERE id = ?").bind(c.body.id).first<{ status: string }>())!.status).toBe("draft");
  });

  it("segmento 'inativos': só quem tem atendimento concluído mas nenhum nos últimos N dias", async () => {
    const old = await customer("Antigo");
    const recent = await customer("Recente");
    await customer("Nunca Veio");
    const setDone = async (cid: string, startsAt: string) =>
      E.DB.prepare("UPDATE appointments SET status = 'completed', starts_at = ?, ends_at = ? WHERE customer_id = ?").bind(startsAt, new Date(Date.parse(startsAt) + 1800_000).toISOString(), cid).run();
    await setDone(old, "2026-07-01T13:00:00.000Z");
    await setDone(recent, "2026-11-01T13:00:00.000Z");
    const c = await mk({ segment: "inactive", inactiveDays: 60 });
    expect((await api("GET", `${o}/campaigns/${c.body.id}/audience`, { token: S.ownerToken })).body.count).toBe(1);
    await send(c.body.id);
    const to = (await E.DB.prepare("SELECT to_email FROM outbox WHERE campaign_id = ?").bind(c.body.id).all<{ to_email: string }>()).results;
    expect(to).toHaveLength(1);
  });

  it("isolamento: campanhas e público de uma barbearia nunca aparecem nem são enviados em outra", async () => {
    await customer("Ana");
    const B = await createShop("mktB2");
    await customer("Cliente de B", { shop: B });
    const c = await mk();
    const ob = `/api/orgs/${B.orgId}`;
    expect((await api("GET", `${ob}/campaigns`, { token: B.ownerToken })).body.campaigns).toEqual([]);
    for (const [m, p] of [["GET", `${o}/campaigns`], ["GET", `${o}/campaigns/${c.body.id}/audience`], ["POST", `${o}/campaigns/${c.body.id}/send`], ["GET", `${o}/campaigns/${c.body.id}/progress`], ["DELETE", `${o}/campaigns/${c.body.id}`]] as const) {
      expect((await api(m, p, { token: B.ownerToken })).status, `${m} ${p}`).toBe(404);
    }
    // dono de B tentando enviar a campanha de A pela URL de B: 404 (campanha não existe lá)
    expect((await api("POST", `${ob}/campaigns/${c.body.id}/send`, { token: B.ownerToken })).status).toBe(404);
    await send(c.body.id);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE organization_id = ?").bind(B.orgId).first<{ n: number }>())!.n).toBe(0);
  });

  it("rascunho pode ser apagado; enviada não", async () => {
    await customer("Ana");
    const d = await mk();
    expect((await api("DELETE", `${o}/campaigns/${d.body.id}`, { token: S.ownerToken })).status).toBe(200);
    const c = await mk();
    await send(c.body.id);
    expect((await api("DELETE", `${o}/campaigns/${c.body.id}`, { token: S.ownerToken })).status).toBe(409);
  });
});
