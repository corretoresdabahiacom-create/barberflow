import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, api, createShop, reset, type Shop } from "./helpers";

beforeEach(reset);

describe("estoque", () => {
  let S: Shop;
  let o: string;
  let pid: string;
  beforeEach(async () => {
    S = await createShop("est");
    o = `/api/orgs/${S.orgId}`;
    const p = await api("POST", `${o}/products`, { token: S.ownerToken, body: { name: "Pomada", sku: "POM-1", priceCents: 4500, costCents: 2000, minStock: 2 } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    pid = p.body.id;
  });
  let n = 0;
  const move = (body: Record<string, unknown>, token = S.ownerToken, key = `mov-chave-${String(++n).padStart(5, "0")}`) =>
    api("POST", `${o}/stock/movements`, { token, body: { unitId: S.unitId, productId: pid, ...body }, headers: { "idempotency-key": key } });
  const level = async (unitId = S.unitId) => (await api("GET", `${o}/stock/levels?unitId=${unitId}`, { token: S.ownerToken })).body.levels[0];

  it("compra soma, venda subtrai e congela o preço do produto; alerta de estoque baixo", async () => {
    expect((await move({ kind: "purchase", qty: 10 })).status).toBe(201);
    expect((await move({ kind: "sale", qty: 3 })).status).toBe(201);
    expect((await level()).qty).toBe(7);
    expect((await level()).low).toBe(false);
    expect((await move({ kind: "loss", qty: 5, note: "vencida" })).status).toBe(201);
    expect(await level()).toMatchObject({ qty: 2, low: true });
    // preço do produto muda depois: a venda antiga mantém o preço do momento
    await api("PATCH", `${o}/products/${pid}`, { token: S.ownerToken, body: { priceCents: 9999 } });
    const sale = await E.DB.prepare("SELECT unit_price_cents FROM stock_movements WHERE kind = 'sale' AND product_id = ?").bind(pid).first<{ unit_price_cents: number }>();
    expect(sale!.unit_price_cents).toBe(4500);
  });

  it("nunca deixa o saldo negativo (venda, perda e ajuste)", async () => {
    await move({ kind: "purchase", qty: 2 });
    const r = await move({ kind: "sale", qty: 3 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
    expect((await move({ kind: "loss", qty: 3 })).status).toBe(409);
    expect((await move({ kind: "adjustment", qty: -3 })).status).toBe(409);
    expect((await move({ kind: "adjustment", qty: -2 })).status).toBe(201);
    expect((await level()).qty).toBe(0);
  });

  it("8 vendas simultâneas de 1 unidade com saldo 5: exatamente 5 passam", async () => {
    await move({ kind: "purchase", qty: 5 });
    const rs = await Promise.all(Array.from({ length: 8 }, () => move({ kind: "sale", qty: 1 })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await level()).qty).toBe(0);
  });

  it("idempotência: mesma chave repete sem duplicar; chave com outros dados é recusada", async () => {
    const a = await move({ kind: "purchase", qty: 4 }, S.ownerToken, "mov-fixa-0001");
    const b = await move({ kind: "purchase", qty: 4 }, S.ownerToken, "mov-fixa-0001");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await move({ kind: "purchase", qty: 5 }, S.ownerToken, "mov-fixa-0001")).body.error.code).toBe("idempotency_conflict");
    expect((await level()).qty).toBe(4);
    expect((await move({ kind: "purchase", qty: 1 }, S.ownerToken, "x")).status).toBe(400);
  });

  it("valida quantidades: zero, sinal errado e decimal", async () => {
    expect((await move({ kind: "purchase", qty: 0 })).status).toBe(400);
    expect((await move({ kind: "sale", qty: -1 })).status).toBe(400);
    expect((await move({ kind: "purchase", qty: 1.5 })).status).toBe(400);
    expect((await move({ kind: "purchase", qty: 1, extra: 1 })).status).toBe(400);
  });

  it("saldo é por unidade: estoque da matriz não vale na filial", async () => {
    await move({ kind: "purchase", qty: 10 });
    const u2 = await api("POST", `${o}/units`, { token: S.ownerToken, body: { name: "Filial", slug: `fil-${Date.now().toString(36)}` } });
    const r = await api("POST", `${o}/stock/movements`, { token: S.ownerToken, body: { unitId: u2.body.id, productId: pid, kind: "sale", qty: 1 }, headers: { "idempotency-key": "mov-filial-001" } });
    expect(r.status).toBe(409);
    expect((await level(u2.body.id)).qty).toBe(0);
    expect((await level()).qty).toBe(10);
  });

  it("movimentações são append-only", async () => {
    const a = await move({ kind: "purchase", qty: 1 });
    await expect(E.DB.prepare("UPDATE stock_movements SET qty = 99 WHERE id = ?").bind(a.body.id).run()).rejects.toThrow(/append_only/);
    await expect(E.DB.prepare("DELETE FROM stock_movements WHERE id = ?").bind(a.body.id).run()).rejects.toThrow(/append_only/);
  });

  it("permissões: só o dono cadastra produto; gerente movimenta; barbeiro não vê nem movimenta", async () => {
    const manager = await addStaff(S, "manager");
    const barber = await addStaff(S, "barber");
    const admin = await addStaff(S, "unit_admin");
    expect((await api("POST", `${o}/products`, { token: manager.token, body: { name: "Hack", priceCents: 1 } })).status).toBe(403);
    expect((await api("POST", `${o}/products`, { token: admin.token, body: { name: "Hack", priceCents: 1 } })).status).toBe(403);
    expect((await api("PATCH", `${o}/products/${pid}`, { token: manager.token, body: { priceCents: 1 } })).status).toBe(403);
    expect((await move({ kind: "purchase", qty: 5 }, manager.token)).status).toBe(201);
    expect((await api("GET", `${o}/stock/levels?unitId=${S.unitId}`, { token: manager.token })).status).toBe(200);
    expect((await move({ kind: "purchase", qty: 5 }, barber.token)).status).toBe(403);
    expect((await api("GET", `${o}/products`, { token: barber.token })).status).toBe(403);
    expect((await api("GET", `${o}/stock/levels?unitId=${S.unitId}`, { token: barber.token })).status).toBe(403);
  });

  it("gerente da matriz não movimenta a filial", async () => {
    const manager = await addStaff(S, "manager");
    const u2 = await api("POST", `${o}/units`, { token: S.ownerToken, body: { name: "Filial", slug: `fil-${Date.now().toString(36)}` } });
    const r = await api("POST", `${o}/stock/movements`, { token: manager.token, body: { unitId: u2.body.id, productId: pid, kind: "purchase", qty: 1 }, headers: { "idempotency-key": "mov-filial-002" } });
    expect(r.status).toBe(403);
  });

  it("SKU único por organização e produto inativo não recebe compra", async () => {
    const dup = await api("POST", `${o}/products`, { token: S.ownerToken, body: { name: "Outra", sku: "POM-1", priceCents: 1 } });
    expect(dup.status).toBe(409);
    await api("PATCH", `${o}/products/${pid}`, { token: S.ownerToken, body: { status: "inactive" } });
    expect((await move({ kind: "purchase", qty: 1 })).body.error.code).toBe("product_inactive");
  });

  it("produto de outra organização não pode ser movimentado", async () => {
    const other = await createShop("estB");
    const r = await api("POST", `${o}/stock/movements`, { token: S.ownerToken, body: { unitId: S.unitId, productId: (await api("POST", `/api/orgs/${other.orgId}/products`, { token: other.ownerToken, body: { name: "Alheio", priceCents: 1 } })).body.id, kind: "purchase", qty: 1 }, headers: { "idempotency-key": "mov-alheio-01" } });
    expect(r.status).toBe(404);
  });
});
