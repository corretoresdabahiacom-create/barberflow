import { HttpError, notFound } from "../lib/http";
import { SLOT_MS, slotOf, utcMsToLocalDate } from "../lib/time";
import { isoNow, newId, toIso } from "../lib/util";
import { auditStmt, notifyStmt, staffToNotify } from "../lib/audit";
import { computeSlotStarts, loadDayContext, type UnitCfg } from "./availability";

export interface UnitRow extends UnitCfg {
  organization_id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  auto_confirm: number;
  cancel_window_min: number;
  status: string;
}

export interface AppointmentRow {
  id: string;
  organization_id: string;
  unit_id: string;
  professional_id: string;
  customer_id: string;
  starts_at: string;
  ends_at: string;
  status: "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
  source: "public" | "portal" | "admin";
  total_cents: number;
  duration_min: number;
  notes: string | null;
  cancel_token_hash: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
}

interface ResolvedService {
  id: string;
  name: string;
  price_cents: number;
  duration_min: number;
  buffer_min: number;
}

export interface Resolved {
  services: ResolvedService[];
  totalCents: number;
  durationMin: number;
  occupiedMin: number;
}

/** Valida profissional/serviços e calcula preço e duração (com sobrescritas do profissional). */
export async function resolveBooking(
  db: D1Database,
  orgId: string,
  unitId: string,
  professionalId: string,
  serviceIds: string[],
): Promise<Resolved> {
  const ids = [...new Set(serviceIds)];
  if (ids.length < 1 || ids.length > 5) throw new HttpError(400, "validation_error", "Escolha de 1 a 5 serviços");

  const pro = await db
    .prepare(
      `SELECT p.id FROM professionals p
         JOIN professional_units pu ON pu.professional_id = p.id AND pu.organization_id = p.organization_id
        WHERE p.organization_id = ? AND p.id = ? AND p.status = 'active' AND pu.unit_id = ?`,
    )
    .bind(orgId, professionalId, unitId)
    .first();
  if (!pro) throw new HttpError(422, "professional_unavailable", "Profissional indisponível nesta unidade");

  const marks = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.buffer_min,
              COALESCE(ps.price_cents, s.price_cents) AS price_cents,
              COALESCE(ps.duration_min, s.duration_min) AS duration_min
         FROM services s
         JOIN professional_services ps ON ps.service_id = s.id AND ps.organization_id = s.organization_id
        WHERE s.organization_id = ? AND s.status = 'active' AND ps.professional_id = ? AND s.id IN (${marks})`,
    )
    .bind(orgId, professionalId, ...ids)
    .all<ResolvedService>();
  if (results.length !== ids.length) {
    throw new HttpError(422, "service_not_offered", "Serviço indisponível para este profissional");
  }

  const durationMin = results.reduce((a, s) => a + s.duration_min, 0);
  const buffer = Math.max(...results.map((s) => s.buffer_min));
  if (durationMin > 240) throw new HttpError(422, "too_long", "Duração total acima de 4 horas");
  return {
    services: results,
    totalCents: results.reduce((a, s) => a + s.price_cents, 0),
    durationMin,
    occupiedMin: durationMin + buffer,
  };
}

function slotInsertStmts(
  db: D1Database,
  orgId: string,
  professionalId: string,
  appointmentId: string,
  startMs: number,
  occupiedMin: number,
): D1PreparedStatement[] {
  const first = slotOf(startMs);
  const count = occupiedMin / 5;
  const stmts: D1PreparedStatement[] = [];
  for (let off = 0; off < count; off += 20) {
    const n = Math.min(20, count - off);
    const values = Array.from({ length: n }, () => "(?,?,?,?)").join(",");
    const binds: (string | number)[] = [];
    for (let i = 0; i < n; i++) binds.push(professionalId, first + off + i, orgId, appointmentId);
    stmts.push(
      db
        .prepare(`INSERT INTO appointment_slots (professional_id, slot, organization_id, appointment_id) VALUES ${values}`)
        .bind(...binds),
    );
  }
  return stmts;
}

function mapConflict(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("UNIQUE constraint failed: appointment_slots")) {
    throw new HttpError(409, "slot_taken", "Esse horário acabou de ser ocupado. Escolha outro.");
  }
  throw e;
}

async function assertBookable(
  db: D1Database,
  unit: UnitRow,
  orgId: string,
  professionalId: string,
  startMs: number,
  r: Resolved,
  nowMs: number,
  opts: { staffOverride: boolean; excludeAppointmentId?: string },
): Promise<void> {
  if (!Number.isFinite(startMs) || startMs % SLOT_MS !== 0) {
    throw new HttpError(400, "validation_error", "Horário deve estar alinhado a 5 minutos");
  }
  const date = utcMsToLocalDate(startMs, unit.timezone);
  const ctx = await loadDayContext(db, orgId, unit.id, unit.timezone, professionalId, date, opts.excludeAppointmentId);

  if (opts.staffOverride) {
    const end = startMs + r.occupiedMin * 60_000;
    if (ctx.blocks.some((b) => startMs < b.end && end > b.start)) {
      throw new HttpError(409, "blocked", "Horário bloqueado na agenda do profissional");
    }
    for (let s = slotOf(startMs); s < slotOf(end); s++) {
      if (ctx.busy.has(s)) throw new HttpError(409, "slot_taken", "Horário já ocupado");
    }
    return;
  }

  const offered = computeSlotStarts({ unit, date, occupiedMin: r.occupiedMin, ctx, nowMs });
  if (!offered.includes(startMs)) {
    throw new HttpError(409, "slot_unavailable", "Horário indisponível");
  }
}

export interface CreateParams {
  db: D1Database;
  unit: UnitRow;
  professionalId: string;
  customerId: string;
  serviceIds: string[];
  startsAtMs: number;
  source: "public" | "portal" | "admin";
  actorUserId: string | null;
  actorKind: "staff" | "customer";
  notes?: string | null;
  cancelTokenHash?: string | null;
  staffOverride?: boolean;
  forceStatus?: "pending" | "confirmed";
  nowMs: number;
  ip?: string | null;
}

export async function createAppointment(p: CreateParams) {
  const { db, unit } = p;
  const orgId = unit.organization_id;
  const r = await resolveBooking(db, orgId, unit.id, p.professionalId, p.serviceIds);
  await assertBookable(db, unit, orgId, p.professionalId, p.startsAtMs, r, p.nowMs, {
    staffOverride: p.staffOverride === true,
  });

  const id = newId();
  const now = isoNow(new Date(p.nowMs));
  const startsAt = toIso(p.startsAtMs);
  const endsAt = toIso(p.startsAtMs + r.durationMin * 60_000);
  const status = p.forceStatus ?? (p.source === "admin" || unit.auto_confirm === 1 ? "confirmed" : "pending");
  const staff = await staffToNotify(db, orgId, unit.id, p.professionalId);

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO appointments (id, organization_id, unit_id, professional_id, customer_id, starts_at, ends_at, status, source,
           total_cents, duration_min, notes, cancel_token_hash, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, orgId, unit.id, p.professionalId, p.customerId, startsAt, endsAt, status, p.source,
        r.totalCents, r.durationMin, p.notes ?? null, p.cancelTokenHash ?? null, p.actorUserId, now, now,
      ),
    ...r.services.map((s) =>
      db
        .prepare(
          `INSERT INTO appointment_items (id, organization_id, appointment_id, service_id, name, price_cents, duration_min)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId(), orgId, id, s.id, s.name, s.price_cents, s.duration_min),
    ),
    ...slotInsertStmts(db, orgId, p.professionalId, id, p.startsAtMs, r.occupiedMin),
    db
      .prepare(
        `INSERT INTO appointment_history (id, organization_id, appointment_id, action, actor_user_id, actor_kind, details, created_at)
         VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`,
      )
      .bind(newId(), orgId, id, p.actorUserId, p.actorKind, JSON.stringify({ source: p.source, status }), now),
    auditStmt(db, {
      orgId, actorUserId: p.actorUserId, action: "appointment.created", entity: "appointment", entityId: id,
      details: { source: p.source }, ip: p.ip, now,
    }),
    ...staff
      .filter((u) => u !== p.actorUserId)
      .map((u) =>
        notifyStmt(db, {
          userId: u, orgId, kind: "appointment.created", title: "Novo agendamento",
          body: `${startsAt} (${p.source === "public" ? "página pública" : p.source === "portal" ? "app do cliente" : "painel"})`, now,
        }),
      ),
  ];

  try {
    await db.batch(stmts);
  } catch (e) {
    mapConflict(e);
  }
  return { id, startsAt, endsAt, status, totalCents: r.totalCents, durationMin: r.durationMin };
}

export async function getAppointment(db: D1Database, orgId: string, id: string): Promise<AppointmentRow> {
  const row = await db
    .prepare("SELECT * FROM appointments WHERE organization_id = ? AND id = ?")
    .bind(orgId, id)
    .first<AppointmentRow>();
  if (!row) throw notFound();
  return row;
}

export async function cancelAppointment(p: {
  db: D1Database;
  appt: AppointmentRow;
  by: "customer" | "staff";
  actorUserId: string | null;
  reason?: string | null;
  nowMs: number;
  windowMin?: number; // só para cancelamento do cliente
  ip?: string | null;
}): Promise<void> {
  const { db, appt } = p;
  if (appt.status !== "pending" && appt.status !== "confirmed") {
    throw new HttpError(409, "not_cancellable", "Este agendamento não pode mais ser cancelado");
  }
  if (p.by === "customer" && p.windowMin != null) {
    const limit = Date.parse(appt.starts_at) - p.windowMin * 60_000;
    if (p.nowMs > limit) {
      throw new HttpError(409, "cancel_window_passed", "Prazo de cancelamento encerrado. Fale com a barbearia.");
    }
  }
  const now = isoNow(new Date(p.nowMs));
  const staff = await staffToNotify(db, appt.organization_id, appt.unit_id, appt.professional_id);
  await db.batch([
    db
      .prepare(
        `UPDATE appointments SET status = 'cancelled', cancelled_by = ?, cancelled_by_user_id = ?, cancel_reason = ?, cancelled_at = ?, updated_at = ?
          WHERE organization_id = ? AND id = ? AND status IN ('pending','confirmed')`,
      )
      .bind(p.by, p.actorUserId, p.reason ?? null, now, now, appt.organization_id, appt.id),
    db.prepare("DELETE FROM appointment_slots WHERE organization_id = ? AND appointment_id = ?").bind(appt.organization_id, appt.id),
    db
      .prepare(
        `INSERT INTO appointment_history (id, organization_id, appointment_id, action, actor_user_id, actor_kind, details, created_at)
         VALUES (?, ?, ?, 'cancelled', ?, ?, ?, ?)`,
      )
      .bind(newId(), appt.organization_id, appt.id, p.actorUserId, p.by === "staff" ? "staff" : "customer", JSON.stringify({ reason: p.reason ?? null }), now),
    auditStmt(db, {
      orgId: appt.organization_id, actorUserId: p.actorUserId, action: "appointment.cancelled", entity: "appointment",
      entityId: appt.id, details: { by: p.by, reason: p.reason ?? null }, ip: p.ip, now,
    }),
    ...(p.by === "customer"
      ? staff.map((u) =>
          notifyStmt(db, { userId: u, orgId: appt.organization_id, kind: "appointment.cancelled", title: "Agendamento cancelado pelo cliente", body: appt.starts_at, now }),
        )
      : []),
  ]);
}

export async function rescheduleAppointment(p: {
  db: D1Database;
  unit: UnitRow;
  appt: AppointmentRow;
  newStartMs: number;
  newProfessionalId?: string;
  by: "customer" | "staff";
  actorUserId: string | null;
  staffOverride: boolean;
  nowMs: number;
  windowMin?: number;
  ip?: string | null;
}) {
  const { db, unit, appt } = p;
  if (appt.status !== "pending" && appt.status !== "confirmed") {
    throw new HttpError(409, "not_reschedulable", "Este agendamento não pode ser remarcado");
  }
  if (p.by === "customer" && p.windowMin != null && p.nowMs > Date.parse(appt.starts_at) - p.windowMin * 60_000) {
    throw new HttpError(409, "reschedule_window_passed", "Prazo de remarcação encerrado. Fale com a barbearia.");
  }
  const orgId = appt.organization_id;
  const professionalId = p.newProfessionalId ?? appt.professional_id;

  const { results: items } = await db
    .prepare("SELECT service_id FROM appointment_items WHERE organization_id = ? AND appointment_id = ?")
    .bind(orgId, appt.id)
    .all<{ service_id: string }>();
  const r = await resolveBooking(db, orgId, unit.id, professionalId, items.map((i) => i.service_id));
  // Preço e duração originais da reserva são preservados; só o encaixe de tempo é revalidado.
  const occupied = Math.max(r.occupiedMin, appt.duration_min);
  const r2 = { ...r, occupiedMin: occupied };
  await assertBookable(db, unit, orgId, professionalId, p.newStartMs, r2, p.nowMs, {
    staffOverride: p.staffOverride,
    excludeAppointmentId: appt.id,
  });

  const now = isoNow(new Date(p.nowMs));
  const startsAt = toIso(p.newStartMs);
  const endsAt = toIso(p.newStartMs + appt.duration_min * 60_000);
  try {
    await db.batch([
      db.prepare("DELETE FROM appointment_slots WHERE organization_id = ? AND appointment_id = ?").bind(orgId, appt.id),
      ...slotInsertStmts(db, orgId, professionalId, appt.id, p.newStartMs, occupied),
      db
        .prepare("UPDATE appointments SET starts_at = ?, ends_at = ?, professional_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
        .bind(startsAt, endsAt, professionalId, now, orgId, appt.id),
      db
        .prepare(
          `INSERT INTO appointment_history (id, organization_id, appointment_id, action, actor_user_id, actor_kind, details, created_at)
           VALUES (?, ?, ?, 'rescheduled', ?, ?, ?, ?)`,
        )
        .bind(newId(), orgId, appt.id, p.actorUserId, p.by === "staff" ? "staff" : "customer", JSON.stringify({ from: appt.starts_at, to: startsAt }), now),
      auditStmt(db, {
        orgId, actorUserId: p.actorUserId, action: "appointment.rescheduled", entity: "appointment", entityId: appt.id,
        details: { from: appt.starts_at, to: startsAt }, ip: p.ip, now,
      }),
    ]);
  } catch (e) {
    mapConflict(e);
  }
  return { id: appt.id, startsAt, endsAt };
}

const TRANSITIONS: Record<string, string[]> = {
  confirm: ["pending"],
  complete: ["confirmed"],
  no_show: ["confirmed"],
};

export async function transitionAppointment(p: {
  db: D1Database;
  appt: AppointmentRow;
  action: "confirm" | "complete" | "no_show";
  actorUserId: string;
  nowMs: number;
  ip?: string | null;
}): Promise<string> {
  const { db, appt } = p;
  if (!TRANSITIONS[p.action]?.includes(appt.status)) {
    throw new HttpError(409, "invalid_transition", `Não é possível ${p.action} um agendamento ${appt.status}`);
  }
  if ((p.action === "complete" || p.action === "no_show") && Date.parse(appt.starts_at) > p.nowMs) {
    throw new HttpError(409, "too_early", "O horário do agendamento ainda não chegou");
  }
  const next = p.action === "confirm" ? "confirmed" : p.action === "complete" ? "completed" : "no_show";
  const now = isoNow(new Date(p.nowMs));
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = ?")
      .bind(next, now, appt.organization_id, appt.id, appt.status),
    db
      .prepare(
        `INSERT INTO appointment_history (id, organization_id, appointment_id, action, actor_user_id, actor_kind, details, created_at)
         VALUES (?, ?, ?, ?, ?, 'staff', NULL, ?)`,
      )
      .bind(newId(), appt.organization_id, appt.id, next, p.actorUserId, now),
    auditStmt(db, {
      orgId: appt.organization_id, actorUserId: p.actorUserId, action: `appointment.${next}`, entity: "appointment",
      entityId: appt.id, ip: p.ip, now,
    }),
  ];
  if (next === "completed") {
    // Comissão congelada (regra por serviço > regra padrão > 0), arredondada para baixo por item.
    // Só insere se a transição acima valeu (status = 'completed'); UNIQUE(org, appointment) garante idempotência.
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO commission_entries (id, organization_id, unit_id, appointment_id, professional_id, base_cents, commission_cents, created_at)
           SELECT ?, a.organization_id, a.unit_id, a.id, a.professional_id,
                  COALESCE(SUM(i.price_cents), 0),
                  COALESCE(SUM((i.price_cents * COALESCE(rs.rate_bp, rd.rate_bp, 0)) / 10000), 0), ?
             FROM appointments a
             LEFT JOIN appointment_items i ON i.organization_id = a.organization_id AND i.appointment_id = a.id
             LEFT JOIN commission_rules rs ON rs.organization_id = a.organization_id AND rs.professional_id = a.professional_id AND rs.service_id = i.service_id
             LEFT JOIN commission_rules rd ON rd.organization_id = a.organization_id AND rd.professional_id = a.professional_id AND rd.service_id IS NULL
            WHERE a.organization_id = ? AND a.id = ? AND a.status = 'completed'
            GROUP BY a.id`,
        )
        .bind(newId(), now, appt.organization_id, appt.id),
      // Fidelidade: pontos = reais inteiros do total × pontos/real da organização (0 = desligado).
      db
        .prepare(
          `INSERT OR IGNORE INTO loyalty_ledger (id, organization_id, customer_id, appointment_id, kind, points, note, created_at)
           SELECT ?, a.organization_id, a.customer_id, a.id, 'earn', (a.total_cents / 100) * o.loyalty_points_per_real, 'Atendimento concluído', ?
             FROM appointments a JOIN organizations o ON o.id = a.organization_id
            WHERE a.organization_id = ? AND a.id = ? AND a.status = 'completed'
              AND o.loyalty_points_per_real > 0 AND (a.total_cents / 100) * o.loyalty_points_per_real > 0`,
        )
        .bind(newId(), now, appt.organization_id, appt.id),
    );
  }
  if (next === "no_show") {
    stmts.push(
      db
        .prepare("UPDATE customers SET no_show_count = no_show_count + 1, updated_at = ? WHERE organization_id = ? AND id = ?")
        .bind(now, appt.organization_id, appt.customer_id),
    );
  }
  await db.batch(stmts);
  return next;
}
