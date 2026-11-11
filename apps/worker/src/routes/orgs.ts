import { Hono } from "hono";
import { z } from "zod";
import { normalizeEmail, ROLE_PERMISSIONS, ROLES, type Role } from "@naregua/shared";
import { requireAuth, requireOrg, type AppEnv } from "../auth/middleware";
import { allowedUnits, requirePerm } from "../auth/rbac";
import { audit, auditStmt } from "../lib/audit";
import { HttpError, notFound, parseBody } from "../lib/http";
import { isValidTimeZone } from "../lib/time";
import { isoNow, newId } from "../lib/util";
import { catalogRoutes } from "./catalog";
import { agendaRoutes } from "./agenda";
import { customerRoutes } from "./customers";
import { paymentRoutes } from "./payments";
import { reportRoutes } from "./reports";
import { financeRoutes } from "./finance";
import { stockRoutes } from "./stock";
import { loyaltyRoutes } from "./loyalty";
import { chatRoutes } from "./chat";
import { marketingRoutes } from "./marketing";

export const orgRoutes = new Hono<AppEnv>();
orgRoutes.use("*", requireAuth);

const RESERVED_SLUGS = new Set(["api", "app", "admin", "b", "c", "login", "cadastro", "termos", "privacidade", "assets", "static", "www", "naregua", "suporte", "ajuda"]);
const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use letras minúsculas, números e hífens")
  .refine((s) => !RESERVED_SLUGS.has(s), "slug reservado");

const MAX_OWNED_ORGS = 3;

const createOrgBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    unit: z
      .object({
        name: z.string().trim().min(2).max(120),
        slug: slugSchema,
        address: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(25).optional(),
      })
      .strict(),
  })
  .strict();

function isUnique(e: unknown, what: string): boolean {
  return e instanceof Error && e.message.includes(`UNIQUE constraint failed: ${what}`);
}

orgRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (user.email_verified !== 1) throw new HttpError(403, "email_not_verified", "Confirme seu e-mail para criar uma barbearia");
  const body = await parseBody(c, createOrgBody);
  const now = isoNow(c.get("deps").now());

  // tenant-ok: limite GLOBAL por usuário (conta quantas organizações ele possui), por definição entre organizações
  const owned = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner' AND status = 'active'") // tenant-ok: limite global por usuário
    .bind(user.id)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_OWNED_ORGS) {
    throw new HttpError(409, "org_limit", `Limite de ${MAX_OWNED_ORGS} organizações por conta`);
  }

  const orgId = newId();
  const unitId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO organizations (id, name, status, created_by, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
        .bind(orgId, body.name, user.id, now, now),
      c.env.DB.prepare("INSERT INTO units (id, organization_id, name, slug, address, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(unitId, orgId, body.unit.name, body.unit.slug, body.unit.address ?? null, body.unit.phone ?? null, now, now),
      c.env.DB.prepare("INSERT INTO memberships (id, organization_id, unit_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, NULL, ?, 'owner', 'active', ?, ?)")
        .bind(newId(), orgId, user.id, now, now),
      auditStmt(c.env.DB, { orgId, actorUserId: user.id, action: "org.created", entity: "organization", entityId: orgId, now }),
    ]);
  } catch (e) {
    if (isUnique(e, "units.slug")) throw new HttpError(409, "slug_taken", "Este endereço já está em uso. Escolha outro.");
    throw e;
  }
  return c.json({ organizationId: orgId, unitId }, 201);
});

// ---------- Escopo da organização: tudo abaixo exige VÍNCULO ativo ----------
const scoped = new Hono<AppEnv>();
scoped.use("*", requireOrg);

scoped.get("/", async (c) => {
  const org = c.get("org");
  const row = await c.env.DB.prepare("SELECT id, name, status FROM organizations WHERE id = ?").bind(org.id).first();
  const perms = new Set<string>();
  for (const m of org.memberships) {
    for (const p of ROLE_PERMISSIONS[m.role]) perms.add(p);
    if (m.can_receive_payments) perms.add("payment.create");
  }
  return c.json({ organization: row, permissions: [...perms] });
});

scoped.patch("/", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const { name } = await parseBody(c, z.object({ name: z.string().trim().min(2).max(120) }).strict());
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?").bind(name, now, org.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "org.updated", entity: "organization", entityId: org.id, now }),
  ]);
  return c.json({ ok: true });
});

// ----- Unidades -----
scoped.get("/units", async (c) => {
  const org = c.get("org");
  const unitsAllowed = new Set<string>();
  let all = false;
  for (const m of org.memberships) {
    if (m.unit_id === null) all = true;
    else unitsAllowed.add(m.unit_id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, slug, address, phone, timezone, status, auto_confirm, min_notice_min, max_days_ahead, slot_step_min, cancel_window_min, city, state, description, listed
       FROM units WHERE organization_id = ? ORDER BY name`,
  )
    .bind(org.id)
    .all<{ id: string }>();
  return c.json({ units: results.filter((u) => all || unitsAllowed.has(u.id)) });
});

scoped.post("/units", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const body = await parseBody(
    c,
    z.object({ name: z.string().trim().min(2).max(120), slug: slugSchema, address: z.string().trim().max(200).optional(), phone: z.string().trim().max(25).optional() }).strict(),
  );
  const now = isoNow(c.get("deps").now());
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO units (id, organization_id, name, slug, address, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, org.id, body.name, body.slug, body.address ?? null, body.phone ?? null, now, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "unit.created", entity: "unit", entityId: id, now }),
    ]);
  } catch (e) {
    if (isUnique(e, "units.slug")) throw new HttpError(409, "slug_taken", "Este endereço já está em uso.");
    throw e;
  }
  return c.json({ id }, 201);
});

const unitPatch = z
  .object({
    name: z.string().trim().min(2).max(120),
    address: z.string().trim().max(200).nullable(),
    phone: z.string().trim().max(25).nullable(),
    timezone: z.string().refine(isValidTimeZone, "fuso inválido"),
    status: z.enum(["active", "inactive"]),
    autoConfirm: z.boolean(),
    minNoticeMin: z.number().int().min(0).max(10080),
    maxDaysAhead: z.number().int().min(1).max(365),
    slotStepMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    cancelWindowMin: z.number().int().min(0).max(10080),
    city: z.string().trim().min(2).max(80).nullable(),
    state: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()).nullable(),
    description: z.string().trim().max(300).nullable(),
    listed: z.boolean(),
  })
  .partial()
  .strict(); // slug propositalmente ausente: imutável (QR Code estável)

scoped.patch("/units/:unitId", async (c) => {
  const org = c.get("org");
  const unitId = c.req.param("unitId");
  requirePerm(org, "unit.manage", unitId);
  const body = await parseBody(c, unitPatch);
  const cols: Record<string, string | number | null | undefined> = {
    name: body.name, address: body.address, phone: body.phone, timezone: body.timezone, status: body.status,
    auto_confirm: body.autoConfirm === undefined ? undefined : body.autoConfirm ? 1 : 0,
    min_notice_min: body.minNoticeMin, max_days_ahead: body.maxDaysAhead, slot_step_min: body.slotStepMin,
    cancel_window_min: body.cancelWindowMin,
    city: body.city, state: body.state, description: body.description,
    listed: body.listed === undefined ? undefined : body.listed ? 1 : 0,
  };
  const entries = Object.entries(cols).filter(([, v]) => v !== undefined) as [string, string | number | null][];
  if (entries.length === 0) throw new HttpError(400, "validation_error", "Nada para atualizar");
  // Vitrine: para aparecer na listagem pública a unidade precisa informar cidade e UF (e continuar ativa).
  const cur = await c.env.DB.prepare("SELECT city, state, listed, status FROM units WHERE organization_id = ? AND id = ?").bind(org.id, unitId).first<{ city: string | null; state: string | null; listed: number; status: string }>();
  if (!cur) throw notFound();
  const willList = body.listed === undefined ? cur.listed === 1 : body.listed;
  const city = body.city === undefined ? cur.city : body.city;
  const state = body.state === undefined ? cur.state : body.state;
  if (willList && (!city || !state)) throw new HttpError(400, "validation_error", "Para aparecer na vitrine, informe cidade e UF");
  const now = isoNow(c.get("deps").now());
  const set = entries.map(([k]) => `${k} = ?`).join(", ");
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE units SET ${set}, updated_at = ? WHERE organization_id = ? AND id = ?`).bind(...entries.map(([, v]) => v), now, org.id, unitId),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "unit.updated", entity: "unit", entityId: unitId, details: { fields: entries.map(([k]) => k) }, now }),
  ]);
  if (!res[0]?.meta.changes) throw notFound();
  return c.json({ ok: true });
});

// ----- Equipe (somente proprietário) -----
const memberBody = z
  .object({
    email: z.string().max(254),
    role: z.enum(ROLES).refine((r) => r !== "owner", "use a transferência de propriedade para donos"),
    unitId: z.string().min(10).max(64),
    canReceivePayments: z.boolean().optional(),
  })
  .strict();

scoped.get("/members", async (c) => {
  const org = c.get("org");
  requirePerm(org, "user.manage");
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.role, m.status, m.unit_id, m.can_receive_payments, m.invited_email, u.email, u.display_name, un.name AS unit_name
       FROM memberships m LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN units un ON un.organization_id = m.organization_id AND un.id = m.unit_id
      WHERE m.organization_id = ? ORDER BY m.created_at`,
  )
    .bind(org.id)
    .all();
  return c.json({ members: results });
});

scoped.post("/members", async (c) => {
  const org = c.get("org");
  requirePerm(org, "user.manage");
  const body = await parseBody(c, memberBody);
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, "validation_error", "E-mail inválido");
  const unit = await c.env.DB.prepare("SELECT id FROM units WHERE organization_id = ? AND id = ?").bind(org.id, body.unitId).first();
  if (!unit) throw new HttpError(422, "unit_not_found", "Unidade não encontrada nesta organização");

  const now = isoNow(c.get("deps").now());
  // Se já existe usuário com este e-mail VERIFICADO, o vínculo nasce ativo; senão fica como convite.
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email_norm = ? AND email_verified = 1").bind(email).first<{ id: string }>();
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO memberships (id, organization_id, unit_id, user_id, invited_email, role, status, can_receive_payments, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, org.id, body.unitId, existing?.id ?? null, existing ? null : email, body.role, existing ? "active" : "invited", body.canReceivePayments ? 1 : 0, now, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "member.added", entity: "membership", entityId: id, details: { role: body.role, unitId: body.unitId }, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) throw new HttpError(409, "member_exists", "Esta pessoa já tem vínculo nesta unidade");
    throw e;
  }
  return c.json({ id, status: existing ? "active" : "invited" }, 201);
});

async function activeOwners(db: D1Database, orgId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ? AND role = 'owner' AND status = 'active'").bind(orgId).first<{ n: number }>();
  return r?.n ?? 0;
}

scoped.patch("/members/:id", async (c) => {
  const org = c.get("org");
  requirePerm(org, "user.manage");
  const body = await parseBody(
    c,
    z.object({ role: z.enum(ROLES).optional(), status: z.enum(["active", "suspended"]).optional(), canReceivePayments: z.boolean().optional() }).strict(),
  );
  const m = await c.env.DB.prepare("SELECT id, role, status, unit_id FROM memberships WHERE organization_id = ? AND id = ?")
    .bind(org.id, c.req.param("id"))
    .first<{ id: string; role: Role; status: string; unit_id: string | null }>();
  if (!m) throw notFound();

  if (m.role === "owner") {
    if (body.role && body.role !== "owner") throw new HttpError(409, "owner_protected", "Não é possível rebaixar um proprietário");
    if (body.status === "suspended" && (await activeOwners(c.env.DB, org.id)) <= 1) {
      throw new HttpError(409, "last_owner", "A organização precisa de ao menos um proprietário ativo");
    }
  }
  if (body.role === "owner") throw new HttpError(422, "validation_error", "Papel de proprietário não pode ser atribuído aqui");

  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE memberships SET role = COALESCE(?, role), status = COALESCE(?, status),
              can_receive_payments = COALESCE(?, can_receive_payments), updated_at = ?
        WHERE organization_id = ? AND id = ?`,
    ).bind(body.role ?? null, body.status ?? null, body.canReceivePayments === undefined ? null : body.canReceivePayments ? 1 : 0, now, org.id, m.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "member.updated", entity: "membership", entityId: m.id, details: body, now }),
  ]);
  return c.json({ ok: true });
});

scoped.delete("/members/:id", async (c) => {
  const org = c.get("org");
  requirePerm(org, "user.manage");
  const m = await c.env.DB.prepare("SELECT id, role, status FROM memberships WHERE organization_id = ? AND id = ?")
    .bind(org.id, c.req.param("id"))
    .first<{ id: string; role: Role; status: string }>();
  if (!m) throw notFound();
  if (m.role === "owner" && m.status === "active" && (await activeOwners(c.env.DB, org.id)) <= 1) {
    throw new HttpError(409, "last_owner", "A organização precisa de ao menos um proprietário ativo");
  }
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM memberships WHERE organization_id = ? AND id = ?").bind(org.id, m.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "member.removed", entity: "membership", entityId: m.id, now }),
  ]);
  return c.json({ ok: true });
});

scoped.route("/", catalogRoutes);
scoped.route("/", agendaRoutes);
scoped.route("/", customerRoutes);
scoped.route("/", paymentRoutes);
scoped.route("/", reportRoutes);
scoped.route("/", financeRoutes);
scoped.route("/", stockRoutes);
scoped.route("/", loyaltyRoutes);
scoped.route("/", chatRoutes);
scoped.route("/", marketingRoutes);

orgRoutes.route("/:orgId", scoped);

export { allowedUnits, audit };
