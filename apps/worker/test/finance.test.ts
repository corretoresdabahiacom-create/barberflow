import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, clock, completeAppt, createShop, reset, signToken, tue, type Shop } from "./helpers";

beforeEach(reset);

describe("comissões", () => {
  let S: Shop;
  let o: string;
  beforeEach(async () => {
    S = await createShop("com");
    o = `/api/orgs/${S.orgId}`;
  });
  const rule = (body: unknown, token = S.ownerToken) => api("PUT", `${o}/commission-rules`, { token, body });
  const entry = (apptId: string) => E.DB.prepare("SELECT base_cents, commission_cents FROM commission_entries WHERE appointment_id = ?").bind(apptId).first<{ base_cents: number; commission_cents: number }>();

  it("congela a comissão na conclusão com a regra padrão; mudar a regra depois não reescreve o passado", async () => {
    expect((await rule({ professionalId: S.proId, rateBp: 4000 })).status).toBe(200);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    expect((await completeAppt(S, a)).status).toBe(200);
    expect(await entry(a)).toEqual({ base_cents: 5000, commission_cents: 2000 });
    await rule({ professionalId: S.proId, rateBp: 9000 });
    expect(await entry(a)).toEqual({ base_cents: 5000, commission_cents: 2000 });
  });

  it("regra por serviço vence a padrão; sem regra = 0; arredonda para baixo por item", async () => {
    // sem regra nenhuma
    const a0 = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a0);
    expect(await entry(a0)).toEqual({ base_cents: 5000, commission_cents: 0 });

    clock.ms = Date.UTC(2026, 10, 6, 15, 0, 0);
    S.ownerToken = await signToken({ uid: S.ownerUid });
    const svc = await api("POST", `${o}/services`, { token: S.ownerToken, body: { name: "Barba", priceCents: 999, durationMin: 30 } });
    await api("PUT", `${o}/professionals/${S.proId}/services`, { token: S.ownerToken, body: { services: [{ serviceId: S.serviceId }, { serviceId: svc.body.id }] } });
    await rule({ professionalId: S.proId, rateBp: 1000 });
    await rule({ professionalId: S.proId, serviceId: svc.body.id, rateBp: 5000 });
    const b = await adminBook(S, tue(11), { serviceIds: [svc.body.id] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await completeAppt(S, b.body.appointment.id);
    expect(await entry(b.body.appointment.id)).toEqual({ base_cents: 999, commission_cents: 499 }); // floor(499,5)
  });

  it("não duplica ao concluir de novo e a tabela é append-only", async () => {
    await rule({ professionalId: S.proId, rateBp: 5000 });
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    expect((await api("POST", `${o}/appointments/${a}/complete`, { token: S.ownerToken })).status).toBe(409);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM commission_entries WHERE appointment_id = ?").bind(a).first<{ n: number }>())!.n).toBe(1);
    await expect(E.DB.prepare("UPDATE commission_entries SET commission_cents = 1 WHERE appointment_id = ?").bind(a).run()).rejects.toThrow(/append_only/);
    await expect(E.DB.prepare("DELETE FROM commission_entries WHERE appointment_id = ?").bind(a).run()).rejects.toThrow(/append_only/);
  });

  it("não gera comissão para falta (no-show)", async () => {
    await rule({ professionalId: S.proId, rateBp: 5000 });
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    clock.ms = Date.parse(tue(10)) + 3600_000;
    S.ownerToken = await signToken({ uid: S.ownerUid });
    await api("POST", `${o}/appointments/${a}/confirm`, { token: S.ownerToken });
    expect((await api("POST", `${o}/appointments/${a}/no-show`, { token: S.ownerToken })).status).toBe(200);
    expect(await entry(a)).toBeNull();
  });

  it("valida a taxa (0–10000 bp) e que profissional/serviço existem na organização", async () => {
    expect((await rule({ professionalId: S.proId, rateBp: 10001 })).status).toBe(400);
    expect((await rule({ professionalId: S.proId, rateBp: -1 })).status).toBe(400);
    expect((await rule({ professionalId: "00000000-0000-0000-0000-000000000000", rateBp: 100 })).status).toBe(404);
    expect((await rule({ professionalId: S.proId, serviceId: "00000000-0000-0000-0000-000000000000", rateBp: 100 })).status).toBe(404);
  });

  it("relatório por profissional e visão do próprio profissional", async () => {
    await rule({ professionalId: S.proId, rateBp: 5000 });
    const barber = await addStaff(S, "barber");
    await api("PATCH", `${o}/professionals/${S.proId}`, { token: S.ownerToken, body: { memberId: barber.membershipId } });
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    barber.token = await signToken({ uid: barber.uid, email: barber.email });
    const q = `from=${tue(0)}&to=${tue(23)}`;
    const rep = await api("GET", `${o}/finance/commissions?${q}`, { token: S.ownerToken });
    expect(rep.body.commissions).toHaveLength(1);
    expect(rep.body.commissions[0].commission_cents).toBe(2500);
    const mine = await api("GET", `${o}/finance/commissions/mine?${q}`, { token: barber.token });
    expect(mine.status).toBe(200);
    expect(mine.body.commission_cents).toBe(2500);
    // barbeiro não vê o relatório geral nem as regras
    expect((await api("GET", `${o}/finance/commissions?${q}`, { token: barber.token })).status).toBe(403);
    expect((await api("GET", `${o}/commission-rules`, { token: barber.token })).status).toBe(403);
  });
});

describe("despesas e caixa", () => {
  let S: Shop;
  let o: string;
  beforeEach(async () => {
    S = await createShop("fin");
    o = `/api/orgs/${S.orgId}`;
  });
  const exp = (body: unknown, key: string | null = "desp-chave-0001", token = S.ownerToken) =>
    api("POST", `${o}/expenses`, { token, body, headers: key ? { "idempotency-key": key } : {} });
  const e1 = () => ({ unitId: S.unitId, category: "Aluguel", amountCents: 1500, paidWith: "cash" });
  const pay = (id: string, method: string, amountCents: number, key: string) =>
    api("POST", `${o}/appointments/${id}/payments`, { token: S.ownerToken, body: { method, amountCents }, headers: { "idempotency-key": key } });

  it("despesa: exige Idempotency-Key, repete sem duplicar e recusa chave com outros dados", async () => {
    expect((await exp(e1(), null)).status).toBe(400);
    const a = await exp(e1());
    expect(a.status).toBe(201);
    const again = await exp(e1());
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(a.body.id);
    expect((await exp({ ...e1(), amountCents: 1600 })).body.error.code).toBe("idempotency_conflict");
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE organization_id = ?").bind(S.orgId).first<{ n: number }>())!.n).toBe(1);
  });

  it("valor precisa ser positivo e inteiro; unidade precisa ser da organização", async () => {
    expect((await exp({ ...e1(), amountCents: 0 })).status).toBe(400);
    expect((await exp({ ...e1(), amountCents: -5 }, "desp-chave-0002")).status).toBe(400);
    expect((await exp({ ...e1(), amountCents: 10.5 }, "desp-chave-0003")).status).toBe(400);
    expect((await exp({ ...e1(), unitId: "00000000-0000-0000-0000-000000000000" }, "desp-chave-0004")).status).toBe(404);
  });

  it("estorno: cria lançamento oposto, só uma vez; despesa original é imutável", async () => {
    const a = (await exp(e1())).body.id;
    const r = await api("POST", `${o}/expenses/${a}/reverse`, { token: S.ownerToken, body: { reason: "Lançada errada" }, headers: { "idempotency-key": "estorno-0001" } });
    expect(r.status).toBe(201);
    const again = await api("POST", `${o}/expenses/${a}/reverse`, { token: S.ownerToken, body: { reason: "Lançada errada" }, headers: { "idempotency-key": "estorno-0002" } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_reversed");
    const rr = await api("POST", `${o}/expenses/${r.body.id}/reverse`, { token: S.ownerToken, body: { reason: "Estornar estorno" }, headers: { "idempotency-key": "estorno-0003" } });
    expect(rr.status).toBe(409);
    await expect(E.DB.prepare("UPDATE expenses SET amount_cents = 1 WHERE id = ?").bind(a).run()).rejects.toThrow(/append_only/);
    await expect(E.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(a).run()).rejects.toThrow(/append_only/);
    const q = `from=${tue(0)}&to=${tue(23)}`;
    clock.ms = Date.parse(tue(10));
    S.ownerToken = await signToken({ uid: S.ownerUid });
    const sum = await api("GET", `${o}/finance/summary?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z`, { token: S.ownerToken });
    expect(sum.body.expensesCents).toBe(0);
    void q;
  });

  it("caixa: esperado = abertura + dinheiro recebido − despesa em dinheiro; PIX não conta; diferença correta", async () => {
    const open = await api("POST", `${o}/cash/open`, { token: S.ownerToken, body: { unitId: S.unitId, openingCents: 10000 } });
    expect(open.status).toBe(201);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    const b = (await adminBook(S, tue(11), {}, S.ownerToken, "71977776666")).body.appointment.id;
    expect((await pay(a, "cash", 5000, "pag-cash-0001")).status).toBe(201);
    expect((await pay(b, "pix", 5000, "pag-pix-00001")).status).toBe(201);
    await exp(e1()); // 1500 em dinheiro
    await exp({ unitId: S.unitId, category: "Outros", amountCents: 700, paidWith: "other" }, "desp-chave-0009"); // fora do caixa

    const mid = await api("GET", `${o}/cash?unitId=${S.unitId}`, { token: S.ownerToken });
    expect(mid.body.sessions[0].running_expected_cents).toBe(13500);

    const close = await api("POST", `${o}/cash/${open.body.id}/close`, { token: S.ownerToken, body: { countedCents: 13400, note: "faltou troco" } });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body.session.expected_cents).toBe(13500);
    expect(close.body.session.difference_cents).toBe(-100);
    expect(close.body.session.counted_cents).toBe(13400);

    // imutável depois de fechado
    expect((await api("POST", `${o}/cash/${open.body.id}/close`, { token: S.ownerToken, body: { countedCents: 1 } })).body.error.code).toBe("cash_already_closed");
    await expect(E.DB.prepare("UPDATE cash_sessions SET counted_cents = 0 WHERE id = ?").bind(open.body.id).run()).rejects.toThrow(/append_only/);
    await expect(E.DB.prepare("DELETE FROM cash_sessions WHERE id = ?").bind(open.body.id).run()).rejects.toThrow(/append_only/);
  });

  it("um único caixa aberto por unidade; pode abrir outro depois de fechar", async () => {
    const a = await api("POST", `${o}/cash/open`, { token: S.ownerToken, body: { unitId: S.unitId, openingCents: 0 } });
    expect(a.status).toBe(201);
    const dup = await api("POST", `${o}/cash/open`, { token: S.ownerToken, body: { unitId: S.unitId, openingCents: 0 } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("cash_already_open");
    await api("POST", `${o}/cash/${a.body.id}/close`, { token: S.ownerToken, body: { countedCents: 0 } });
    expect((await api("POST", `${o}/cash/open`, { token: S.ownerToken, body: { unitId: S.unitId, openingCents: 0 } })).status).toBe(201);
  });

  it("caixa fechado em paralelo: só um fechamento vence", async () => {
    const open = await api("POST", `${o}/cash/open`, { token: S.ownerToken, body: { unitId: S.unitId, openingCents: 100 } });
    const rs = await Promise.all([1, 2, 3, 4].map((n) => api("POST", `${o}/cash/${open.body.id}/close`, { token: S.ownerToken, body: { countedCents: n } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it("resumo financeiro: recebido − despesas − comissões", async () => {
    await api("PUT", `${o}/commission-rules`, { token: S.ownerToken, body: { professionalId: S.proId, rateBp: 4000 } });
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a); // relógio avança para depois do atendimento
    expect((await pay(a, "pix", 5000, "pag-pix-00002")).status).toBe(201);
    expect((await exp(e1(), "desp-chave-0010")).status).toBe(201);
    const sum = await api("GET", `${o}/finance/summary?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z`, { token: S.ownerToken });
    expect(sum.body.servicesReceivedCents).toBe(5000);
    expect(sum.body.expensesCents).toBe(1500);
    expect(sum.body.commissionsCents).toBe(2000);
    expect(sum.body.resultCents).toBe(1500);
  });

  it("permissões: gerente e barbeiro não mexem em finanças; admin da unidade sim, mas não nas regras de comissão", async () => {
    const manager = await addStaff(S, "manager");
    const barber = await addStaff(S, "barber");
    const admin = await addStaff(S, "unit_admin");
    expect((await exp(e1(), "desp-chave-0011", manager.token)).status).toBe(403);
    expect((await exp(e1(), "desp-chave-0012", barber.token)).status).toBe(403);
    expect((await api("POST", `${o}/cash/open`, { token: manager.token, body: { unitId: S.unitId, openingCents: 0 } })).status).toBe(403);
    expect((await api("GET", `${o}/cash`, { token: barber.token })).status).toBe(403);
    expect((await exp(e1(), "desp-chave-0013", admin.token)).status).toBe(201);
    expect((await api("PUT", `${o}/commission-rules`, { token: admin.token, body: { professionalId: S.proId, rateBp: 100 } })).status).toBe(403);
  });

  it("admin de unidade não opera outra unidade", async () => {
    const u2 = await api("POST", `${o}/units`, { token: S.ownerToken, body: { name: "Filial", slug: `fil-${Date.now().toString(36)}` } });
    expect(u2.status, JSON.stringify(u2.body)).toBe(201);
    const admin = await addStaff(S, "unit_admin"); // da unidade 1
    expect((await exp({ ...e1(), unitId: u2.body.id }, "desp-chave-0014", admin.token)).status).toBe(403);
    expect((await api("POST", `${o}/cash/open`, { token: admin.token, body: { unitId: u2.body.id, openingCents: 0 } })).status).toBe(403);
    expect((await api("GET", `${o}/cash?unitId=${u2.body.id}`, { token: admin.token })).status).toBe(403);
  });
});
