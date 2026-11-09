import { beforeEach, describe, expect, it } from "vitest";
import { E, adminBook, api, createShop, reset, tue, uniq, type Shop } from "./helpers";

beforeEach(reset);

describe("isolamento entre organizações (multi-tenant)", () => {
  let A: Shop;
  let B: Shop;
  let bApptId: string;
  let bCustomerId: string;
  let bBlockId: string;

  beforeEach(async () => {
    A = await createShop("isoA");
    B = await createShop("isoB");
    const appt = await adminBook(B, tue(10));
    expect(appt.status, JSON.stringify(appt.body)).toBe(201);
    bApptId = appt.body.appointment.id;
    const row = await E.DB.prepare("SELECT customer_id FROM appointments WHERE id = ?").bind(bApptId).first<{ customer_id: string }>();
    bCustomerId = row!.customer_id;
    const blk = await api("POST", `/api/orgs/${B.orgId}/professionals/${B.proId}/blocks`, {
      token: B.ownerToken, body: { startsAt: tue(14), endsAt: tue(15) },
    });
    bBlockId = blk.body.id;
  });

  it("dono de A recebe 404 em TODA rota da organização B (matriz)", async () => {
    const o = `/api/orgs/${B.orgId}`;
    const routes: [string, string, unknown?][] = [
      ["GET", ""], ["PATCH", "", { name: "Invadida" }],
      ["GET", "/units"], ["POST", "/units", { name: "Nova", slug: uniq("x-") }], ["PATCH", `/units/${B.unitId}`, { name: "Hack" }],
      ["GET", "/members"], ["POST", "/members", { email: "a@b.co", role: "manager", unitId: B.unitId }],
      ["PATCH", "/members/qualquer-id-existente-1", { status: "suspended" }], ["DELETE", "/members/qualquer-id-existente-1"],
      ["GET", "/services"], ["POST", "/services", { name: "Hack", priceCents: 1, durationMin: 5 }], ["PATCH", `/services/${B.serviceId}`, { name: "Hack" }],
      ["GET", "/professionals"], ["POST", "/professionals", { name: "Hack", unitIds: [B.unitId] }],
      ["PATCH", `/professionals/${B.proId}`, { name: "Hack" }], ["GET", `/professionals/${B.proId}/services`],
      ["PUT", `/professionals/${B.proId}/services`, { services: [] }], ["GET", `/professionals/${B.proId}/schedules`],
      ["PUT", `/professionals/${B.proId}/schedules`, { unitId: B.unitId, days: [] }],
      ["GET", `/professionals/${B.proId}/blocks`], ["POST", `/professionals/${B.proId}/blocks`, { startsAt: tue(8), endsAt: tue(9) }],
      ["DELETE", `/professionals/${B.proId}/blocks/${bBlockId}`],
      ["GET", `/appointments?from=${tue(0)}&to=${tue(23)}`], ["POST", "/appointments", { unitId: B.unitId }],
      ["GET", `/appointments/${bApptId}`], ["POST", `/appointments/${bApptId}/confirm`], ["POST", `/appointments/${bApptId}/complete`],
      ["POST", `/appointments/${bApptId}/no-show`], ["POST", `/appointments/${bApptId}/cancel`, {}],
      ["POST", `/appointments/${bApptId}/reschedule`, { startsAt: tue(11) }],
      ["POST", `/appointments/${bApptId}/payments`, { method: "cash", amountCents: 100 }], ["GET", `/appointments/${bApptId}/payments`],
      ["GET", "/customers"], ["POST", "/customers", { name: "Hack", phone: "71999990000" }], ["GET", `/customers/${bCustomerId}`],
      ["PATCH", `/customers/${bCustomerId}`, { name: "Hack" }], ["POST", `/customers/${bCustomerId}/consents`, { email: true, granted: true }],
      ["GET", `/customers/${bCustomerId}/export`], ["POST", `/customers/${bCustomerId}/anonymize`],
      ["GET", `/reports/summary?from=${tue(0)}&to=${tue(23)}`], ["GET", "/audit"],
    ];
    const failures: string[] = [];
    for (const [method, path, body] of routes) {
      const r = await api(method, o + path, { token: A.ownerToken, body, headers: method === "POST" && path.endsWith("/payments") ? { "idempotency-key": "chave-de-teste-1" } : {} });
      if (r.status !== 404) failures.push(`${method} ${path} → ${r.status}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);

    // B continua intacto
    const still = await E.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(B.orgId).first<{ name: string }>();
    expect(still!.name).toBe("Barbearia isoB");
  });

  it("sem login → 401 em toda rota da organização", async () => {
    const o = `/api/orgs/${B.orgId}`;
    for (const [m, p] of [["GET", ""], ["GET", "/customers"], ["GET", `/appointments/${bApptId}`], ["GET", "/members"]] as const) {
      expect((await api(m, o + p)).status).toBe(401);
    }
  });

  it("ID de B dentro da URL de A nunca vaza (recursos cruzados)", async () => {
    const a = `/api/orgs/${A.orgId}`;
    expect((await api("GET", `${a}/appointments/${bApptId}`, { token: A.ownerToken })).status).toBe(404);
    expect((await api("GET", `${a}/customers/${bCustomerId}`, { token: A.ownerToken })).status).toBe(404);
    expect((await api("PATCH", `${a}/professionals/${B.proId}`, { token: A.ownerToken, body: { name: "Hack" } })).status).toBe(404);
    expect((await api("PATCH", `${a}/services/${B.serviceId}`, { token: A.ownerToken, body: { name: "Hack" } })).status).toBe(404);
    expect((await api("PATCH", `${a}/units/${B.unitId}`, { token: A.ownerToken, body: { name: "Hack" } })).status).toBe(404);
  });

  it("não é possível referenciar entidades de B ao escrever em A", async () => {
    const a = `/api/orgs/${A.orgId}`;
    // serviço de B no profissional de A
    const s = await api("PUT", `${a}/professionals/${A.proId}/services`, { token: A.ownerToken, body: { services: [{ serviceId: B.serviceId }] } });
    expect(s.status).toBe(422);
    // unidade de B ao criar profissional em A
    const p = await api("POST", `${a}/professionals`, { token: A.ownerToken, body: { name: "Intruso", unitIds: [B.unitId] } });
    expect([403, 422]).toContain(p.status);
    // cliente de B em agendamento de A
    const ap = await api("POST", `${a}/appointments`, {
      token: A.ownerToken, body: { unitId: A.unitId, professionalId: A.proId, serviceIds: [A.serviceId], startsAt: tue(11), customerId: bCustomerId },
    });
    expect(ap.status).toBe(422);
    // profissional/serviço de B pela agenda de A
    const ap2 = await api("POST", `${a}/appointments`, {
      token: A.ownerToken, body: { unitId: A.unitId, professionalId: B.proId, serviceIds: [B.serviceId], startsAt: tue(11), customer: { name: "Fulano", phone: "71911112222" } },
    });
    expect(ap2.status).toBe(422);
    // vínculo (membership) de B como responsável do profissional de A
    const m = await E.DB.prepare("SELECT id FROM memberships WHERE organization_id = ?").bind(B.orgId).first<{ id: string }>();
    const link = await api("PATCH", `${a}/professionals/${A.proId}`, { token: A.ownerToken, body: { memberId: m!.id } });
    expect(link.status).toBe(422);
    // horário em unidade de B
    const sch = await api("PUT", `${a}/professionals/${A.proId}/schedules`, { token: A.ownerToken, body: { unitId: B.unitId, days: [] } });
    expect([403, 422]).toContain(sch.status);
  });

  it("banco recusa referência cruzada mesmo se o código errasse (FK composta)", async () => {
    const now = new Date().toISOString();
    await expect(
      E.DB.prepare(
        `INSERT INTO appointments (id, organization_id, unit_id, professional_id, customer_id, starts_at, ends_at, status, source, total_cents, duration_min, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'admin', 0, 30, ?, ?)`,
      )
        .bind(uniq("x"), A.orgId, A.unitId, A.proId, bCustomerId, "2026-11-12T13:00:00Z", "2026-11-12T13:30:00Z", now, now)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("listagens de A nunca contêm dados de B", async () => {
    const a = `/api/orgs/${A.orgId}`;
    const cust = await api("GET", `${a}/customers`, { token: A.ownerToken });
    expect(cust.body.customers).toEqual([]);
    const ag = await api("GET", `${a}/appointments?from=${tue(0)}&to=${tue(23)}`, { token: A.ownerToken });
    expect(ag.body.appointments).toEqual([]);
    const pros = await api("GET", `${a}/professionals`, { token: A.ownerToken });
    expect(pros.body.professionals.every((p: { id: string }) => p.id !== B.proId)).toBe(true);
    const rep = await api("GET", `${a}/reports/summary?from=${tue(0)}&to=${tue(23)}`, { token: A.ownerToken });
    expect(rep.body.byStatus).toEqual([]);
    const audit = await api("GET", `${a}/audit`, { token: A.ownerToken });
    expect(audit.body.entries.every((e: { details: string | null }) => !(e.details ?? "").includes(B.orgId))).toBe(true);
  });

  it("página pública mostra só a unidade pedida", async () => {
    const r = await api("GET", `/api/public/units/${A.slug}`);
    expect(r.status).toBe(200);
    const txt = JSON.stringify(r.body);
    expect(txt).not.toContain(B.proId);
    expect(txt).not.toContain(B.serviceId);
    expect(txt).not.toContain(B.orgId);
    expect((await api("GET", "/api/public/units/nao-existe-aqui")).status).toBe(404);
  });

  it("vínculo ativo em A não dá acesso a B (usuário de duas lojas só vê o que tem)", async () => {
    // dono de A convidado como gerente em B
    const email = `${A.ownerUid}@teste.local`;
    const inv = await api("POST", `/api/orgs/${B.orgId}/members`, { token: B.ownerToken, body: { email, role: "manager", unitId: B.unitId } });
    expect(inv.status).toBe(201);
    // em B tem papel de gerente: lê agenda, mas não administra equipe nem anonimiza
    expect((await api("GET", `/api/orgs/${B.orgId}/appointments?from=${tue(0)}&to=${tue(23)}`, { token: A.ownerToken })).status).toBe(200);
    expect((await api("GET", `/api/orgs/${B.orgId}/members`, { token: A.ownerToken })).status).toBe(403);
    expect((await api("POST", `/api/orgs/${B.orgId}/customers/${bCustomerId}/anonymize`, { token: A.ownerToken })).status).toBe(403);
    expect((await api("GET", `/api/orgs/${B.orgId}/audit`, { token: A.ownerToken })).status).toBe(403);
  });
});
