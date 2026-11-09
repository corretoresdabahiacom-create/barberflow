import { Hono } from "hono";
import { z } from "zod";
import { auditStmt } from "../lib/audit";
import { allowedUnits, can, requirePerm } from "../auth/rbac";
import type { OrgContext } from "../auth/rbac";
import type { AppEnv } from "../auth/middleware";
import { HttpError, forbidden, notFound, parseBody } from "../lib/http";
import { isoNow, newId, toIso } from "../lib/util";

export const catalogRoutes = new Hono<AppEnv>();

const id = z.string().min(10).max(64);
/** Serviços e preços são da ORGANIZAÇÃO (valem em todas as unidades): só quem tem vínculo org-wide altera. */
function requireOrgWideCatalog(org: OrgContext): void {
  if (allowedUnits(org, "catalog.write") !== "all") throw forbidden();
}

const mult5 = (min: number, max: number) => z.number().int().min(min).max(max).refine((n) => n % 5 === 0, "múltiplo de 5");

// ---------------- Serviços (nível da organização) ----------------
const serviceBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    category: z.string().trim().max(60).nullable().optional(),
    priceCents: z.number().int().min(0).max(100_000_000),
    durationMin: mult5(5, 240),
    bufferMin: mult5(0, 60).optional(),
  })
  .strict();

catalogRoutes.get("/services", async (c) => {
  requirePerm(c.get("org"), "catalog.read");
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, description, category, price_cents, duration_min, buffer_min, status
       FROM services WHERE organization_id = ? ORDER BY status, name`,
  )
    .bind(c.get("org").id)
    .all();
  return c.json({ services: results });
});

catalogRoutes.post("/services", async (c) => {
  const org = c.get("org");
  requireOrgWideCatalog(org);
  const b = await parseBody(c, serviceBody);
  const now = isoNow(c.get("deps").now());
  const sid = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO services (id, organization_id, name, description, category, price_cents, duration_min, buffer_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(sid, org.id, b.name, b.description ?? null, b.category ?? null, b.priceCents, b.durationMin, b.bufferMin ?? 0, now, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "service.created", entity: "service", entityId: sid, now }),
  ]);
  return c.json({ id: sid }, 201);
});

catalogRoutes.patch("/services/:id", async (c) => {
  const org = c.get("org");
  requireOrgWideCatalog(org);
  const b = await parseBody(c, serviceBody.partial().extend({ status: z.enum(["active", "inactive"]).optional() }).strict());
  const cols: Record<string, string | number | null | undefined> = {
    name: b.name, description: b.description, category: b.category, price_cents: b.priceCents,
    duration_min: b.durationMin, buffer_min: b.bufferMin, status: b.status,
  };
  const entries = Object.entries(cols).filter(([, v]) => v !== undefined) as [string, string | number | null][];
  if (entries.length === 0) throw new HttpError(400, "validation_error", "Nada para atualizar");
  const now = isoNow(c.get("deps").now());
  const sid = c.req.param("id");
  const set = entries.map(([k]) => `${k} = ?`).join(", ");
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE services SET ${set}, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .bind(...entries.map(([, v]) => v), now, org.id, sid),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "service.updated", entity: "service", entityId: sid, details: { fields: entries.map(([k]) => k) }, now }),
  ]);
  if (!res[0]?.meta.changes) throw notFound();
  return c.json({ ok: true });
});

// ---------------- Profissionais ----------------
interface ProRow {
  id: string;
  user_id: string | null;
  name: string;
  bio: string | null;
  status: string;
}

async function loadPro(db: D1Database, orgId: string, proId: string): Promise<{ pro: ProRow; unitIds: string[] }> {
  const pro = await db
    .prepare("SELECT id, user_id, name, bio, status FROM professionals WHERE organization_id = ? AND id = ?")
    .bind(orgId, proId)
    .first<ProRow>();
  if (!pro) throw notFound();
  const { results } = await db
    .prepare("SELECT unit_id FROM professional_units WHERE organization_id = ? AND professional_id = ?")
    .bind(orgId, proId)
    .all<{ unit_id: string }>();
  return { pro, unitIds: results.map((r) => r.unit_id) };
}

/** Escrita no cadastro do profissional: exige catalog.write em ao menos uma das unidades dele (ou vínculo da organização). */
function canWritePro(org: OrgContext, unitIds: string[]): boolean {
  if (unitIds.length === 0) return allowedUnits(org, "catalog.write") === "all";
  return unitIds.some((u) => can(org, "catalog.write", u));
}

async function assertUnitsInOrg(db: D1Database, orgId: string, unitIds: string[]): Promise<void> {
  if (unitIds.length === 0) return;
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM units WHERE organization_id = ? AND id IN (${unitIds.map(() => "?").join(",")})`)
    .bind(orgId, ...unitIds)
    .first<{ n: number }>();
  if ((r?.n ?? 0) !== unitIds.length) throw new HttpError(422, "unit_not_found", "Unidade inválida");
}

async function memberUserId(db: D1Database, orgId: string, memberId: string): Promise<string> {
  const m = await db
    .prepare("SELECT user_id FROM memberships WHERE organization_id = ? AND id = ? AND user_id IS NOT NULL")
    .bind(orgId, memberId)
    .first<{ user_id: string }>();
  if (!m) throw new HttpError(422, "member_not_found", "Vínculo inválido");
  return m.user_id;
}

catalogRoutes.get("/professionals", async (c) => {
  const org = c.get("org");
  requirePerm(org, "catalog.read");
  const user = c.get("user");
  const allowed = allowedUnits(org, "catalog.read");
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.bio, p.status, p.user_id,
            (SELECT group_concat(pu.unit_id) FROM professional_units pu WHERE pu.organization_id = p.organization_id AND pu.professional_id = p.id) AS unit_ids
       FROM professionals p WHERE p.organization_id = ? ORDER BY p.status, p.name`,
  )
    .bind(org.id)
    .all<{ id: string; name: string; bio: string | null; status: string; user_id: string | null; unit_ids: string | null }>();
  const list = results
    .map((r) => ({ id: r.id, name: r.name, bio: r.bio, status: r.status, linkedToMe: r.user_id === user.id, unitIds: r.unit_ids ? r.unit_ids.split(",") : [] }))
    .filter((p) => allowed === "all" || p.unitIds.some((u) => allowed.includes(u)) || p.linkedToMe);
  return c.json({ professionals: list });
});

const proBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    bio: z.string().trim().max(500).nullable().optional(),
    unitIds: z.array(id).min(1).max(20),
    memberId: id.nullable().optional(),
  })
  .strict();

catalogRoutes.post("/professionals", async (c) => {
  const org = c.get("org");
  const b = await parseBody(c, proBody);
  for (const u of b.unitIds) requirePerm(org, "catalog.write", u);
  await assertUnitsInOrg(c.env.DB, org.id, b.unitIds);
  const userId = b.memberId ? await memberUserId(c.env.DB, org.id, b.memberId) : null;
  const now = isoNow(c.get("deps").now());
  const pid = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO professionals (id, organization_id, user_id, name, bio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(pid, org.id, userId, b.name, b.bio ?? null, now, now),
    ...b.unitIds.map((u) => c.env.DB.prepare("INSERT INTO professional_units (organization_id, professional_id, unit_id) VALUES (?, ?, ?)").bind(org.id, pid, u)),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "professional.created", entity: "professional", entityId: pid, now }),
  ]);
  return c.json({ id: pid }, 201);
});

catalogRoutes.patch("/professionals/:id", async (c) => {
  const org = c.get("org");
  const { pro, unitIds } = await loadPro(c.env.DB, org.id, c.req.param("id"));
  if (!canWritePro(org, unitIds)) throw forbidden();
  const b = await parseBody(c, proBody.partial().extend({ status: z.enum(["active", "inactive"]).optional() }).strict());
  const stmts: D1PreparedStatement[] = [];
  const now = isoNow(c.get("deps").now());

  if (b.unitIds) {
    for (const u of b.unitIds) requirePerm(org, "catalog.write", u);
    await assertUnitsInOrg(c.env.DB, org.id, b.unitIds);
    const removed = unitIds.filter((u) => !b.unitIds!.includes(u));
    for (const u of removed) {
      requirePerm(org, "catalog.write", u);
      const future = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM appointments WHERE organization_id = ? AND professional_id = ? AND unit_id = ?
           AND status IN ('pending','confirmed') AND starts_at > ?`,
      )
        .bind(org.id, pro.id, u, toIso(c.get("deps").now().getTime()))
        .first<{ n: number }>();
      if ((future?.n ?? 0) > 0) throw new HttpError(409, "has_future_appointments", "Há agendamentos futuros nesta unidade. Cancele ou remarque antes.");
      stmts.push(
        c.env.DB.prepare("DELETE FROM professional_units WHERE organization_id = ? AND professional_id = ? AND unit_id = ?").bind(org.id, pro.id, u),
        c.env.DB.prepare("DELETE FROM schedules WHERE organization_id = ? AND professional_id = ? AND unit_id = ?").bind(org.id, pro.id, u),
      );
    }
    for (const u of b.unitIds.filter((x) => !unitIds.includes(x))) {
      stmts.push(c.env.DB.prepare("INSERT INTO professional_units (organization_id, professional_id, unit_id) VALUES (?, ?, ?)").bind(org.id, pro.id, u));
    }
  }
  let userId: string | null | undefined;
  if (b.memberId !== undefined) userId = b.memberId === null ? null : await memberUserId(c.env.DB, org.id, b.memberId);

  stmts.push(
    c.env.DB.prepare(
      `UPDATE professionals SET name = COALESCE(?, name), bio = CASE WHEN ? THEN ? ELSE bio END,
              status = COALESCE(?, status), user_id = CASE WHEN ? THEN ? ELSE user_id END, updated_at = ?
        WHERE organization_id = ? AND id = ?`,
    ).bind(b.name ?? null, b.bio !== undefined ? 1 : 0, b.bio ?? null, b.status ?? null, userId !== undefined ? 1 : 0, userId ?? null, now, org.id, pro.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "professional.updated", entity: "professional", entityId: pro.id, now }),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// Serviços que o profissional oferece (com preço/duração opcionais por profissional)
catalogRoutes.get("/professionals/:id/services", async (c) => {
  const org = c.get("org");
  requirePerm(org, "catalog.read");
  await loadPro(c.env.DB, org.id, c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    "SELECT service_id, price_cents, duration_min FROM professional_services WHERE organization_id = ? AND professional_id = ?",
  )
    .bind(org.id, c.req.param("id"))
    .all();
  return c.json({ services: results });
});

catalogRoutes.put("/professionals/:id/services", async (c) => {
  const org = c.get("org");
  const { pro, unitIds } = await loadPro(c.env.DB, org.id, c.req.param("id"));
  if (!canWritePro(org, unitIds)) throw forbidden();
  const b = await parseBody(
    c,
    z
      .object({
        services: z
          .array(z.object({ serviceId: id, priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(), durationMin: mult5(5, 240).nullable().optional() }).strict())
          .max(100),
      })
      .strict(),
  );
  const ids = [...new Set(b.services.map((s) => s.serviceId))];
  if (ids.length !== b.services.length) throw new HttpError(400, "validation_error", "Serviço repetido");
  if (ids.length) {
    const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM services WHERE organization_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(org.id, ...ids)
      .first<{ n: number }>();
    if ((r?.n ?? 0) !== ids.length) throw new HttpError(422, "service_not_found", "Serviço inválido");
  }
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM professional_services WHERE organization_id = ? AND professional_id = ?").bind(org.id, pro.id),
    ...b.services.map((s) =>
      c.env.DB.prepare("INSERT INTO professional_services (organization_id, professional_id, service_id, price_cents, duration_min) VALUES (?, ?, ?, ?, ?)")
        .bind(org.id, pro.id, s.serviceId, s.priceCents ?? null, s.durationMin ?? null),
    ),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "professional.services_set", entity: "professional", entityId: pro.id, details: { count: ids.length }, now }),
  ]);
  return c.json({ ok: true });
});

// ---------------- Horários de trabalho ----------------
catalogRoutes.get("/professionals/:id/schedules", async (c) => {
  const org = c.get("org");
  requirePerm(org, "catalog.read");
  await loadPro(c.env.DB, org.id, c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    "SELECT unit_id, weekday, start_min, end_min FROM schedules WHERE organization_id = ? AND professional_id = ? ORDER BY unit_id, weekday, start_min",
  )
    .bind(org.id, c.req.param("id"))
    .all();
  return c.json({ schedules: results });
});

const scheduleBody = z
  .object({
    unitId: id,
    days: z
      .array(
        z
          .object({ weekday: z.number().int().min(0).max(6), startMin: z.number().int().min(0).max(1435), endMin: z.number().int().min(5).max(1440) })
          .strict()
          .refine((d) => d.startMin < d.endMin && d.startMin % 5 === 0 && d.endMin % 5 === 0, "intervalo inválido (múltiplos de 5 e início < fim)"),
      )
      .max(70),
  })
  .strict();

catalogRoutes.put("/professionals/:id/schedules", async (c) => {
  const org = c.get("org");
  const { pro, unitIds } = await loadPro(c.env.DB, org.id, c.req.param("id"));
  const b = await parseBody(c, scheduleBody);
  requirePerm(org, "catalog.write", b.unitId);
  if (!unitIds.includes(b.unitId)) throw new HttpError(422, "unit_not_linked", "Profissional não atende nesta unidade");

  // Sem sobreposição dentro do mesmo dia da semana.
  const byDay = new Map<number, { s: number; e: number }[]>();
  for (const d of b.days) byDay.set(d.weekday, [...(byDay.get(d.weekday) ?? []), { s: d.startMin, e: d.endMin }]);
  for (const list of byDay.values()) {
    list.sort((x, y) => x.s - y.s);
    for (let i = 1; i < list.length; i++) {
      if ((list[i] as { s: number }).s < (list[i - 1] as { e: number }).e) throw new HttpError(422, "schedule_overlap", "Há horários sobrepostos no mesmo dia");
    }
  }
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM schedules WHERE organization_id = ? AND professional_id = ? AND unit_id = ?").bind(org.id, pro.id, b.unitId),
    ...b.days.map((d) =>
      c.env.DB.prepare("INSERT INTO schedules (id, organization_id, professional_id, unit_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(newId(), org.id, pro.id, b.unitId, d.weekday, d.startMin, d.endMin),
    ),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "professional.schedule_set", entity: "professional", entityId: pro.id, details: { unitId: b.unitId }, now }),
  ]);
  return c.json({ ok: true });
});

// ---------------- Bloqueios / folgas ----------------
catalogRoutes.get("/professionals/:id/blocks", async (c) => {
  const org = c.get("org");
  const { pro, unitIds } = await loadPro(c.env.DB, org.id, c.req.param("id"));
  const own = pro.user_id === c.get("user").id && can(org, "agenda.read_own");
  if (!own && !unitIds.some((u) => can(org, "agenda.read", u))) throw forbidden();
  const { results } = await c.env.DB.prepare(
    "SELECT id, starts_at, ends_at, kind, reason FROM time_blocks WHERE organization_id = ? AND professional_id = ? AND ends_at > ? ORDER BY starts_at",
  )
    .bind(org.id, pro.id, toIso(c.get("deps").now().getTime()))
    .all();
  return c.json({ blocks: results });
});

const blockBody = z
  .object({ startsAt: z.string().max(40), endsAt: z.string().max(40), kind: z.enum(["block", "dayoff"]).optional(), reason: z.string().trim().max(200).nullable().optional() })
  .strict();

async function canManageBlocks(org: OrgContext, pro: ProRow, unitIds: string[], userId: string): Promise<boolean> {
  if (canWritePro(org, unitIds)) return true;
  return pro.user_id === userId && can(org, "agenda.write_own");
}

catalogRoutes.post("/professionals/:id/blocks", async (c) => {
  const org = c.get("org");
  const { pro, unitIds } = await loadPro(c.env.DB, org.id, c.req.param("id"));
  if (!(await canManageBlocks(org, pro, unitIds, c.get("user").id))) throw forbidden();
  const b = await parseBody(c, blockBody);
  const s = Date.parse(b.startsAt);
  const e = Date.parse(b.endsAt);
  if (Number.isNaN(s) || Number.isNaN(e) || s >= e) throw new HttpError(400, "validation_error", "Período inválido");
  if (e - s > 366 * 86400_000) throw new HttpError(400, "validation_error", "Período longo demais");
  const now = isoNow(c.get("deps").now());
  const bid = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO time_blocks (id, organization_id, professional_id, starts_at, ends_at, kind, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(bid, org.id, pro.id, toIso(s), toIso(e), b.kind ?? "block", b.reason ?? null, c.get("user").id, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "time_block.created", entity: "time_block", entityId: bid, now }),
  ]);
  return c.json({ id: bid }, 201);
});

catalogRoutes.delete("/professionals/:id/blocks/:blockId", async (c) => {
  const org = c.get("org");
  const { pro, unitIds } = await loadPro(c.env.DB, org.id, c.req.param("id"));
  if (!(await canManageBlocks(org, pro, unitIds, c.get("user").id))) throw forbidden();
  const now = isoNow(c.get("deps").now());
  const res = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM time_blocks WHERE organization_id = ? AND professional_id = ? AND id = ?").bind(org.id, pro.id, c.req.param("blockId")),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "time_block.deleted", entity: "time_block", entityId: c.req.param("blockId"), now }),
  ]);
  if (!res[0]?.meta.changes) throw notFound();
  return c.json({ ok: true });
});
