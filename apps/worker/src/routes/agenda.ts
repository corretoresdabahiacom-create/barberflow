import { Hono } from "hono";
import { z } from "zod";
import { can, allowedUnits, type OrgContext } from "../auth/rbac";
import type { AppEnv, UserRow } from "../auth/middleware";
import {
  cancelAppointment, createAppointment, getAppointment, rescheduleAppointment, transitionAppointment,
  type AppointmentRow, type UnitRow,
} from "../domain/booking";
import { findOrCreateCustomer } from "../domain/customers";
import { HttpError, forbidden, notFound, parseBody, parseQuery } from "../lib/http";
import { requirePerm } from "../auth/rbac";
import { toIso } from "../lib/util";

export const agendaRoutes = new Hono<AppEnv>();

const id = z.string().min(10).max(64);

async function loadUnit(db: D1Database, orgId: string, unitId: string): Promise<UnitRow> {
  const u = await db.prepare("SELECT * FROM units WHERE organization_id = ? AND id = ?").bind(orgId, unitId).first<UnitRow>();
  if (!u) throw new HttpError(422, "unit_not_found", "Unidade inválida");
  return u;
}

async function proUserId(db: D1Database, orgId: string, professionalId: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT user_id FROM professionals WHERE organization_id = ? AND id = ?")
    .bind(orgId, professionalId)
    .first<{ user_id: string | null }>();
  return r?.user_id ?? null;
}

type Level = "read" | "write";

/** Acesso a um agendamento: permissão na unidade OU (escopo próprio) profissional vinculado ao usuário. */
async function canAccess(db: D1Database, org: OrgContext, user: UserRow, appt: AppointmentRow, level: Level): Promise<{ ok: boolean; full: boolean }> {
  const full = can(org, level === "read" ? "agenda.read" : "agenda.write", appt.unit_id);
  if (full) return { ok: true, full: true };
  const own = level === "read" ? can(org, "agenda.read_own", appt.unit_id) : can(org, "agenda.write_own", appt.unit_id);
  if (own && (await proUserId(db, org.id, appt.professional_id)) === user.id) return { ok: true, full: false };
  return { ok: false, full: false };
}

async function loadAuthorized(c: { env: { DB: D1Database }; get: (k: "org") => OrgContext; req: { param: (n: string) => string } }, user: UserRow, level: Level) {
  const org = c.get("org");
  const appt = await getAppointment(c.env.DB, org.id, c.req.param("id"));
  const acc = await canAccess(c.env.DB, org, user, appt, level);
  // Quem enxerga a organização mas não este agendamento recebe 404 (sem confirmar existência) em leitura, 403 em escrita.
  if (!acc.ok) throw level === "read" ? notFound() : forbidden();
  return { appt, full: acc.full };
}

const listQuery = z.object({
  from: z.string().max(40),
  to: z.string().max(40),
  unitId: id.optional(),
  professionalId: id.optional(),
  status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]).optional(),
});

agendaRoutes.get("/appointments", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const q = parseQuery(c, listQuery);
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new HttpError(400, "validation_error", "Período inválido");
  if (to - from > 62 * 86400_000) throw new HttpError(400, "validation_error", "Período máximo de 62 dias");

  const readUnits = allowedUnits(org, "agenda.read");
  const ownUnits = allowedUnits(org, "agenda.read_own");
  const where: string[] = ["a.organization_id = ?", "a.starts_at >= ?", "a.starts_at < ?"];
  const binds: (string | number)[] = [org.id, toIso(from), toIso(to)];

  const scope: string[] = [];
  if (readUnits === "all") scope.push("1=1");
  else if (readUnits.length) {
    scope.push(`a.unit_id IN (${readUnits.map(() => "?").join(",")})`);
    binds.push(...readUnits);
  }
  if (ownUnits === "all") {
    scope.push("p.user_id = ?");
    binds.push(user.id);
  } else if (ownUnits.length) {
    scope.push(`(p.user_id = ? AND a.unit_id IN (${ownUnits.map(() => "?").join(",")}))`);
    binds.push(user.id, ...ownUnits);
  }
  if (scope.length === 0) throw forbidden();
  where.push(`(${scope.join(" OR ")})`);

  if (q.unitId) { where.push("a.unit_id = ?"); binds.push(q.unitId); }
  if (q.professionalId) { where.push("a.professional_id = ?"); binds.push(q.professionalId); }
  if (q.status) { where.push("a.status = ?"); binds.push(q.status); }

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.unit_id, a.professional_id, p.name AS professional_name, a.customer_id, cu.name AS customer_name, cu.phone AS customer_phone,
            a.starts_at, a.ends_at, a.status, a.source, a.total_cents, a.duration_min, a.notes
       FROM appointments a
       JOIN professionals p ON p.organization_id = a.organization_id AND p.id = a.professional_id
       JOIN customers cu ON cu.organization_id = a.organization_id AND cu.id = a.customer_id
      WHERE ${where.join(" AND ")} ORDER BY a.starts_at LIMIT 500`,
  )
    .bind(...binds)
    .all();
  return c.json({ appointments: results });
});

const createBody = z
  .object({
    unitId: id,
    professionalId: id,
    serviceIds: z.array(id).min(1).max(5),
    startsAt: z.string().max(40),
    customerId: id.optional(),
    customer: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().min(8).max(25), email: z.string().max(254).optional() }).strict().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    override: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !!b.customerId !== !!b.customer, "informe customerId OU customer");

agendaRoutes.post("/appointments", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const deps = c.get("deps");
  const b = await parseBody(c, createBody);
  requirePerm(org, "agenda.write", b.unitId);
  const unit = await loadUnit(c.env.DB, org.id, b.unitId);
  const startMs = Date.parse(b.startsAt);
  if (Number.isNaN(startMs)) throw new HttpError(400, "validation_error", "Horário inválido");
  const nowMs = deps.now().getTime();

  let customerId: string;
  if (b.customerId) {
    requirePerm(org, "customer.read", b.unitId);
    const cu = await c.env.DB.prepare("SELECT id FROM customers WHERE organization_id = ? AND id = ? AND status = 'active'").bind(org.id, b.customerId).first();
    if (!cu) throw new HttpError(422, "customer_not_found", "Cliente não encontrado");
    customerId = b.customerId;
  } else {
    requirePerm(org, "customer.write", b.unitId);
    customerId = (await findOrCreateCustomer(c.env.DB, org.id, b.customer!, toIso(nowMs))).id;
  }

  const appt = await createAppointment({
    db: c.env.DB, unit, professionalId: b.professionalId, customerId, serviceIds: b.serviceIds, startsAtMs: startMs,
    source: "admin", actorUserId: user.id, actorKind: "staff", notes: b.notes ?? null, staffOverride: b.override === true,
    nowMs, ip: c.req.header("cf-connecting-ip") ?? null,
  });
  return c.json({ appointment: appt }, 201);
});

agendaRoutes.get("/appointments/:id", async (c) => {
  const { appt } = await loadAuthorized(c, c.get("user"), "read");
  const org = c.get("org");
  const [items, history, customer, pay] = await Promise.all([
    c.env.DB.prepare("SELECT name, price_cents, duration_min FROM appointment_items WHERE organization_id = ? AND appointment_id = ?").bind(org.id, appt.id).all(),
    c.env.DB.prepare("SELECT action, actor_kind, created_at FROM appointment_history WHERE organization_id = ? AND appointment_id = ? ORDER BY created_at").bind(org.id, appt.id).all(),
    c.env.DB.prepare("SELECT id, name, phone FROM customers WHERE organization_id = ? AND id = ?").bind(org.id, appt.customer_id).first(),
    c.env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS paid FROM payments WHERE organization_id = ? AND appointment_id = ?").bind(org.id, appt.id).first<{ paid: number }>(),
  ]);
  const { cancel_token_hash: _omit, ...safe } = appt;
  return c.json({ appointment: safe, items: items.results, history: history.results, customer, paidCents: pay?.paid ?? 0 });
});

for (const [path, action] of [["confirm", "confirm"], ["complete", "complete"], ["no-show", "no_show"]] as const) {
  agendaRoutes.post(`/appointments/:id/${path}`, async (c) => {
    const { appt } = await loadAuthorized(c, c.get("user"), "write");
    const status = await transitionAppointment({
      db: c.env.DB, appt, action, actorUserId: c.get("user").id, nowMs: c.get("deps").now().getTime(),
      ip: c.req.header("cf-connecting-ip") ?? null,
    });
    return c.json({ status });
  });
}

agendaRoutes.post("/appointments/:id/cancel", async (c) => {
  const { appt } = await loadAuthorized(c, c.get("user"), "write");
  const b = await parseBody(c, z.object({ reason: z.string().trim().max(300).optional() }).strict());
  await cancelAppointment({
    db: c.env.DB, appt, by: "staff", actorUserId: c.get("user").id, reason: b.reason, nowMs: c.get("deps").now().getTime(),
    ip: c.req.header("cf-connecting-ip") ?? null,
  });
  return c.json({ ok: true });
});

agendaRoutes.post("/appointments/:id/reschedule", async (c) => {
  const org = c.get("org");
  const { appt, full } = await loadAuthorized(c, c.get("user"), "write");
  const b = await parseBody(c, z.object({ startsAt: z.string().max(40), professionalId: id.optional(), override: z.boolean().optional() }).strict());
  const startMs = Date.parse(b.startsAt);
  if (Number.isNaN(startMs)) throw new HttpError(400, "validation_error", "Horário inválido");
  // Trocar de profissional ou forçar encaixe só para quem tem permissão completa na unidade.
  if ((b.professionalId && b.professionalId !== appt.professional_id) || b.override) {
    if (!full) throw forbidden();
  }
  const unit = await loadUnit(c.env.DB, org.id, appt.unit_id);
  const r = await rescheduleAppointment({
    db: c.env.DB, unit, appt, newStartMs: startMs, newProfessionalId: b.professionalId, by: "staff", actorUserId: c.get("user").id,
    staffOverride: b.override === true && full, nowMs: c.get("deps").now().getTime(), ip: c.req.header("cf-connecting-ip") ?? null,
  });
  return c.json({ appointment: r });
});
