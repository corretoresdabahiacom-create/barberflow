import { Hono } from "hono";
import { z } from "zod";
import { normalizeEmail } from "@naregua/shared";
import { createMiddleware } from "hono/factory";
import { requireAuth, type AppEnv } from "../auth/middleware";
import { auditStmt } from "../lib/audit";
import { HttpError, notFound, parseBody, parseQuery } from "../lib/http";
import { isoNow } from "../lib/util";

/** Administração da plataforma (você, operador do SaaS): planos e assinaturas. Lista de e-mails por variável de ambiente. */
export const platformRoutes = new Hono<AppEnv>();
platformRoutes.use("*", requireAuth);

export function isPlatformAdmin(env: { PLATFORM_ADMIN_EMAILS?: string }, user: { email_norm: string | null; email_verified: number }): boolean {
  if (user.email_verified !== 1 || !user.email_norm) return false;
  const list = String(env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((s) => normalizeEmail(s.trim())).filter(Boolean);
  return list.includes(user.email_norm);
}

// Quem não é administrador recebe 404 (não revela que a área existe).
platformRoutes.use("*", createMiddleware<AppEnv>(async (c, next) => {
  if (!isPlatformAdmin(c.env, c.get("user"))) throw notFound();
  await next();
}));

const planBody = z
  .object({
    name: z.string().trim().min(2).max(60),
    priceCents: z.number().int().min(0).max(100_000_00).nullable(),
    maxUnits: z.number().int().min(1).max(10_000).nullable(),
    maxProfessionals: z.number().int().min(1).max(100_000).nullable(),
    aiDailyQuota: z.number().int().min(0).max(1000),
    allowNetwork: z.boolean(),
    active: z.boolean(),
    sort: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

const PLAN_COLS = "id, name, price_cents, max_units, max_professionals, ai_daily_quota, allow_network, active, sort, updated_at";

platformRoutes.get("/plans", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT ${PLAN_COLS} FROM plans ORDER BY sort, id`).all();
  return c.json({ plans: results });
});

platformRoutes.post("/plans", async (c) => {
  const user = c.get("user");
  const b = await parseBody(c, planBody.extend({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,29}$/) }).strict());
  const now = isoNow(c.get("deps").now());
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO plans (id, name, price_cents, max_units, max_professionals, ai_daily_quota, allow_network, active, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(b.id, b.name, b.priceCents, b.maxUnits, b.maxProfessionals, b.aiDailyQuota, b.allowNetwork ? 1 : 0, b.active ? 1 : 0, b.sort, now),
      auditStmt(c.env.DB, { orgId: null, actorUserId: user.id, action: "plan.created", entity: "plan", entityId: b.id, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) throw new HttpError(409, "plan_exists", "Já existe um plano com este id");
    throw e;
  }
  return c.json({ id: b.id }, 201);
});

platformRoutes.put("/plans/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const b = await parseBody(c, planBody);
  if (id === "free" && !b.active) throw new HttpError(409, "free_required", "O plano gratuito (base) não pode ser desativado");
  const now = isoNow(c.get("deps").now());
  const r = await c.env.DB.prepare("UPDATE plans SET name = ?, price_cents = ?, max_units = ?, max_professionals = ?, ai_daily_quota = ?, allow_network = ?, active = ?, sort = ?, updated_at = ? WHERE id = ?")
    .bind(b.name, b.priceCents, b.maxUnits, b.maxProfessionals, b.aiDailyQuota, b.allowNetwork ? 1 : 0, b.active ? 1 : 0, b.sort, now, id).run();
  if ((r.meta.changes ?? 0) === 0) throw notFound();
  await auditStmt(c.env.DB, { orgId: null, actorUserId: user.id, action: "plan.updated", entity: "plan", entityId: id, details: { priceCents: b.priceCents, maxUnits: b.maxUnits, maxProfessionals: b.maxProfessionals }, now }).run();
  return c.json({ ok: true });
});

platformRoutes.get("/orgs", async (c) => {
  const q = parseQuery(c, z.object({ q: z.string().trim().max(60).optional() }));
  const like = `%${(q.q ?? "").replace(/[%_\\]/g, "")}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT o.id AS id, o.name AS name, o.status AS status, COALESCE(s.plan_id, 'free') AS plan_id, s.status AS subscription_status, s.valid_until AS valid_until
       FROM organizations o LEFT JOIN org_subscriptions s ON s.organization_id = o.id
      WHERE o.name LIKE ? ORDER BY o.created_at DESC LIMIT 50`,
  ).bind(like).all();
  return c.json({ organizations: results });
});

platformRoutes.put("/orgs/:orgId/subscription", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const b = await parseBody(
    c,
    z.object({ planId: z.string().min(2).max(30), status: z.enum(["active", "suspended"]), validUntil: z.string().max(40).nullable(), note: z.string().trim().max(300).nullable() }).strict(),
  );
  let validUntil: string | null = null;
  if (b.validUntil !== null) {
    const ms = Date.parse(b.validUntil);
    if (Number.isNaN(ms)) throw new HttpError(400, "validation_error", "validUntil inválido");
    validUntil = isoNow(new Date(ms));
  }
  const now = isoNow(c.get("deps").now());
  const org = await c.env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first(); // tenant-ok: organizations é a própria linha-alvo da administração da plataforma
  if (!org) throw notFound();
  const plan = await c.env.DB.prepare("SELECT id FROM plans WHERE id = ?").bind(b.planId).first();
  if (!plan) throw new HttpError(400, "unknown_plan", "Plano inexistente");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO org_subscriptions (organization_id, plan_id, status, valid_until, note, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status, valid_until = excluded.valid_until, note = excluded.note, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
    ).bind(orgId, b.planId, b.status, validUntil, b.note, user.id, now),
    auditStmt(c.env.DB, { orgId, actorUserId: user.id, action: "subscription.updated", entity: "subscription", entityId: orgId, details: { planId: b.planId, status: b.status, validUntil }, now }),
  ]);
  return c.json({ ok: true });
});
