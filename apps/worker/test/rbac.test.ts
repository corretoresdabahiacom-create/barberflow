import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, createShop, reset, signToken, tue, uniq, type Shop } from "./helpers";

beforeEach(reset);

const range = () => `from=${tue(0)}&to=${tue(23, 59)}`;

describe("permissões por papel (RBAC)", () => {
  let S: Shop;
  beforeEach(async () => {
    S = await createShop("rbac");
  });

  it("barbeiro: sem equipe, serviços, clientes, relatórios, auditoria e unidade", async () => {
    const b = await addStaff(S, "barber");
    const o = `/api/orgs/${S.orgId}`;
    expect((await api("GET", `${o}/members`, { token: b.token })).status).toBe(403);
    expect((await api("POST", `${o}/services`, { token: b.token, body: { name: "Hack", priceCents: 1, durationMin: 5 } })).status).toBe(403);
    expect((await api("GET", `${o}/customers`, { token: b.token })).status).toBe(403);
    expect((await api("POST", `${o}/customers`, { token: b.token, body: { name: "Fulano", phone: "71999990000" } })).status).toBe(403);
    expect((await api("GET", `${o}/reports/summary?${range()}`, { token: b.token })).status).toBe(403);
    expect((await api("GET", `${o}/audit`, { token: b.token })).status).toBe(403);
    expect((await api("PATCH", `${o}/units/${S.unitId}`, { token: b.token, body: { name: "Hack" } })).status).toBe(403);
    expect((await api("PATCH", o, { token: b.token, body: { name: "Hack" } })).status).toBe(403);
    expect((await adminBook(S, tue(10), {}, b.token)).status).toBe(403); // criar agendamento exige agenda.write
  });

  it("barbeiro vê e opera somente a própria agenda", async () => {
    const b = await addStaff(S, "barber");
    const o = `/api/orgs/${S.orgId}`;
    // profissional vinculado ao barbeiro
    const pro2 = await api("POST", `${o}/professionals`, { token: S.ownerToken, body: { name: "Carlos", unitIds: [S.unitId], memberId: b.membershipId } });
    expect(pro2.status).toBe(201);
    const days = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));
    await api("PUT", `${o}/professionals/${pro2.body.id}/services`, { token: S.ownerToken, body: { services: [{ serviceId: S.serviceId }] } });
    await api("PUT", `${o}/professionals/${pro2.body.id}/schedules`, { token: S.ownerToken, body: { unitId: S.unitId, days } });

    const mine = await adminBook(S, tue(10), { professionalId: pro2.body.id }, S.ownerToken, "71911110001");
    const other = await adminBook(S, tue(10), {}, S.ownerToken, "71911110002"); // profissional João
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(other.status).toBe(201);

    const list = await api("GET", `${o}/appointments?${range()}`, { token: b.token });
    expect(list.status).toBe(200);
    const ids = list.body.appointments.map((a: { id: string }) => a.id);
    expect(ids).toEqual([mine.body.appointment.id]);

    expect((await api("GET", `${o}/appointments/${other.body.appointment.id}`, { token: b.token })).status).toBe(404);
    expect((await api("POST", `${o}/appointments/${other.body.appointment.id}/cancel`, { token: b.token, body: {} })).status).toBe(403);
    expect((await api("GET", `${o}/appointments/${mine.body.appointment.id}`, { token: b.token })).status).toBe(200);
    // pode cancelar o próprio, mas não trocar de profissional nem forçar encaixe
    expect((await api("POST", `${o}/appointments/${mine.body.appointment.id}/reschedule`, { token: b.token, body: { startsAt: tue(12), professionalId: S.proId } })).status).toBe(403);
    expect((await api("POST", `${o}/appointments/${mine.body.appointment.id}/reschedule`, { token: b.token, body: { startsAt: tue(12), override: true } })).status).toBe(403);
    expect((await api("POST", `${o}/appointments/${mine.body.appointment.id}/reschedule`, { token: b.token, body: { startsAt: tue(12) } })).status).toBe(200);
    expect((await api("POST", `${o}/appointments/${mine.body.appointment.id}/cancel`, { token: b.token, body: {} })).status).toBe(200);
  });

  it("recebimento: barbeiro só com a flag, e só nos próprios atendimentos", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const noFlag = await addStaff(S, "barber");
    const withFlag = await addStaff(S, "barber", { canReceivePayments: true });
    // `withFlag` é profissional Carlos
    const pro2 = await api("POST", `${o}/professionals`, { token: S.ownerToken, body: { name: "Carlos", unitIds: [S.unitId], memberId: withFlag.membershipId } });
    const days = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));
    await api("PUT", `${o}/professionals/${pro2.body.id}/services`, { token: S.ownerToken, body: { services: [{ serviceId: S.serviceId }] } });
    await api("PUT", `${o}/professionals/${pro2.body.id}/schedules`, { token: S.ownerToken, body: { unitId: S.unitId, days } });

    const mine = await adminBook(S, tue(10), { professionalId: pro2.body.id }, S.ownerToken, "71911110011");
    const other = await adminBook(S, tue(11), {}, S.ownerToken, "71911110012");
    const pay = (id: string, token: string, key: string) =>
      api("POST", `${o}/appointments/${id}/payments`, { token, body: { method: "cash", amountCents: 1000 }, headers: { "idempotency-key": key } });

    expect((await pay(mine.body.appointment.id, noFlag.token, "chave-sem-flag-1")).status).toBe(403);
    expect((await pay(other.body.appointment.id, withFlag.token, "chave-outro-prof-1")).status).toBe(403);
    expect((await pay(mine.body.appointment.id, withFlag.token, "chave-com-flag-1")).status).toBe(201);
  });

  it("gerente: opera agenda/clientes/relatórios, mas não equipe, serviços, unidade nem LGPD", async () => {
    const m = await addStaff(S, "manager");
    const o = `/api/orgs/${S.orgId}`;
    expect((await adminBook(S, tue(10), {}, m.token)).status).toBe(201);
    expect((await api("GET", `${o}/customers`, { token: m.token })).status).toBe(200);
    expect((await api("POST", `${o}/customers`, { token: m.token, body: { name: "Novo Cliente", phone: "71955550000" } })).status).toBe(201);
    expect((await api("GET", `${o}/reports/summary?${range()}`, { token: m.token })).status).toBe(200);
    expect((await api("GET", `${o}/members`, { token: m.token })).status).toBe(403);
    expect((await api("POST", `${o}/services`, { token: m.token, body: { name: "Hack", priceCents: 1, durationMin: 5 } })).status).toBe(403);
    expect((await api("PATCH", `${o}/units/${S.unitId}`, { token: m.token, body: { name: "Hack" } })).status).toBe(403);
    const cid = (await api("GET", `${o}/customers`, { token: m.token })).body.customers[0].id;
    expect((await api("POST", `${o}/customers/${cid}/anonymize`, { token: m.token })).status).toBe(403);
    expect((await api("GET", `${o}/customers/${cid}/export`, { token: m.token })).status).toBe(403);
    // gerente não registra pagamento (sem payment.create)
    const ap = await adminBook(S, tue(11), {}, S.ownerToken, "71911110020");
    expect((await api("POST", `${o}/appointments/${ap.body.appointment.id}/payments`, { token: m.token, body: { method: "cash", amountCents: 100 }, headers: { "idempotency-key": "chave-gerente-1" } })).status).toBe(403);
  });

  it("admin de unidade não alcança outra unidade da mesma organização", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const u2 = await api("POST", `${o}/units`, { token: S.ownerToken, body: { name: "Filial", slug: uniq("filial-") } });
    expect(u2.status).toBe(201);
    const adm = await addStaff(S, "unit_admin"); // unidade 1
    expect((await api("PATCH", `${o}/units/${S.unitId}`, { token: adm.token, body: { name: "Matriz Nova" } })).status).toBe(200);
    expect((await api("PATCH", `${o}/units/${u2.body.id}`, { token: adm.token, body: { name: "Hack" } })).status).toBe(403);
    const units = await api("GET", `${o}/units`, { token: adm.token });
    expect(units.body.units.map((u: { id: string }) => u.id)).toEqual([S.unitId]);
    // catálogo de serviços é da organização: admin de unidade não altera preços das outras unidades
    expect((await api("POST", `${o}/services`, { token: adm.token, body: { name: "Hack", priceCents: 1, durationMin: 5 } })).status).toBe(403);
    expect((await api("PATCH", `${o}/services/${S.serviceId}`, { token: adm.token, body: { priceCents: 1 } })).status).toBe(403);
    // não cria unidade (org.manage) nem convida (user.manage)
    expect((await api("POST", `${o}/units`, { token: adm.token, body: { name: "Outra", slug: uniq("o-") } })).status).toBe(403);
    expect((await api("POST", `${o}/members`, { token: adm.token, body: { email: "x@y.co", role: "barber", unitId: S.unitId } })).status).toBe(403);
    // agenda da filial: sem acesso
    const ag = await api("POST", `${o}/appointments`, { token: adm.token, body: { unitId: u2.body.id, professionalId: S.proId, serviceIds: [S.serviceId], startsAt: tue(10), customer: { name: "Fulano", phone: "71900000000" } } });
    expect(ag.status).toBe(403);
  });

  it("slug da unidade é imutável (API e banco)", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const r = await api("PATCH", `${o}/units/${S.unitId}`, { token: S.ownerToken, body: { slug: "outro-slug" } });
    expect(r.status).toBe(400);
    await expect(E.DB.prepare("UPDATE units SET slug = 'trocado-direto' WHERE id = ?").bind(S.unitId).run()).rejects.toThrow(/slug_immutable/);
  });

  it("equipe: dono não pode ser atribuído nem removido por último; convites", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const asOwner = await api("POST", `${o}/members`, { token: S.ownerToken, body: { email: "novo@teste.local", role: "owner", unitId: S.unitId } });
    expect(asOwner.status).toBe(400);
    const mems = await api("GET", `${o}/members`, { token: S.ownerToken });
    const ownerM = mems.body.members.find((m: { role: string }) => m.role === "owner");
    expect((await api("DELETE", `${o}/members/${ownerM.id}`, { token: S.ownerToken })).status).toBe(409);
    expect((await api("PATCH", `${o}/members/${ownerM.id}`, { token: S.ownerToken, body: { status: "suspended" } })).status).toBe(409);
    expect((await api("PATCH", `${o}/members/${ownerM.id}`, { token: S.ownerToken, body: { role: "barber" } })).status).toBe(409);
  });

  it("convite por e-mail só vale com e-mail VERIFICADO no login", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const email = `${uniq("conv")}@teste.local`;
    const inv = await api("POST", `${o}/members`, { token: S.ownerToken, body: { email, role: "manager", unitId: S.unitId } });
    expect(inv.status).toBe(201);
    expect(inv.body.status).toBe("invited");

    // tenta se passar pelo convidado com e-mail NÃO verificado
    const fake = await signToken({ uid: uniq("fake"), email, verified: false });
    const meFake = await api("GET", "/api/me", { token: fake });
    expect(meFake.body.memberships).toEqual([]);
    expect((await api("GET", `${o}/customers`, { token: fake })).status).toBe(404);

    // o dono legítimo do e-mail (verificado) assume o vínculo
    const real = await signToken({ uid: uniq("real"), email, verified: true });
    const meReal = await api("GET", "/api/me", { token: real });
    expect(meReal.body.memberships.length).toBe(1);
    expect(meReal.body.memberships[0].role).toBe("manager");
    expect((await api("GET", `${o}/customers`, { token: real })).status).toBe(200);
  });

  it("vínculo suspenso perde acesso imediatamente", async () => {
    const m = await addStaff(S, "manager");
    const o = `/api/orgs/${S.orgId}`;
    expect((await api("GET", `${o}/customers`, { token: m.token })).status).toBe(200);
    expect((await api("PATCH", `${o}/members/${m.membershipId}`, { token: S.ownerToken, body: { status: "suspended" } })).status).toBe(200);
    expect((await api("GET", `${o}/customers`, { token: m.token })).status).toBe(404);
    expect((await api("DELETE", `${o}/members/${m.membershipId}`, { token: S.ownerToken })).status).toBe(200);
  });

  it("cliente logado só enxerga os próprios agendamentos; vínculo só por e-mail verificado, nunca por telefone", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const phone = "71933334444";
    const email = `${uniq("cli")}@teste.local`;
    // equipe cadastra cliente com telefone e e-mail e agenda
    const cust = await api("POST", `${o}/customers`, { token: S.ownerToken, body: { name: "Cliente Real", phone, email } });
    const ap = await adminBook(S, tue(10), { customerId: cust.body.id, customer: undefined }, S.ownerToken);
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);

    // atacante: login com outro e-mail, "digita" o mesmo telefone no 1º agendamento do app
    const atk = await signToken({ uid: uniq("atk"), email: `${uniq("atk")}@teste.local` });
    const bk = await api("POST", `/api/me/units/${S.slug}/appointments`, {
      token: atk, body: { name: "Atacante", phone, professionalId: S.proId, serviceIds: [S.serviceId], startsAt: tue(12) },
    });
    expect(bk.status, JSON.stringify(bk.body)).toBe(201);
    const atkList = await api("GET", "/api/me/appointments", { token: atk });
    expect(atkList.body.appointments.length).toBe(1); // só o dele
    expect(atkList.body.appointments[0].id).toBe(bk.body.appointment.id);
    expect(atkList.body.appointments.some((a: { id: string }) => a.id === ap.body.appointment.id)).toBe(false);
    expect((await api("POST", `/api/me/appointments/${ap.body.appointment.id}/cancel`, { token: atk, body: {} })).status).toBe(404);

    // e-mail NÃO verificado não vincula
    const unv = await signToken({ uid: uniq("unv"), email, verified: false });
    await api("GET", "/api/me", { token: unv });
    expect((await api("GET", "/api/me/appointments", { token: unv })).body.appointments).toEqual([]);

    // titular real, com o e-mail verificado, vê seu histórico
    const real = await signToken({ uid: uniq("real"), email, verified: true });
    await api("GET", "/api/me", { token: real });
    const mine = await api("GET", "/api/me/appointments", { token: real });
    expect(mine.body.appointments.map((a: { id: string }) => a.id)).toEqual([ap.body.appointment.id]);
    expect((await api("POST", `/api/me/appointments/${ap.body.appointment.id}/cancel`, { token: real, body: {} })).status).toBe(200);
  });
});
