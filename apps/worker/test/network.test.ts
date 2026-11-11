import { beforeEach, describe, expect, it } from "vitest";
import { E, addStaff, adminBook, api, clock, completeAppt, createShop, giveNetworkPlan, reset, signToken, tue, type Shop } from "./helpers";

beforeEach(reset);

const net = (S: Shop, path = "", method = "GET", body?: unknown, token = S.ownerToken) => api(method, `/api/orgs/${S.orgId}/network${path}`, { token, body });

async function makeNetwork(A: Shop, name = "Rede Régua"): Promise<string> {
  await giveNetworkPlan(A.orgId);
  const r = await net(A, "", "POST", { name });
  expect(r.status).toBe(201);
  return r.body.id;
}
async function invite(A: Shop): Promise<string> {
  const r = await net(A, "/invites", "POST");
  expect(r.status).toBe(201);
  return r.body.code;
}
const join = (S: Shop, code: string, accept: unknown = true) => net(S, "/join", "POST", { code, acceptSharing: accept });

/** Atendimento concluído com cliente identificável (para provar que nada pessoal vaza no agregado). */
async function sale(S: Shop, name: string, phone: string, hour: number) {
  const ap = await adminBook(S, tue(hour), { customer: { name, phone, email: `${phone}@segredo.test` } }, S.ownerToken, phone);
  expect(ap.status).toBe(201);
  expect((await completeAppt(S, ap.body.appointment.id)).status).toBe(200);
  clock.ms = Date.UTC(2026, 10, 6, 15, 0, 0);
  S.ownerToken = await signToken({ uid: S.ownerUid }); // token emitido "no futuro" seria recusado
}
const period = () => `from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-12-31T00:00:00Z")}`;

describe("rede/franquia: criação, convite e consentimento", () => {
  it("criar rede exige o plano com rede e ser proprietário", async () => {
    const A = await createShop("net-a");
    const r = await net(A, "", "POST", { name: "Minha rede" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("plan_no_network");
    expect((await net(A)).body.canCreate).toBe(false);
    await giveNetworkPlan(A.orgId);
    const admin = await addStaff(A, "unit_admin");
    expect((await net(A, "", "POST", { name: "Minha rede" }, admin.token)).status).toBe(403);
    expect((await net(A, "", "POST", { name: "Minha rede" })).status).toBe(201);
    expect((await net(A, "", "POST", { name: "Outra" })).body.error.code).toBe("already_in_network");
  });

  it("entrar exige aceite explícito (acceptSharing: true) e convite válido de uso único", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    const C = await createShop("net-c");
    await makeNetwork(A);
    const code = await invite(A);
    expect((await join(B, code, false)).status).toBe(400);
    expect((await join(B, code, null)).status).toBe(400);
    expect((await join(B, "codigo-errado-123456")).status).toBe(404);
    expect((await join(B, code)).status).toBe(200);
    expect((await join(C, code)).status).toBe(404); // uso único
    const row = await E.DB.prepare("SELECT consented_by_user_id, consented_at FROM network_members WHERE organization_id = ?").bind(B.orgId).first<{ consented_by_user_id: string }>();
    expect(row?.consented_by_user_id).toBeTruthy(); // aceite registrado
    const aud = await E.DB.prepare("SELECT details FROM audit_logs WHERE organization_id = ? AND action = 'network.joined'").bind(B.orgId).first<{ details: string }>();
    expect(aud?.details).toContain("completed_revenue_cents");
    expect((await join(B, await invite(A))).body.error.code).toBe("already_in_network");
  });

  it("o código do convite não fica no banco (só hash) e expira em 7 dias", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    await makeNetwork(A);
    const code = await invite(A);
    const stored = JSON.stringify((await E.DB.prepare("SELECT * FROM network_invites").all()).results);
    expect(stored).not.toContain(code);
    clock.ms += 8 * 86400_000;
    B.ownerToken = await signToken({ uid: B.ownerUid });
    expect((await join(B, code)).body.error.code).toBe("invalid_invite");
  });

  it("limite de 5 convites abertos", async () => {
    const A = await createShop("net-a");
    await makeNetwork(A);
    for (let i = 0; i < 5; i++) await invite(A);
    expect((await net(A, "/invites", "POST")).status).toBe(409);
  });

  it("só a administradora convida; só proprietário usa as rotas", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    await makeNetwork(A);
    expect((await join(B, await invite(A))).status).toBe(200);
    expect((await net(B, "/invites", "POST")).status).toBe(403);
    const mgr = await addStaff(B, "manager");
    expect((await net(B, "", "GET", undefined, mgr.token)).status).toBe(403);
    expect((await net(B, "/report?" + period(), "GET", undefined, mgr.token)).status).toBe(403);
  });
});

describe("rede/franquia: relatório agregado e isolamento", () => {
  it("administradora vê uma linha por organização; membro vê só a própria + total; sem dados de cliente; terceiros ficam de fora", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    const C = await createShop("net-c"); // fora da rede
    await makeNetwork(A);
    await join(B, await invite(A));
    await sale(A, "Ana Cliente Secreta", "71911110001", 10);
    await sale(B, "Beto Cliente Secreto", "71911110002", 11);
    await sale(B, "Bia Cliente Secreta", "71911110003", 12);
    await sale(C, "Caio Fora Da Rede", "71911110004", 10);
    for (const S of [A, B, C]) S.ownerToken = await signToken({ uid: S.ownerUid });

    const ra = await net(A, `/report?${period()}`);
    expect(ra.status).toBe(200);
    expect(ra.body.memberCount).toBe(2);
    expect(ra.body.total).toMatchObject({ completed: 3, revenue_cents: 15000 });
    expect(ra.body.organizations).toHaveLength(2);
    expect(ra.body.organizations.find((x: any) => x.organization_id === B.orgId)).toMatchObject({ completed: 2, revenue_cents: 10000 });

    const rb = await net(B, `/report?${period()}`);
    expect(rb.status).toBe(200);
    expect(rb.body.organizations).toHaveLength(1);
    expect(rb.body.organizations[0].organization_id).toBe(B.orgId);
    expect(rb.body.total.completed).toBe(3); // total da rede é visível ao membro; a linha da A não
    expect(JSON.stringify(rb.body)).not.toContain(A.orgId);

    for (const body of [ra.body, rb.body]) {
      const s = JSON.stringify(body);
      for (const leak of ["Secret", "Fora Da Rede", "71911110", "segredo.test"]) expect(s).not.toContain(leak);
    }
    // quem está fora da rede não lê o relatório (404) e não entra no total
    expect((await net(C, `/report?${period()}`)).status).toBe(404);
    expect(ra.body.total.completed).toBe(3);
  });

  it("sair encerra o compartilhamento na hora; administradora não encerra com membros", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    await makeNetwork(A);
    await join(B, await invite(A));
    await sale(B, "Beto Sair", "71922220001", 10);
    A.ownerToken = await signToken({ uid: A.ownerUid });
    B.ownerToken = await signToken({ uid: B.ownerUid });
    expect((await net(A, `/report?${period()}`)).body.total.completed).toBe(1);
    expect((await net(A, "/leave", "POST")).body.error.code).toBe("admin_has_members");
    expect((await net(B, "/leave", "POST")).status).toBe(200);
    expect((await net(A, `/report?${period()}`)).body.total.completed).toBe(0);
    expect((await net(B, `/report?${period()}`)).status).toBe(404);
    const a = await E.DB.prepare("SELECT 1 AS x FROM audit_logs WHERE organization_id = ? AND action = 'network.member_left'").bind(A.orgId).first();
    expect(a).toBeTruthy();
    expect((await net(A, "/leave", "POST")).status).toBe(200); // sozinha: encerra
    expect((await net(A)).body.network).toBeNull();
  });

  it("administradora remove membro; membro não remove ninguém; ids de outras redes dão 404", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    const D = await createShop("net-d");
    const E2 = await createShop("net-e");
    await makeNetwork(A);
    await join(B, await invite(A));
    await giveNetworkPlan(D.orgId);
    await net(D, "", "POST", { name: "Rede D" });
    await join(E2, await invite(D));
    expect((await net(B, `/members/${A.orgId}`, "DELETE")).status).toBe(403);
    expect((await net(A, `/members/${E2.orgId}`, "DELETE")).status).toBe(404); // membro de OUTRA rede
    expect((await net(A, `/members/${A.orgId}`, "DELETE")).status).toBe(409);
    expect((await net(A, `/members/${B.orgId}`, "DELETE")).status).toBe(200);
    expect((await net(B)).body.network).toBeNull();
    const still = await E.DB.prepare("SELECT 1 AS x FROM network_members WHERE organization_id = ?").bind(E2.orgId).first();
    expect(still).toBeTruthy();
  });

  it("isolamento por URL: dono de A não acessa /network de B; só a lista de membros é da administradora", async () => {
    const A = await createShop("net-a");
    const B = await createShop("net-b");
    await makeNetwork(A);
    await join(B, await invite(A));
    expect((await api("GET", `/api/orgs/${B.orgId}/network`, { token: A.ownerToken })).status).toBe(404);
    expect((await api("GET", `/api/orgs/${A.orgId}/network/report?${period()}`, { token: B.ownerToken })).status).toBe(404);
    const ga = await net(A);
    const gb = await net(B);
    expect(ga.body.members).toHaveLength(2);
    expect(gb.body.members).toBeUndefined();
    expect(gb.body.network).toMatchObject({ role: "member", memberCount: 2 });
    expect(gb.body.sharedFields).toEqual(["completed_appointments", "completed_revenue_cents", "new_customers", "no_shows"]);
  });

  it("período inválido (>366 dias ou invertido) é recusado", async () => {
    const A = await createShop("net-a");
    await makeNetwork(A);
    expect((await net(A, `/report?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(400);
    expect((await net(A, `/report?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(400);
  });
});
