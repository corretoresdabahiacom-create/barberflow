import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, createShop, reset, tue, type Shop } from "./helpers";

beforeEach(reset);

describe("pagamentos manuais", () => {
  let S: Shop;
  let apptId: string;
  let o: string;
  const pay = (body: unknown, key: string | null, token = S.ownerToken, id = apptId) =>
    api("POST", `${o}/appointments/${id}/payments`, { token, body, headers: key ? { "idempotency-key": key } : {} });

  beforeEach(async () => {
    S = await createShop("pay");
    o = `/api/orgs/${S.orgId}`;
    apptId = (await adminBook(S, tue(10))).body.appointment.id; // total R$ 50,00
  });

  it("exige Idempotency-Key", async () => {
    const r = await pay({ method: "cash", amountCents: 1000 }, null);
    expect(r.status).toBe(400);
    expect((await pay({ method: "cash", amountCents: 1000 }, "curta")).status).toBe(400);
  });

  it("registra, repete com a mesma chave sem duplicar, e recusa chave reutilizada com outros dados", async () => {
    const a = await pay({ method: "pix", amountCents: 3000 }, "chave-pix-0001");
    expect(a.status).toBe(201);
    const again = await pay({ method: "pix", amountCents: 3000 }, "chave-pix-0001");
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.payment.id).toBe(a.body.payment.id);
    expect((await pay({ method: "pix", amountCents: 1000 }, "chave-pix-0001")).body.error.code).toBe("idempotency_conflict");
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE appointment_id = ?").bind(apptId).first<{ n: number }>())!.n).toBe(1);
  });

  it("recusa pagamento acima do total; aceita o restante exato", async () => {
    expect((await pay({ method: "cash", amountCents: 3000 }, "chave-0001-aaaa")).status).toBe(201);
    const over = await pay({ method: "cash", amountCents: 2001 }, "chave-0002-aaaa");
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("overpayment");
    expect((await pay({ method: "cash", amountCents: 2000 }, "chave-0003-aaaa")).status).toBe(201);
    expect((await pay({ method: "cash", amountCents: 1 }, "chave-0004-aaaa")).status).toBe(409);
    const list = await api("GET", `${o}/appointments/${apptId}/payments`, { token: S.ownerToken });
    expect(list.body.payments.reduce((a: number, p: { amount_cents: number }) => a + p.amount_cents, 0)).toBe(5000);
  });

  it("dois pagamentos simultâneos que estourariam o total: só um passa", async () => {
    const rs = await Promise.all([
      pay({ method: "cash", amountCents: 3000 }, "chave-conc-0001"),
      pay({ method: "pix", amountCents: 3000 }, "chave-conc-0002"),
      pay({ method: "debit", amountCents: 3000 }, "chave-conc-0003"),
    ]);
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect(rs.filter((r) => r.status === 409).length).toBe(2);
    expect((await E.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM payments WHERE appointment_id = ?").bind(apptId).first<{ n: number }>())!.n).toBe(3000);
  });

  it("mesma chave em paralelo não duplica", async () => {
    const rs = await Promise.all(Array.from({ length: 4 }, () => pay({ method: "cash", amountCents: 1000 }, "chave-igual-par-1")));
    expect(rs.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE appointment_id = ?").bind(apptId).first<{ n: number }>())!.n).toBe(1);
  });

  it("valores inválidos e agendamento cancelado/pendente", async () => {
    expect((await pay({ method: "cash", amountCents: 0 }, "chave-zero-0001")).status).toBe(400);
    expect((await pay({ method: "cash", amountCents: -5 }, "chave-neg-00001")).status).toBe(400);
    expect((await pay({ method: "cash", amountCents: 10.5 }, "chave-frac-0001")).status).toBe(400);
    expect((await pay({ method: "bitcoin", amountCents: 100 }, "chave-meth-0001")).status).toBe(400);
    expect((await pay({ method: "cash", amountCents: 100, extra: true }, "chave-extra-001")).status).toBe(400);
    await api("POST", `${o}/appointments/${apptId}/cancel`, { token: S.ownerToken, body: {} });
    expect((await pay({ method: "cash", amountCents: 100 }, "chave-canc-0001")).body.error.code).toBe("not_payable");
    await api("PATCH", `${o}/units/${S.unitId}`, { token: S.ownerToken, body: { autoConfirm: false } });
    const pending = await api("POST", `/api/public/units/${S.slug}/appointments`, {
      body: { turnstileToken: "turnstile-ok", customer: { name: "Cliente Pend", phone: "71966665555" }, professionalId: S.proId, serviceIds: [S.serviceId], startsAt: tue(14) },
    });
    expect(pending.body.appointment.status).toBe("pending");
    expect((await pay({ method: "cash", amountCents: 100 }, "chave-pend-0001", S.ownerToken, pending.body.appointment.id)).body.error.code).toBe("not_payable");
  });

  it("chave de idempotência é por organização (mesma chave em outra loja não colide)", async () => {
    const T = await createShop("pay2");
    const other = (await adminBook(T, tue(10))).body.appointment.id;
    expect((await pay({ method: "cash", amountCents: 1000 }, "chave-global-001")).status).toBe(201);
    const r = await api("POST", `/api/orgs/${T.orgId}/appointments/${other}/payments`, { token: T.ownerToken, body: { method: "cash", amountCents: 1000 }, headers: { "idempotency-key": "chave-global-001" } });
    expect(r.status).toBe(201);
  });

  it("administrador de unidade registra; relatório soma por método", async () => {
    const adm = await addStaff(S, "unit_admin");
    expect((await pay({ method: "pix", amountCents: 2000 }, "chave-adm-00001", adm.token)).status).toBe(201);
    expect((await pay({ method: "cash", amountCents: 1500 }, "chave-adm-00002")).status).toBe(201);
    const rep = await api("GET", `${o}/reports/summary?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z`, { token: S.ownerToken });
    expect(rep.status).toBe(200);
    const by = Object.fromEntries(rep.body.byMethod.map((m: { method: string; amount_cents: number }) => [m.method, m.amount_cents]));
    expect(by).toEqual({ pix: 2000, cash: 1500 });
  });
});

describe("integridade e trilhas imutáveis no banco", () => {
  let S: Shop;
  beforeEach(async () => {
    S = await createShop("imut");
  });

  it("pagamentos, auditoria, histórico e consentimentos são append-only", async () => {
    const a = await adminBook(S, tue(10));
    await api("POST", `/api/orgs/${S.orgId}/appointments/${a.body.appointment.id}/payments`, { token: S.ownerToken, body: { method: "cash", amountCents: 1000 }, headers: { "idempotency-key": "chave-imut-0001" } });
    const cid = (await E.DB.prepare("SELECT customer_id AS c FROM appointments WHERE id = ?").bind(a.body.appointment.id).first<{ c: string }>())!.c;
    await api("POST", `/api/orgs/${S.orgId}/customers/${cid}/consents`, { token: S.ownerToken, body: { email: true, granted: true } });

    for (const sql of [
      "UPDATE payments SET amount_cents = 1 WHERE organization_id = ?",
      "DELETE FROM payments WHERE organization_id = ?",
      "UPDATE audit_logs SET action = 'x' WHERE organization_id = ?",
      "DELETE FROM audit_logs WHERE organization_id = ?",
      "UPDATE appointment_history SET action = 'x' WHERE organization_id = ?",
      "DELETE FROM appointment_history WHERE organization_id = ?",
      "UPDATE customer_consents SET granted = 0 WHERE organization_id = ?",
      "DELETE FROM customer_consents WHERE organization_id = ?",
    ]) {
      await expect(E.DB.prepare(sql).bind(S.orgId).run(), sql).rejects.toThrow(/append_only/);
    }
  });

  it("consentimento: cada mudança é nova linha e o estado vigente é o mais recente", async () => {
    const a = await adminBook(S, tue(10));
    const cid = (await E.DB.prepare("SELECT customer_id AS c FROM appointments WHERE id = ?").bind(a.body.appointment.id).first<{ c: string }>())!.c;
    const o = `/api/orgs/${S.orgId}`;
    await api("POST", `${o}/customers/${cid}/consents`, { token: S.ownerToken, body: { whatsapp: true, granted: true } });
    const { clock } = await import("./helpers");
    clock.ms += 60_000;
    const t = (await import("./helpers")).signToken;
    S.ownerToken = await t({ uid: S.ownerUid });
    await api("POST", `${o}/customers/${cid}/consents`, { token: S.ownerToken, body: { whatsapp: true, granted: false, source: "customer_request" } });
    const d = await api("GET", `${o}/customers/${cid}`, { token: S.ownerToken });
    const w = d.body.consents.find((c: { channel: string }) => c.channel === "whatsapp");
    expect(w.granted).toBe(0);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM customer_consents WHERE customer_id = ?").bind(cid).first<{ n: number }>())!.n).toBe(2);
  });

  it("LGPD: exportação e anonimização (somente dono); histórico financeiro permanece sem identificar a pessoa", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const a = await adminBook(S, tue(10), {}, S.ownerToken, "71944443333");
    const cid = (await E.DB.prepare("SELECT customer_id AS c FROM appointments WHERE id = ?").bind(a.body.appointment.id).first<{ c: string }>())!.c;
    await api("POST", `${o}/appointments/${a.body.appointment.id}/payments`, { token: S.ownerToken, body: { method: "cash", amountCents: 2000 }, headers: { "idempotency-key": "chave-lgpd-0001" } });
    const exp = await api("GET", `${o}/customers/${cid}/export`, { token: S.ownerToken });
    expect(exp.status).toBe(200);
    expect(exp.body.customer.name).toBe("Cliente Teste");
    expect(exp.body.appointments.length).toBe(1);
    expect(exp.body.payments.length).toBe(1);

    expect((await api("POST", `${o}/customers/${cid}/anonymize`, { token: S.ownerToken })).status).toBe(200);
    const row = await E.DB.prepare("SELECT name, phone, phone_norm, email, status FROM customers WHERE id = ?").bind(cid).first<Record<string, unknown>>();
    expect(row).toEqual({ name: "Cliente anonimizado", phone: null, phone_norm: null, email: null, status: "anonymized" });
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?").bind(cid).first<{ n: number }>())!.n).toBe(1);
    expect((await api("PATCH", `${o}/customers/${cid}`, { token: S.ownerToken, body: { name: "Volta" } })).status).toBe(409);
    // o telefone antigo não identifica mais ninguém
    const list = await api("GET", `${o}/customers?q=71944443333`, { token: S.ownerToken });
    expect(list.body.customers).toEqual([]);
  });

  it("clientes: duplicidade por telefone é recusada; busca por nome/telefone", async () => {
    const o = `/api/orgs/${S.orgId}`;
    expect((await api("POST", `${o}/customers`, { token: S.ownerToken, body: { name: "Ana Souza", phone: "(71) 98888-0001" } })).status).toBe(201);
    const dup = await api("POST", `${o}/customers`, { token: S.ownerToken, body: { name: "Ana Outra", phone: "71988880001" } });
    expect(dup.status).toBe(409);
    expect((await api("GET", `${o}/customers?q=ana`, { token: S.ownerToken })).body.customers.length).toBe(1);
    expect((await api("GET", `${o}/customers?q=988880001`, { token: S.ownerToken })).body.customers.length).toBe(1);
    expect((await api("GET", `${o}/customers?q=zzz`, { token: S.ownerToken })).body.customers.length).toBe(0);
  });

  it("agenda: horário múltiplo de 5, sobreposição de expediente e serviço fora do catálogo do profissional", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const overlap = await api("PUT", `${o}/professionals/${S.proId}/schedules`, {
      token: S.ownerToken, body: { unitId: S.unitId, days: [{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 700, endMin: 900 }] },
    });
    expect(overlap.status).toBe(422);
    const odd = await api("PUT", `${o}/professionals/${S.proId}/schedules`, { token: S.ownerToken, body: { unitId: S.unitId, days: [{ weekday: 1, startMin: 541, endMin: 720 }] } });
    expect(odd.status).toBe(400);
    const svc2 = await api("POST", `${o}/services`, { token: S.ownerToken, body: { name: "Barba", priceCents: 3000, durationMin: 20 } });
    const r = await adminBook(S, tue(10), { serviceIds: [svc2.body.id] });
    expect(r.status).toBe(422); // profissional não oferece "Barba"
    expect((await api("POST", `${o}/services`, { token: S.ownerToken, body: { name: "Ruim", priceCents: 3000, durationMin: 22 } })).status).toBe(400);
  });
});
