import { Hono } from "hono";
import { z } from "zod";
import { normalizeEmail, normalizePhone } from "@naregua/shared";
import type { AppEnv } from "../auth/middleware";
import { computeSlotStarts, loadDayContext } from "../domain/availability";
import { cancelAppointment, createAppointment, resolveBooking, type AppointmentRow, type UnitRow } from "../domain/booking";
import { consentStmts, findOrCreateCustomer } from "../domain/customers";
import { HttpError, notFound, parseBody, parseQuery, rateLimit } from "../lib/http";
import { isValidDateStr } from "../lib/time";
import { randomToken, safeEqual, sha256Hex, toIso } from "../lib/util";

export const publicRoutes = new Hono<AppEnv>();

const SLUG = z.string().min(3).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export async function loadPublicUnit(db: D1Database, slug: string): Promise<UnitRow> {
  const unit = await db
    .prepare(
      `SELECT u.* FROM units u JOIN organizations o ON o.id = u.organization_id
        WHERE u.slug = ? AND u.status = 'active' AND o.status = 'active'`,
    )
    .bind(slug)
    .first<UnitRow>();
  if (!unit) throw notFound();
  return unit;
}

function ipOf(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

// Página pública da unidade: somente dados que a barbearia quer divulgar.
publicRoutes.get("/units/:slug", async (c) => {
  const slug = SLUG.safeParse(c.req.param("slug"));
  if (!slug.success) throw notFound();
  const unit = await loadPublicUnit(c.env.DB, slug.data);

  const { results } = await c.env.DB.prepare(
    `SELECT p.id AS professional_id, p.name AS professional_name, p.bio,
            s.id AS service_id, s.name AS service_name, s.description, s.category,
            COALESCE(ps.price_cents, s.price_cents) AS price_cents,
            COALESCE(ps.duration_min, s.duration_min) AS duration_min
       FROM professionals p
       JOIN professional_units pu ON pu.professional_id = p.id AND pu.organization_id = p.organization_id AND pu.unit_id = ?
       JOIN professional_services ps ON ps.professional_id = p.id AND ps.organization_id = p.organization_id
       JOIN services s ON s.id = ps.service_id AND s.organization_id = p.organization_id AND s.status = 'active'
      WHERE p.organization_id = ? AND p.status = 'active'
      ORDER BY p.name, s.name`,
  )
    .bind(unit.id, unit.organization_id)
    .all<{
      professional_id: string; professional_name: string; bio: string | null; service_id: string; service_name: string;
      description: string | null; category: string | null; price_cents: number; duration_min: number;
    }>();

  const pros = new Map<string, { id: string; name: string; bio: string | null; services: object[] }>();
  for (const r of results) {
    let p = pros.get(r.professional_id);
    if (!p) {
      p = { id: r.professional_id, name: r.professional_name, bio: r.bio, services: [] };
      pros.set(r.professional_id, p);
    }
    p.services.push({
      id: r.service_id, name: r.service_name, description: r.description, category: r.category,
      priceCents: r.price_cents, durationMin: r.duration_min,
    });
  }
  const org = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(unit.organization_id).first<{ name: string }>();

  return c.json({
    unit: {
      slug: unit.slug, name: unit.name, organizationName: org?.name ?? unit.name,
      address: unit.address,
      phone: unit.phone,
      timezone: unit.timezone, cancelWindowMin: unit.cancel_window_min, maxDaysAhead: unit.max_days_ahead,
    },
    professionals: [...pros.values()],
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
  });
});

const availabilityQuery = z.object({
  professionalId: z.string().min(10).max(64),
  serviceIds: z.string().min(1).max(400),
  date: z.string().refine(isValidDateStr, "data inválida"),
});

publicRoutes.get("/units/:slug/availability", async (c) => {
  rateLimit(`avail:${ipOf(c)}`, 90, 60_000, c.get("deps").now().getTime());
  const slug = SLUG.safeParse(c.req.param("slug"));
  if (!slug.success) throw notFound();
  const q = parseQuery(c, availabilityQuery);
  const unit = await loadPublicUnit(c.env.DB, slug.data);
  const r = await resolveBooking(c.env.DB, unit.organization_id, unit.id, q.professionalId, q.serviceIds.split(",").map((s) => s.trim()));
  const ctx = await loadDayContext(c.env.DB, unit.organization_id, unit.id, unit.timezone, q.professionalId, q.date);
  const starts = computeSlotStarts({ unit, date: q.date, occupiedMin: r.occupiedMin, ctx, nowMs: c.get("deps").now().getTime() });
  return c.json({ date: q.date, timezone: unit.timezone, durationMin: r.durationMin, totalCents: r.totalCents, slots: starts.map(toIso) });
});

const bookBody = z
  .object({
    turnstileToken: z.string().max(4096).optional(),
    website: z.string().max(200).optional(), // honeypot: deve vir vazio
    customer: z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().min(8).max(25),
      email: z.string().max(254).optional().or(z.literal("")),
    }),
    professionalId: z.string().min(10).max(64),
    serviceIds: z.array(z.string().min(10).max(64)).min(1).max(5),
    startsAt: z.string().max(40),
    marketingConsent: z.boolean().optional(),
  })
  .strict();

publicRoutes.post("/units/:slug/appointments", async (c) => {
  const deps = c.get("deps");
  const nowMs = deps.now().getTime();
  const ip = ipOf(c);
  rateLimit(`book:${ip}`, 10, 10 * 60_000, nowMs);

  const slug = SLUG.safeParse(c.req.param("slug"));
  if (!slug.success) throw notFound();
  const body = await parseBody(c, bookBody);
  if (body.website) throw new HttpError(400, "validation_error", "Requisição inválida");
  if (!(await deps.verifyTurnstile(body.turnstileToken, c.req.header("cf-connecting-ip") ?? null, c.env))) {
    throw new HttpError(403, "turnstile_failed", "Não foi possível verificar que você é humano. Tente novamente.");
  }
  const startMs = Date.parse(body.startsAt);
  if (Number.isNaN(startMs)) throw new HttpError(400, "validation_error", "Horário inválido");
  const emailNorm = body.customer.email ? normalizeEmail(body.customer.email) : null;
  if (body.customer.email && !emailNorm) throw new HttpError(400, "validation_error", "E-mail inválido");
  const phoneNorm = normalizePhone(body.customer.phone);
  if (!phoneNorm) throw new HttpError(400, "validation_error", "Telefone inválido (informe DDD + número)");

  const unit = await loadPublicUnit(c.env.DB, slug.data);
  const orgId = unit.organization_id;

  // Limites por telefone dentro da organização (anti-spam e anti-sabotagem de agenda).
  const lim = await c.env.DB.prepare(
    `SELECT
        SUM(CASE WHEN a.status IN ('pending','confirmed') AND a.starts_at > ? THEN 1 ELSE 0 END) AS upcoming,
        SUM(CASE WHEN a.source = 'public' AND a.created_at > ? THEN 1 ELSE 0 END) AS recent
       FROM appointments a JOIN customers cu ON cu.organization_id = a.organization_id AND cu.id = a.customer_id
      WHERE a.organization_id = ? AND cu.phone_norm = ?`,
  )
    .bind(toIso(nowMs), toIso(nowMs - 24 * 3600_000), orgId, phoneNorm)
    .first<{ upcoming: number | null; recent: number | null }>();
  if ((lim?.upcoming ?? 0) >= 3 || (lim?.recent ?? 0) >= 5) {
    throw new HttpError(429, "booking_limit", "Limite de agendamentos para este telefone. Fale com a barbearia.");
  }

  const nowIso = toIso(nowMs);
  const customer = await findOrCreateCustomer(c.env.DB, orgId, { name: body.customer.name, phone: body.customer.phone, email: emailNorm }, nowIso);
  if (body.marketingConsent) {
    await c.env.DB.batch(consentStmts(c.env.DB, orgId, customer.id, { email: !!emailNorm, whatsapp: true }, true, "public_booking", nowIso));
  }

  const token = randomToken(24);
  const appt = await createAppointment({
    db: c.env.DB, unit, professionalId: body.professionalId, customerId: customer.id, serviceIds: body.serviceIds,
    startsAtMs: startMs, source: "public", actorUserId: null, actorKind: "customer",
    cancelTokenHash: await sha256Hex(token), nowMs, ip,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ appointment: appt, cancelToken: token, cancelWindowMin: unit.cancel_window_min }, 201);
});

const tokenBody = z.object({ token: z.string().min(16).max(200), reason: z.string().max(300).optional() }).strict();

async function loadByToken(c: { env: { DB: D1Database } }, id: string, token: string): Promise<AppointmentRow> {
  // tenant-ok: autorização por token secreto do próprio agendamento (hash comparado em tempo constante)
  const appt = await c.env.DB.prepare("SELECT * FROM appointments WHERE id = ? AND cancel_token_hash IS NOT NULL") // tenant-ok: autorização pelo token secreto do próprio agendamento
    .bind(id)
    .first<AppointmentRow>();
  if (!appt || !appt.cancel_token_hash || !safeEqual(await sha256Hex(token), appt.cancel_token_hash)) throw notFound();
  return appt;
}

publicRoutes.post("/appointments/:id/view", async (c) => {
  rateLimit(`view:${ipOf(c)}`, 30, 60_000, c.get("deps").now().getTime());
  const { token } = await parseBody(c, z.object({ token: z.string().min(16).max(200) }).strict());
  const appt = await loadByToken(c, c.req.param("id"), token);
  const unit = await c.env.DB.prepare("SELECT name, slug, cancel_window_min FROM units WHERE organization_id = ? AND id = ?")
    .bind(appt.organization_id, appt.unit_id)
    .first<{ name: string; slug: string; cancel_window_min: number }>();
  const { results: items } = await c.env.DB.prepare("SELECT name, price_cents FROM appointment_items WHERE organization_id = ? AND appointment_id = ?")
    .bind(appt.organization_id, appt.id)
    .all();
  c.header("Cache-Control", "no-store");
  return c.json({
    appointment: { id: appt.id, startsAt: appt.starts_at, endsAt: appt.ends_at, status: appt.status, totalCents: appt.total_cents },
    unit, items,
  });
});

publicRoutes.post("/appointments/:id/cancel", async (c) => {
  const deps = c.get("deps");
  rateLimit(`cancel:${ipOf(c)}`, 20, 60_000, deps.now().getTime());
  const body = await parseBody(c, tokenBody);
  const appt = await loadByToken(c, c.req.param("id"), body.token);
  const unit = await c.env.DB.prepare("SELECT cancel_window_min FROM units WHERE organization_id = ? AND id = ?")
    .bind(appt.organization_id, appt.unit_id)
    .first<{ cancel_window_min: number }>();
  await cancelAppointment({
    db: c.env.DB, appt, by: "customer", actorUserId: null, reason: body.reason, nowMs: deps.now().getTime(),
    windowMin: unit?.cancel_window_min ?? 120, ip: ipOf(c),
  });
  return c.json({ ok: true });
});
