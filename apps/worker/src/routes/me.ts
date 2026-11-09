import { Hono } from "hono";
import { z } from "zod";
import { normalizeEmail, normalizePhone, ROLE_PERMISSIONS, type Role } from "@naregua/shared";
import { requireAuth, type AppEnv } from "../auth/middleware";
import { cancelAppointment, createAppointment, getAppointment, rescheduleAppointment, type UnitRow } from "../domain/booking";
import { audit } from "../lib/audit";
import { HttpError, notFound, parseBody } from "../lib/http";
import { isoNow, newId } from "../lib/util";
import { loadPublicUnit } from "./public";

export const meRoutes = new Hono<AppEnv>();
meRoutes.use("*", requireAuth);

/**
 * Convites pendentes viram vínculos ativos e registros de cliente com o MESMO e-mail
 * VERIFICADO pelo provedor de login são ligados à conta. Telefone digitado nunca vincula.
 */
async function claimByVerifiedEmail(db: D1Database, userId: string, emailNorm: string, now: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE memberships SET user_id = ?, status = 'active', updated_at = ?
          WHERE user_id IS NULL AND invited_email = ? AND status = 'invited'
            AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.organization_id = memberships.organization_id
                              AND m2.user_id = ? AND IFNULL(m2.unit_id,'') = IFNULL(memberships.unit_id,''))`,
      )
      .bind(userId, now, emailNorm, userId),
    db
      .prepare(
        `INSERT OR IGNORE INTO customer_accounts (id, user_id, organization_id, customer_id, method, verified_at, created_at)
         SELECT lower(hex(randomblob(16))), ?, c.organization_id, c.id, 'verified_email', ?, ?
           FROM customers c WHERE c.email_norm = ? AND c.status = 'active'`,
      )
      .bind(userId, now, now, emailNorm),
  ]);
}

meRoutes.get("/", async (c) => {
  const user = c.get("user");
  const now = isoNow(c.get("deps").now());
  if (user.email_verified === 1 && user.email_norm) {
    await claimByVerifiedEmail(c.env.DB, user.id, user.email_norm, now);
  }
  const { results: ms } = await c.env.DB.prepare(
    `SELECT m.id, m.organization_id, o.name AS organization_name, m.unit_id, u.name AS unit_name, u.slug AS unit_slug,
            m.role, m.can_receive_payments
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
       LEFT JOIN units u ON u.organization_id = m.organization_id AND u.id = m.unit_id
      WHERE m.user_id = ? AND m.status = 'active'
      ORDER BY o.name`,
  )
    .bind(user.id)
    .all<{ id: string; organization_id: string; organization_name: string; unit_id: string | null; unit_name: string | null; unit_slug: string | null; role: Role; can_receive_payments: number }>();
  const links = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM customer_accounts WHERE user_id = ?").bind(user.id).first<{ n: number }>();

  c.header("Cache-Control", "no-store");
  return c.json({
    user: { id: user.id, email: user.email, emailVerified: user.email_verified === 1, name: user.display_name },
    memberships: ms.map((m) => ({
      id: m.id, organizationId: m.organization_id, organizationName: m.organization_name, unitId: m.unit_id,
      unitName: m.unit_name, unitSlug: m.unit_slug, role: m.role,
      permissions: [...ROLE_PERMISSIONS[m.role], ...(m.can_receive_payments ? ["payment.create"] : [])],
    })),
    customerLinks: links?.n ?? 0,
  });
});

meRoutes.post("/sessions/revoke", async (c) => {
  const user = c.get("user");
  const nowSec = Math.floor(c.get("deps").now().getTime() / 1000) + 1;
  await c.env.DB.prepare("UPDATE users SET sessions_valid_after = ?, updated_at = ? WHERE id = ?")
    .bind(nowSec, isoNow(c.get("deps").now()), user.id)
    .run();
  await audit(c.env.DB, { orgId: null, actorUserId: user.id, action: "session.revoked_all", entity: "user", entityId: user.id, now: isoNow(c.get("deps").now()) });
  return c.json({ ok: true });
});

// ---------- Notificações (central interna) ----------
meRoutes.get("/notifications", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
  )
    .bind(user.id)
    .all();
  const unread = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
    .bind(user.id)
    .first<{ n: number }>();
  c.header("Cache-Control", "no-store");
  return c.json({ notifications: results, unread: unread?.n ?? 0 });
});

meRoutes.post("/notifications/read-all", async (c) => {
  await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .bind(isoNow(c.get("deps").now()), c.get("user").id)
    .run();
  return c.json({ ok: true });
});

meRoutes.post("/notifications/:id/read", async (c) => {
  const r = await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
    .bind(isoNow(c.get("deps").now()), c.req.param("id"), c.get("user").id)
    .run();
  if (!r.meta.changes) {
    const exists = await c.env.DB.prepare("SELECT 1 AS x FROM notifications WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).first();
    if (!exists) throw notFound();
  }
  return c.json({ ok: true });
});

// ---------- Portal do cliente ----------
meRoutes.get("/appointments", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.organization_id, a.starts_at, a.ends_at, a.status, a.total_cents,
            o.name AS organization_name, u.name AS unit_name, u.slug AS unit_slug, u.cancel_window_min,
            p.name AS professional_name,
            (SELECT group_concat(i.name, ', ') FROM appointment_items i WHERE i.organization_id = a.organization_id AND i.appointment_id = a.id) AS services
       FROM customer_accounts ca
       JOIN appointments a ON a.organization_id = ca.organization_id AND a.customer_id = ca.customer_id
       JOIN organizations o ON o.id = a.organization_id
       JOIN units u ON u.organization_id = a.organization_id AND u.id = a.unit_id
       JOIN professionals p ON p.organization_id = a.organization_id AND p.id = a.professional_id
      WHERE ca.user_id = ?
      ORDER BY a.starts_at DESC LIMIT 100`,
  )
    .bind(user.id)
    .all();
  c.header("Cache-Control", "no-store");
  return c.json({ appointments: results });
});

async function ownAppointment(c: { env: { DB: D1Database } }, userId: string, id: string) {
  const link = await c.env.DB.prepare(
    `SELECT a.organization_id FROM customer_accounts ca
       JOIN appointments a ON a.organization_id = ca.organization_id AND a.customer_id = ca.customer_id
      WHERE ca.user_id = ? AND a.id = ?`,
  )
    .bind(userId, id)
    .first<{ organization_id: string }>();
  if (!link) throw notFound();
  const appt = await getAppointment(c.env.DB, link.organization_id, id);
  const unit = await c.env.DB.prepare("SELECT * FROM units WHERE organization_id = ? AND id = ?")
    .bind(appt.organization_id, appt.unit_id)
    .first<UnitRow>();
  if (!unit) throw notFound();
  return { appt, unit };
}

meRoutes.post("/appointments/:id/cancel", async (c) => {
  const { reason } = await parseBody(c, z.object({ reason: z.string().max(300).optional() }).strict());
  const { appt, unit } = await ownAppointment(c, c.get("user").id, c.req.param("id"));
  await cancelAppointment({
    db: c.env.DB, appt, by: "customer", actorUserId: c.get("user").id, reason, nowMs: c.get("deps").now().getTime(),
    windowMin: unit.cancel_window_min,
  });
  return c.json({ ok: true });
});

meRoutes.post("/appointments/:id/reschedule", async (c) => {
  const { startsAt } = await parseBody(c, z.object({ startsAt: z.string().max(40) }).strict());
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) throw new HttpError(400, "validation_error", "Horário inválido");
  const { appt, unit } = await ownAppointment(c, c.get("user").id, c.req.param("id"));
  const r = await rescheduleAppointment({
    db: c.env.DB, unit, appt, newStartMs: ms, by: "customer", actorUserId: c.get("user").id, staffOverride: false,
    nowMs: c.get("deps").now().getTime(), windowMin: unit.cancel_window_min,
  });
  return c.json({ appointment: r });
});

const portalBook = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().min(8).max(25).optional(),
    professionalId: z.string().min(10).max(64),
    serviceIds: z.array(z.string().min(10).max(64)).min(1).max(5),
    startsAt: z.string().max(40),
  })
  .strict();

/** Agendamento do cliente logado: exige e-mail verificado; vincula cliente↔conta pelo login, não por telefone. */
meRoutes.post("/units/:slug/appointments", async (c) => {
  const user = c.get("user");
  if (user.email_verified !== 1 || !user.email_norm) {
    throw new HttpError(403, "email_not_verified", "Confirme seu e-mail para agendar pelo app");
  }
  const body = await parseBody(c, portalBook);
  const ms = Date.parse(body.startsAt);
  if (Number.isNaN(ms)) throw new HttpError(400, "validation_error", "Horário inválido");
  const unit = await loadPublicUnit(c.env.DB, c.req.param("slug"));
  const orgId = unit.organization_id;
  const nowMs = c.get("deps").now().getTime();
  const now = isoNow(new Date(nowMs));

  let customerId = (
    await c.env.DB.prepare(
      `SELECT c.id FROM customers c JOIN customer_accounts ca ON ca.organization_id = c.organization_id AND ca.customer_id = c.id
        WHERE c.organization_id = ? AND ca.user_id = ? AND c.status = 'active' ORDER BY c.created_at LIMIT 1`,
    )
      .bind(orgId, user.id)
      .first<{ id: string }>()
  )?.id;

  if (!customerId) {
    const byEmail = await c.env.DB.prepare(
      "SELECT id FROM customers WHERE organization_id = ? AND email_norm = ? AND status = 'active' ORDER BY created_at LIMIT 1",
    )
      .bind(orgId, normalizeEmail(user.email))
      .first<{ id: string }>();
    customerId = byEmail?.id;
  }
  if (!customerId) {
    if (!body.phone) throw new HttpError(400, "validation_error", "Informe seu telefone no primeiro agendamento");
    // Cliente novo criado a partir do login: não reaproveita registro de telefone alheio (evita sequestro de histórico).
    customerId = newId();
    const phoneNorm = normalizePhone(body.phone);
    if (!phoneNorm) throw new HttpError(400, "validation_error", "Telefone inválido (informe DDD + número)");
    await c.env.DB.prepare(
      `INSERT INTO customers (id, organization_id, name, phone, phone_norm, email, email_norm, status, no_show_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    )
      .bind(customerId, orgId, body.name ?? user.display_name ?? "Cliente", body.phone, phoneNorm, user.email, user.email_norm, now, now)
      .run();
  }
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO customer_accounts (id, user_id, organization_id, customer_id, method, verified_at, created_at)
     VALUES (?, ?, ?, ?, 'authenticated_booking', ?, ?)`,
  )
    .bind(newId(), user.id, orgId, customerId, now, now)
    .run();

  const appt = await createAppointment({
    db: c.env.DB, unit, professionalId: body.professionalId, customerId, serviceIds: body.serviceIds, startsAtMs: ms,
    source: "portal", actorUserId: user.id, actorKind: "customer", nowMs,
  });
  return c.json({ appointment: appt }, 201);
});

