import { beforeEach, describe, expect, it } from "vitest";
import { E, adminBook, api, clock, createShop, reset, signToken, tue, uniq, type Shop } from "./helpers";

beforeEach(reset);

const pub = (S: Shop, startsAt: string, phone: string, extra: Record<string, unknown> = {}) =>
  api("POST", `/api/public/units/${S.slug}/appointments`, {
    body: { turnstileToken: "turnstile-ok", customer: { name: "Cliente Público", phone }, professionalId: S.proId, serviceIds: [S.serviceId], startsAt, ...extra },
  });

const num = async (sql: string, ...b: unknown[]) => (await E.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const phoneN = (i: number) => `71977${String(100000 + i)}`;

async function moveClock(S: Shop, ms: number) {
  clock.ms = ms;
  S.ownerToken = await signToken({ uid: S.ownerUid });
}

describe("disponibilidade", () => {
  it("respeita expediente, domingo, passado, janela máxima e antecedência mínima", async () => {
    const S = await createShop("disp");
    const q = (date: string) => api("GET", `/api/public/units/${S.slug}/availability?professionalId=${S.proId}&serviceIds=${S.serviceId}&date=${date}`);
    const tuesday = await q("2026-11-10");
    expect(tuesday.status).toBe(200);
    expect(tuesday.body.slots.length).toBe(35); // 09:00–17:30, passo 15, serviço 30 min
    expect(tuesday.body.slots[0]).toBe("2026-11-10T12:00:00Z"); // 09:00 em São Paulo
    expect(tuesday.body.durationMin).toBe(30);
    expect(tuesday.body.totalCents).toBe(5000);
    expect((await q("2026-11-08")).body.slots).toEqual([]); // domingo sem expediente
    expect((await q("2026-11-05")).body.slots).toEqual([]); // passado
    expect((await q("2027-03-01")).body.slots).toEqual([]); // além de 60 dias
    const today = await q("2026-11-06"); // agora = 12:00 local, antecedência 60 min
    expect(today.body.slots[0]).toBe("2026-11-06T16:00:00Z"); // 13:00 local
    expect(today.body.slots.length).toBe(19);
  });

  it("bloqueios removem horários; encaixe da equipe respeita bloqueio", async () => {
    const S = await createShop("blk");
    const o = `/api/orgs/${S.orgId}`;
    const blk = await api("POST", `${o}/professionals/${S.proId}/blocks`, { token: S.ownerToken, body: { startsAt: tue(14), endsAt: tue(15), reason: "Almoço" } });
    expect(blk.status).toBe(201);
    const av = await api("GET", `/api/public/units/${S.slug}/availability?professionalId=${S.proId}&serviceIds=${S.serviceId}&date=2026-11-10`);
    for (const s of [tue(14), tue(14, 15), tue(14, 30), tue(14, 45), tue(13, 45)]) expect(av.body.slots).not.toContain(s.replace(".000Z", "Z"));
    expect(av.body.slots).toContain(tue(15).replace(".000Z", "Z"));
    expect(av.body.slots).toContain(tue(13, 30).replace(".000Z", "Z"));
    const forced = await adminBook(S, tue(14, 15), { override: true });
    expect(forced.status).toBe(409);
    expect(forced.body.error.code).toBe("blocked");
    // fora do expediente: só com encaixe (override)
    expect((await adminBook(S, tue(8))).status).toBe(409);
    expect((await adminBook(S, tue(8), { override: true }, S.ownerToken, "71911119999")).status).toBe(201);
    // remover bloqueio devolve os horários
    expect((await api("DELETE", `${o}/professionals/${S.proId}/blocks/${blk.body.id}`, { token: S.ownerToken })).status).toBe(200);
    const av2 = await api("GET", `/api/public/units/${S.slug}/availability?professionalId=${S.proId}&serviceIds=${S.serviceId}&date=2026-11-10`);
    expect(av2.body.slots).toContain(tue(14).replace(".000Z", "Z"));
  });
});

describe("dupla reserva: o banco é a barreira final", () => {
  let S: Shop;
  beforeEach(async () => {
    S = await createShop("race");
  });

  it("8 reservas simultâneas no mesmo horário → exatamente 1 vence, 7 recebem 409", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => pub(S, tue(10), phoneN(i))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201).length, JSON.stringify(results.map((r) => [r.status, r.body.error?.code]))).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(7);
    for (const r of results.filter((r) => r.status === 409)) expect(["slot_taken", "slot_unavailable"]).toContain(r.body.error.code);

    const iso = tue(10).replace(".000Z", "Z");
    expect(await num("SELECT COUNT(*) AS n FROM appointments WHERE organization_id = ? AND starts_at = ?", S.orgId, iso)).toBe(1);
    expect(await num("SELECT COUNT(*) AS n FROM appointment_slots WHERE organization_id = ?", S.orgId)).toBe(6); // 30 min = 6 blocos de 5
    // sem órfãos: todo item e histórico pertence ao único agendamento
    expect(await num("SELECT COUNT(*) AS n FROM appointment_items WHERE organization_id = ?", S.orgId)).toBe(1);
    expect(await num("SELECT COUNT(*) AS n FROM appointments WHERE organization_id = ?", S.orgId)).toBe(1);
  });

  it("reservas sobrepostas parcialmente são recusadas; adjacentes são aceitas", async () => {
    expect((await pub(S, tue(10), phoneN(1))).status).toBe(201);
    expect((await pub(S, tue(10, 15), phoneN(2))).status).toBe(409);
    expect((await pub(S, tue(9, 45), phoneN(3))).status).toBe(409);
    expect((await pub(S, tue(10, 30), phoneN(4))).status).toBe(201);
    expect((await pub(S, tue(9, 30), phoneN(5))).status).toBe(201);
  });

  it("batch é atômico: falha no meio desfaz tudo (inserção de agendamento + slot conflitante)", async () => {
    const a1 = await adminBook(S, tue(10), {}, S.ownerToken, phoneN(1));
    const a2 = await adminBook(S, tue(11), {}, S.ownerToken, phoneN(2));
    expect(a1.status).toBe(201);
    const a1Slot = (await E.DB.prepare("SELECT slot FROM appointment_slots WHERE appointment_id = ? LIMIT 1").bind(a1.body.appointment.id).first<{ slot: number }>())!.slot;
    const a2Row = (await E.DB.prepare("SELECT customer_id FROM appointments WHERE id = ?").bind(a2.body.appointment.id).first<{ customer_id: string }>())!;
    const now = "2026-11-06T15:00:00Z";
    const ghost = uniq("ghost");

    await expect(
      E.DB.batch([
        E.DB.prepare(
          `INSERT INTO appointments (id, organization_id, unit_id, professional_id, customer_id, starts_at, ends_at, status, source, total_cents, duration_min, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '2026-11-10T20:00:00Z', '2026-11-10T20:30:00Z', 'confirmed', 'admin', 0, 30, ?, ?)`,
        ).bind(ghost, S.orgId, S.unitId, S.proId, a2Row.customer_id, now, now),
        E.DB.prepare("INSERT INTO appointment_slots (professional_id, slot, organization_id, appointment_id) VALUES (?, ?, ?, ?)").bind(S.proId, a1Slot, S.orgId, ghost),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await num("SELECT COUNT(*) AS n FROM appointments WHERE id = ?", ghost)).toBe(0);

    // remarcação com conflito: DELETE dos slots antigos + INSERT conflitante → nada muda
    await expect(
      E.DB.batch([
        E.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(a2.body.appointment.id),
        E.DB.prepare("INSERT INTO appointment_slots (professional_id, slot, organization_id, appointment_id) VALUES (?, ?, ?, ?)").bind(S.proId, a1Slot, S.orgId, a2.body.appointment.id),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await num("SELECT COUNT(*) AS n FROM appointment_slots WHERE appointment_id = ?", a2.body.appointment.id)).toBe(6);
  });

  it("remarcar para horário ocupado → 409 e o original permanece; remarcar para livre libera o antigo", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const a1 = await adminBook(S, tue(10), {}, S.ownerToken, phoneN(1));
    const a2 = await adminBook(S, tue(11), {}, S.ownerToken, phoneN(2));
    const bad = await api("POST", `${o}/appointments/${a2.body.appointment.id}/reschedule`, { token: S.ownerToken, body: { startsAt: tue(10, 15) } });
    expect(bad.status).toBe(409);
    const kept = await E.DB.prepare("SELECT starts_at FROM appointments WHERE id = ?").bind(a2.body.appointment.id).first<{ starts_at: string }>();
    expect(kept!.starts_at).toBe(tue(11).replace(".000Z", "Z"));
    expect(await num("SELECT COUNT(*) AS n FROM appointment_slots WHERE appointment_id = ?", a2.body.appointment.id)).toBe(6);

    const ok = await api("POST", `${o}/appointments/${a2.body.appointment.id}/reschedule`, { token: S.ownerToken, body: { startsAt: tue(12) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await num("SELECT COUNT(*) AS n FROM appointment_slots WHERE appointment_id = ?", a2.body.appointment.id)).toBe(6);
    expect((await pub(S, tue(11), phoneN(3))).status).toBe(201); // horário antigo liberado
    // remarcar sobre si mesmo (deslocar 15 min) é permitido: não conflita com os próprios slots
    expect((await api("POST", `${o}/appointments/${a1.body.appointment.id}/reschedule`, { token: S.ownerToken, body: { startsAt: tue(10, 15) } })).status).toBe(200);
  });

  it("cancelar libera o horário; cancelar de novo → 409", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const a1 = await adminBook(S, tue(10), {}, S.ownerToken, phoneN(1));
    expect((await pub(S, tue(10), phoneN(2))).status).toBe(409);
    expect((await api("POST", `${o}/appointments/${a1.body.appointment.id}/cancel`, { token: S.ownerToken, body: { reason: "pedido" } })).status).toBe(200);
    expect(await num("SELECT COUNT(*) AS n FROM appointment_slots WHERE appointment_id = ?", a1.body.appointment.id)).toBe(0);
    expect((await pub(S, tue(10), phoneN(2))).status).toBe(201);
    expect((await api("POST", `${o}/appointments/${a1.body.appointment.id}/cancel`, { token: S.ownerToken, body: {} })).status).toBe(409);
  });
});

describe("reserva pública: abuso e autoatendimento", () => {
  let S: Shop;
  beforeEach(async () => {
    S = await createShop("abuso");
  });

  it("Turnstile ausente/ inválido → 403; honeypot → 400; telefone inválido → 400", async () => {
    const base = { customer: { name: "Fulano Teste", phone: phoneN(1) }, professionalId: S.proId, serviceIds: [S.serviceId], startsAt: tue(10) };
    expect((await api("POST", `/api/public/units/${S.slug}/appointments`, { body: base })).status).toBe(403);
    expect((await api("POST", `/api/public/units/${S.slug}/appointments`, { body: { ...base, turnstileToken: "errado" } })).status).toBe(403);
    expect((await pub(S, tue(10), phoneN(1), { website: "http://spam" })).status).toBe(400);
    expect((await pub(S, tue(10), "123")).status).toBe(400);
    expect((await pub(S, tue(10), phoneN(1), { extra: 1 })).status).toBe(400); // schema estrito
    expect(await num("SELECT COUNT(*) AS n FROM appointments WHERE organization_id = ?", S.orgId)).toBe(0);
  });

  it("limite de 3 agendamentos futuros por telefone → 4º recebe 429", async () => {
    const phone = phoneN(7);
    for (const h of [9, 10, 11]) expect((await pub(S, tue(h), phone)).status).toBe(201);
    const r = await pub(S, tue(12), phone);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("booking_limit");
  });

  it("limite de requisições por IP (10 reservas / 10 min) → 429 rate_limited", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await pub(S, tue(9), phoneN(100 + i))).status);
    expect(codes.includes(429)).toBe(true);
  });

  it("serviço/profissional inválidos e horário desalinhado", async () => {
    expect((await pub(S, tue(10), phoneN(1), { serviceIds: ["00000000-0000-0000-0000-000000000000"] })).status).toBe(422);
    expect((await pub(S, tue(10, 2), phoneN(2))).status).toBe(400);
    expect((await pub(S, "lixo", phoneN(3))).status).toBe(400);
    expect((await pub(S, tue(10), phoneN(4), { professionalId: "00000000-0000-0000-0000-000000000000" })).status).toBe(422);
  });

  it("cancelamento pelo cliente via token secreto; janela de cancelamento", async () => {
    const r = await pub(S, tue(10), phoneN(1));
    const { id } = r.body.appointment;
    const token = r.body.cancelToken;
    expect(token.length).toBeGreaterThan(20);
    // o token nunca é guardado em claro
    const row = await E.DB.prepare("SELECT cancel_token_hash FROM appointments WHERE id = ?").bind(id).first<{ cancel_token_hash: string }>();
    expect(row!.cancel_token_hash).not.toBe(token);
    expect(row!.cancel_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect((await api("POST", `/api/public/appointments/${id}/cancel`, { body: { token: "x".repeat(30) } })).status).toBe(404);
    const view = await api("POST", `/api/public/appointments/${id}/view`, { body: { token } });
    expect(view.status).toBe(200);
    expect(view.body.appointment.status).toBe("confirmed");
    expect(JSON.stringify(view.body)).not.toContain("cancel_token_hash");
    expect(JSON.stringify(view.body)).not.toContain(phoneN(1));

    // fora da janela (2h antes): recusa
    clock.ms = Date.UTC(2026, 10, 10, 12, 0, 0); // 09:00 local; atendimento 10:00 local
    const late = await api("POST", `/api/public/appointments/${id}/cancel`, { body: { token } });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("cancel_window_passed");
    // dentro da janela
    clock.ms = Date.UTC(2026, 10, 8, 12, 0, 0);
    expect((await api("POST", `/api/public/appointments/${id}/cancel`, { body: { token } })).status).toBe(200);
    expect((await api("POST", `/api/public/appointments/${id}/cancel`, { body: { token } })).status).toBe(409);
  });

  it("token de um agendamento não cancela outro", async () => {
    const a = await pub(S, tue(10), phoneN(1));
    const b = await pub(S, tue(11), phoneN(2));
    expect((await api("POST", `/api/public/appointments/${b.body.appointment.id}/cancel`, { body: { token: a.body.cancelToken } })).status).toBe(404);
  });

  it("preço e duração são copiados no momento da reserva (histórico imutável)", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const a = await adminBook(S, tue(10));
    expect((await api("PATCH", `${o}/services/${S.serviceId}`, { token: S.ownerToken, body: { priceCents: 9999, durationMin: 60 } })).status).toBe(200);
    const d = await api("GET", `${o}/appointments/${a.body.appointment.id}`, { token: S.ownerToken });
    expect(d.body.appointment.total_cents).toBe(5000);
    expect(d.body.items[0].price_cents).toBe(5000);
    expect(d.body.items[0].duration_min).toBe(30);
  });

  it("sem confirmação automática: reserva nasce pendente; fluxo de status", async () => {
    const o = `/api/orgs/${S.orgId}`;
    expect((await api("PATCH", `${o}/units/${S.unitId}`, { token: S.ownerToken, body: { autoConfirm: false } })).status).toBe(200);
    const r = await pub(S, tue(10), phoneN(1));
    expect(r.body.appointment.status).toBe("pending");
    const id = r.body.appointment.id;
    expect((await api("POST", `${o}/appointments/${id}/complete`, { token: S.ownerToken })).status).toBe(409); // pendente não conclui
    expect((await api("POST", `${o}/appointments/${id}/confirm`, { token: S.ownerToken })).status).toBe(200);
    expect((await api("POST", `${o}/appointments/${id}/confirm`, { token: S.ownerToken })).status).toBe(409);
    expect((await api("POST", `${o}/appointments/${id}/complete`, { token: S.ownerToken })).body.error.code).toBe("too_early");
    await moveClock(S, Date.UTC(2026, 10, 10, 14, 0, 0));
    expect((await api("POST", `${o}/appointments/${id}/complete`, { token: S.ownerToken })).body.status).toBe("completed");
    expect((await api("POST", `${o}/appointments/${id}/cancel`, { token: S.ownerToken, body: {} })).status).toBe(409);
  });

  it("falta (no-show) incrementa o contador do cliente", async () => {
    const o = `/api/orgs/${S.orgId}`;
    const a = await adminBook(S, tue(10));
    await moveClock(S, Date.UTC(2026, 10, 10, 14, 0, 0));
    expect((await api("POST", `${o}/appointments/${a.body.appointment.id}/no-show`, { token: S.ownerToken })).body.status).toBe("no_show");
    const cu = await E.DB.prepare("SELECT no_show_count FROM customers WHERE id = (SELECT customer_id FROM appointments WHERE id = ?)").bind(a.body.appointment.id).first<{ no_show_count: number }>();
    expect(cu!.no_show_count).toBe(1);
  });

  it("equipe é notificada de nova reserva pública", async () => {
    await pub(S, tue(10), phoneN(1));
    const n = await api("GET", "/api/me/notifications", { token: S.ownerToken });
    expect(n.status).toBe(200);
    expect(n.body.notifications.some((x: { kind: string }) => x.kind === "appointment.created")).toBe(true);
  });
});
