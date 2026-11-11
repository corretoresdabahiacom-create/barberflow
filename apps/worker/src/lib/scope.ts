import type { Permission } from "@naregua/shared";
import { allowedUnits, type OrgContext } from "../auth/rbac";
import { HttpError, forbidden, notFound } from "./http";
import { toIso } from "./util";

/** Cabeçalho Idempotency-Key obrigatório em escritas financeiras/estoque/fidelidade. */
export function idempotencyKey(c: { req: { header: (n: string) => string | undefined } }): string {
  const key = c.req.header("idempotency-key") ?? "";
  if (key.length < 8 || key.length > 100 || !/^[A-Za-z0-9_\-:.]+$/.test(key)) {
    throw new HttpError(400, "idempotency_key_required", "Cabeçalho Idempotency-Key obrigatório (8–100 caracteres)");
  }
  return key;
}

/** A unidade precisa existir NA organização do contexto; caso contrário 404 (nunca vaza outra organização). */
export async function requireUnit(db: D1Database, orgId: string, unitId: string): Promise<void> {
  const u = await db.prepare("SELECT id FROM units WHERE organization_id = ? AND id = ?").bind(orgId, unitId).first();
  if (!u) throw notFound();
}

/** Cláusula SQL de escopo de unidade conforme a permissão (coluna parametrizável). */
export function unitScope(org: OrgContext, perm: Permission, requested: string | undefined, column = "unit_id"): { sql: string; binds: string[] } {
  const allowed = allowedUnits(org, perm);
  if (requested) {
    if (allowed !== "all" && !allowed.includes(requested)) throw forbidden();
    return { sql: ` AND ${column} = ?`, binds: [requested] };
  }
  if (allowed === "all") return { sql: "", binds: [] };
  if (allowed.length === 0) throw forbidden();
  return { sql: ` AND ${column} IN (${allowed.map(() => "?").join(",")})`, binds: allowed };
}

export function parseRangeIso(from: string, to: string): { f: string; t: string } {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || a >= b || b - a > 366 * 86400_000) {
    throw new HttpError(400, "validation_error", "Período inválido (máximo 366 dias)");
  }
  return { f: toIso(a), t: toIso(b) };
}
