import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { allowedUnits, requirePerm } from "../auth/rbac";
import { HttpError, forbidden, parseQuery } from "../lib/http";
import { toIso } from "../lib/util";

export const reportRoutes = new Hono<AppEnv>();

const rangeQuery = z.object({ from: z.string().max(40), to: z.string().max(40), unitId: z.string().min(10).max(64).optional() });

reportRoutes.get("/reports/summary", async (c) => {
  const org = c.get("org");
  requirePerm(org, "report.read");
  const q = parseQuery(c, rangeQuery);
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to || to - from > 366 * 86400_000) {
    throw new HttpError(400, "validation_error", "Período inválido (máximo 366 dias)");
  }
  const allowed = allowedUnits(org, "report.read");
  let unitFilter = "";
  const unitBinds: string[] = [];
  if (q.unitId) {
    if (allowed !== "all" && !allowed.includes(q.unitId)) throw forbidden();
    unitFilter = " AND unit_id = ?";
    unitBinds.push(q.unitId);
  } else if (allowed !== "all") {
    unitFilter = ` AND unit_id IN (${allowed.map(() => "?").join(",")})`;
    unitBinds.push(...allowed);
  }
  const f = toIso(from);
  const t = toIso(to);

  const [byStatus, byMethod, byPro] = await Promise.all([
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_cents),0) AS total_cents FROM appointments
        WHERE organization_id = ? AND starts_at >= ? AND starts_at < ?${unitFilter} GROUP BY status`,
    ).bind(org.id, f, t, ...unitBinds).all(),
    c.env.DB.prepare(
      `SELECT method, COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS amount_cents FROM payments
        WHERE organization_id = ? AND received_at >= ? AND received_at < ?${unitFilter} GROUP BY method`,
    ).bind(org.id, f, t, ...unitBinds).all(),
    c.env.DB.prepare(
      `SELECT a.professional_id, p.name, COUNT(*) AS completed, COALESCE(SUM(a.total_cents),0) AS total_cents
         FROM appointments a JOIN professionals p ON p.organization_id = a.organization_id AND p.id = a.professional_id
        WHERE a.organization_id = ? AND a.status = 'completed' AND a.starts_at >= ? AND a.starts_at < ?${unitFilter.replaceAll("unit_id", "a.unit_id")}
        GROUP BY a.professional_id, p.name ORDER BY total_cents DESC`,
    ).bind(org.id, f, t, ...unitBinds).all(),
  ]);
  return c.json({ from: f, to: t, byStatus: byStatus.results, byMethod: byMethod.results, byProfessional: byPro.results });
});

// Trilha de auditoria: somente proprietário (audit.read é permissão de organização).
reportRoutes.get("/audit", async (c) => {
  const org = c.get("org");
  requirePerm(org, "audit.read");
  const q = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().max(40).optional() }));
  const { results } = await c.env.DB.prepare(
    `SELECT id, actor_user_id, action, entity, entity_id, details, created_at FROM audit_logs
      WHERE organization_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(org.id, q.before ?? "9999-12-31T00:00:00.000Z", q.limit)
    .all();
  return c.json({ entries: results });
});
