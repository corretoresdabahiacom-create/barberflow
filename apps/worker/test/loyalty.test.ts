import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, apptCustomerId, completeAppt, createShop, reset, tue, type Shop } from "./helpers";

beforeEach(reset);

describe("fidelidade", () => {
  let S: Shop;
  let o: string;
  beforeEach(async () => {
    S = await createShop("fid");
    o = `/api/orgs/${S.orgId}`;
  });
  const setPoints = (n: number, token = S.ownerToken) => api("PUT", `${o}/automation`, { token, body: { loyaltyPointsPerReal: n } });
  const bal = async (cid: string) => (await api("GET", `${o}/customers/${cid}/loyalty`, { token: S.ownerToken })).body;
  const redeem = (cid: string, points: number, key: string, token = S.ownerToken) =>
    api("POST", `${o}/customers/${cid}/loyalty/redeem`, { token, body: { points, note: "Desconto" }, headers: { "idempotency-key": key } });

  it("vem DESLIGADA: concluir atendimento não gera pontos", async () => {
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    expect((await bal(await apptCustomerId(a))).balance).toBe(0);
  });

  it("liga com 1 ponto por real: R$ 50 = 50 pontos, uma única vez", async () => {
    expect((await setPoints(1)).status).toBe(200);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    const cid = await apptCustomerId(a);
    expect((await bal(cid)).balance).toBe(50);
    expect((await api("POST", `${o}/appointments/${a}/complete`, { token: S.ownerToken })).status).toBe(409);
    expect((await bal(cid)).balance).toBe(50);
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM loyalty_ledger WHERE appointment_id = ?").bind(a).first<{ n: number }>())!.n).toBe(1);
  });

  it("não pontua falta nem cancelamento", async () => {
    await setPoints(2);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await api("POST", `${o}/appointments/${a}/cancel`, { token: S.ownerToken, body: {} });
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM loyalty_ledger WHERE organization_id = ?").bind(S.orgId).first<{ n: number }>())!.n).toBe(0);
  });

  it("resgate: debita, recusa saldo insuficiente, repete sem duplicar", async () => {
    await setPoints(1);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    const cid = await apptCustomerId(a);
    const r1 = await redeem(cid, 30, "resgate-chave-1");
    expect(r1.status).toBe(201);
    expect((await redeem(cid, 30, "resgate-chave-1")).body.replayed).toBe(true);
    expect((await redeem(cid, 99, "resgate-chave-1")).body.error.code).toBe("idempotency_conflict");
    expect((await bal(cid)).balance).toBe(20);
    const over = await redeem(cid, 21, "resgate-chave-2");
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("insufficient_points");
    expect((await redeem(cid, 20, "resgate-chave-3")).status).toBe(201);
    expect((await bal(cid)).balance).toBe(0);
  });

  it("5 resgates simultâneos de 10 com saldo 20: só 2 passam e o saldo nunca fica negativo", async () => {
    await setPoints(1);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    const cid = await apptCustomerId(a);
    await redeem(cid, 30, "resgate-base-01"); // saldo 20
    const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => redeem(cid, 10, `resgate-par-${n}0`)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await bal(cid)).balance).toBe(0);
  });

  it("livro-razão é append-only", async () => {
    await setPoints(1);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    await completeAppt(S, a);
    await expect(E.DB.prepare("UPDATE loyalty_ledger SET points = 1 WHERE organization_id = ?").bind(S.orgId).run()).rejects.toThrow(/append_only/);
    await expect(E.DB.prepare("DELETE FROM loyalty_ledger WHERE organization_id = ?").bind(S.orgId).run()).rejects.toThrow(/append_only/);
  });

  it("configuração: só o dono altera; limites validados; admin e barbeiro não", async () => {
    const admin = await addStaff(S, "unit_admin");
    const barber = await addStaff(S, "barber");
    expect((await setPoints(1, admin.token)).status).toBe(403);
    expect((await setPoints(1, barber.token)).status).toBe(403);
    expect((await setPoints(101)).status).toBe(400);
    expect((await setPoints(-1)).status).toBe(400);
    expect((await api("GET", `${o}/automation`, { token: admin.token })).status).toBe(403);
    expect((await api("GET", `${o}/automation`, { token: S.ownerToken })).body).toEqual({ loyaltyPointsPerReal: 0, remindersEnabled: false });
  });

  it("barbeiro não vê nem resgata pontos; cliente de outra organização é 404", async () => {
    await setPoints(1);
    const a = (await adminBook(S, tue(10))).body.appointment.id;
    const cid = await apptCustomerId(a);
    const barber = await addStaff(S, "barber");
    expect((await api("GET", `${o}/customers/${cid}/loyalty`, { token: barber.token })).status).toBe(403);
    const other = await createShop("fidB");
    expect((await api("GET", `/api/orgs/${other.orgId}/customers/${cid}/loyalty`, { token: other.ownerToken })).status).toBe(404);
    expect((await api("POST", `/api/orgs/${other.orgId}/customers/${cid}/loyalty/redeem`, { token: other.ownerToken, body: { points: 1, note: "xx" }, headers: { "idempotency-key": "resgate-alheio-1" } })).status).toBe(404);
  });
});
