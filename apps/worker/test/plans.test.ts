import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, api, clock, createShop, platformToken, reset, signToken, uniq, type Shop } from "./helpers";

beforeEach(reset);

const putPlan = (token: string, id: string, body: Record<string, unknown>) =>
  api("PUT", `/api/platform/plans/${id}`, { token, body: { name: "Plano", priceCents: null, maxUnits: null, maxProfessionals: null, aiDailyQuota: 10, allowNetwork: false, active: true, sort: 0, ...body } });

const setSub = (token: string, orgId: string, body: Record<string, unknown>) =>
  api("PUT", `/api/platform/orgs/${orgId}/subscription`, { token, body: { planId: "pro", status: "active", validUntil: null, note: null, ...body } });

const FREE = { name: "Gratuito", priceCents: 0, maxUnits: 2, maxProfessionals: 5, aiDailyQuota: 10, allowNetwork: false, active: true, sort: 1 };
afterEach(async () => {
  // restaura os valores iniciais do plano gratuito (o banco persiste entre testes do arquivo)
  await E.DB.prepare("UPDATE plans SET name='Gratuito', price_cents=0, max_units=2, max_professionals=5, ai_daily_quota=10, allow_network=0, active=1, sort=1 WHERE id='free'").run();
});

describe("administração da plataforma", () => {
  it("quem não é administrador recebe 404 (não revela a área); e-mail não verificado também", async () => {
    const S = await createShop("plat");
    expect((await api("GET", "/api/platform/plans", { token: S.ownerToken })).status).toBe(404);
    const unverified = await signToken({ uid: "plat-fake", email: "dona@plataforma.test", verified: false });
    expect((await api("GET", "/api/platform/plans", { token: unverified })).status).toBe(404);
    expect((await api("GET", "/api/platform/plans")).status).toBe(401);
    // dono da loja não consegue mexer na própria assinatura
    expect((await setSub(S.ownerToken, S.orgId, { planId: "rede" })).status).toBe(404);
    const t = await platformToken();
    expect((await api("GET", "/api/platform/plans", { token: t })).status).toBe(200);
  });

  it("editar preço/limites reflete na vitrine pública; plano gratuito não pode ser desativado", async () => {
    const t = await platformToken();
    const r = await putPlan(t, "pro", { name: "Profissional", priceCents: 4990, maxUnits: 5, maxProfessionals: 20, aiDailyQuota: 50 });
    expect(r.status).toBe(200);
    const pub = await api("GET", "/api/public/plans");
    expect(pub.status).toBe(200);
    expect(pub.body.plans.find((p: any) => p.id === "pro").price_cents).toBe(4990);
    expect(pub.body.plans.find((p: any) => p.id === "rede").price_cents).toBeNull(); // "a definir"
    expect((await putPlan(t, "free", { ...FREE, active: false })).status).toBe(409);
    expect((await putPlan(t, "inexistente", {})).status).toBe(404);
    expect((await putPlan(t, "pro", { maxUnits: 0 })).status).toBe(400);
    await putPlan(t, "pro", { name: "Profissional", priceCents: null, maxUnits: 5, maxProfessionals: 20, aiDailyQuota: 50 });
    // plano inativo some da vitrine
    await api("POST", "/api/platform/plans", { token: t, body: { id: "teste-x", name: "Teste", priceCents: 1, maxUnits: 1, maxProfessionals: 1, aiDailyQuota: 0, allowNetwork: false, active: false, sort: 9 } });
    expect((await api("GET", "/api/public/plans")).body.plans.some((p: any) => p.id === "teste-x")).toBe(false);
  });

  it("assinatura: plano inexistente = 400; organização inexistente = 404; fica na auditoria da organização", async () => {
    const S = await createShop("sub");
    const t = await platformToken();
    expect((await setSub(t, S.orgId, { planId: "nao-existe" })).status).toBe(400);
    expect((await setSub(t, "00000000-0000-0000-0000-000000000000", {})).status).toBe(404);
    expect((await setSub(t, S.orgId, { planId: "pro", note: "pago via Pix manual" })).status).toBe(200);
    const row = await E.DB.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action = 'subscription.updated'").bind(S.orgId).first();
    expect(row).toBeTruthy();
    const list = await api("GET", "/api/platform/orgs?q=sub", { token: t });
    expect(list.body.organizations.find((o: any) => o.id === S.orgId).plan_id).toBe("pro");
  });
});

describe("limites do plano", () => {
  let S: Shop;
  let o: string;
  beforeEach(async () => {
    S = await createShop("lim");
    o = `/api/orgs/${S.orgId}`;
  });
  const unit = (n: string) => api("POST", `${o}/units`, { token: S.ownerToken, body: { name: `Filial ${n}`, slug: uniq("fl-").toLowerCase().replace(/[^a-z0-9-]/g, "") } });
  const pro = (n: string) => api("POST", `${o}/professionals`, { token: S.ownerToken, body: { name: `Pro ${n}`, unitIds: [S.unitId] } });

  it("unidades: o limite do plano gratuito bloqueia a criação (409 plan_limit); trocar de plano libera", async () => {
    expect((await unit("2")).status).toBe(201); // 2 de 2
    const blocked = await unit("3");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("plan_limit");
    const t = await platformToken();
    await setSub(t, S.orgId, { planId: "pro" });
    expect((await unit("3")).status).toBe(201);
  });

  it("profissionais: limite do plano gratuito; ilimitado quando o limite é nulo", async () => {
    for (let i = 2; i <= 5; i++) expect((await pro(String(i))).status).toBe(201);
    expect((await pro("6")).body.error.code).toBe("plan_limit");
    const t = await platformToken();
    await putPlan(t, "rede", { name: "Rede", maxUnits: null, maxProfessionals: null, aiDailyQuota: 200, allowNetwork: true });
    await setSub(t, S.orgId, { planId: "rede" });
    expect((await pro("6")).status).toBe(201);
    await putPlan(t, "rede", { name: "Rede", maxUnits: null, maxProfessionals: null, aiDailyQuota: 200, allowNetwork: true, active: true });
  });

  it("profissional INATIVO não conta para o limite", async () => {
    const ids: string[] = [];
    for (let i = 2; i <= 5; i++) ids.push((await pro(String(i))).body.id);
    expect((await pro("x")).status).toBe(409);
    expect((await api("PATCH", `${o}/professionals/${ids[0]}`, { token: S.ownerToken, body: { status: "inactive" } })).status).toBe(200);
    expect((await pro("x")).status).toBe(201);
  });

  it("assinatura vencida ou suspensa volta ao limite do gratuito; dados existentes permanecem", async () => {
    const t = await platformToken();
    await setSub(t, S.orgId, { planId: "pro", validUntil: new Date(clock.ms + 86400_000).toISOString() });
    expect((await unit("2")).status).toBe(201);
    expect((await unit("3")).status).toBe(201); // pro: 5
    // vence amanhã → depois disso, volta ao gratuito (2 unidades): 3 existentes continuam, nova é bloqueada
    clock.ms += 3 * 86400_000;
    S.ownerToken = await signToken({ uid: S.ownerUid });
    expect((await unit("4")).body.error.code).toBe("plan_limit");
    expect((await api("GET", `${o}/units`, { token: S.ownerToken })).body.units).toHaveLength(3);
    const plan = await api("GET", `${o}/plan`, { token: S.ownerToken });
    expect(plan.body.plan.id).toBe("free");
    // suspensa
    clock.ms -= 3 * 86400_000;
    const t2 = await platformToken();
    await setSub(t2, S.orgId, { planId: "pro", status: "suspended" });
    S.ownerToken = await signToken({ uid: S.ownerUid });
    expect((await api("GET", `${o}/plan`, { token: S.ownerToken })).body.plan.id).toBe("free");
  });

  it("plano desativado pela plataforma deixa de valer para quem o assinou (volta ao gratuito)", async () => {
    const t = await platformToken();
    await setSub(t, S.orgId, { planId: "pro" });
    expect((await api("GET", `${o}/plan`, { token: S.ownerToken })).body.plan.id).toBe("pro");
    await putPlan(t, "pro", { name: "Profissional", maxUnits: 5, maxProfessionals: 20, aiDailyQuota: 50, active: false });
    expect((await api("GET", `${o}/plan`, { token: S.ownerToken })).body.plan.id).toBe("free");
    await putPlan(t, "pro", { name: "Profissional", maxUnits: 5, maxProfessionals: 20, aiDailyQuota: 50, active: true });
  });

  it("GET /plan: uso atual; só proprietário", async () => {
    const r = await api("GET", `${o}/plan`, { token: S.ownerToken });
    expect(r.status).toBe(200);
    expect(r.body.plan).toMatchObject({ id: "free", maxUnits: 2, maxProfessionals: 5, allowNetwork: false });
    expect(r.body.usage).toEqual({ units: 1, professionals: 1 });
    const admin = await addStaff(S, "unit_admin");
    expect((await api("GET", `${o}/plan`, { token: admin.token })).status).toBe(403);
  });

  it("plano de outra organização não vaza: dono de A não lê /plan de B", async () => {
    const B = await createShop("lim-b");
    expect((await api("GET", `/api/orgs/${B.orgId}/plan`, { token: S.ownerToken })).status).toBe(404);
  });
});
