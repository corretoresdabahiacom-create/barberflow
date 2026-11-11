import { HttpError } from "../lib/http";

export interface PlanInfo {
  id: string;
  name: string;
  priceCents: number | null;
  maxUnits: number | null;
  maxProfessionals: number | null;
  aiDailyQuota: number;
  allowNetwork: boolean;
}

interface PlanRow {
  id: string;
  name: string;
  price_cents: number | null;
  max_units: number | null;
  max_professionals: number | null;
  ai_daily_quota: number;
  allow_network: number;
}

const toInfo = (r: PlanRow): PlanInfo => ({
  id: r.id, name: r.name, priceCents: r.price_cents, maxUnits: r.max_units, maxProfessionals: r.max_professionals,
  aiDailyQuota: r.ai_daily_quota, allowNetwork: r.allow_network === 1,
});

const COLS = "p.id, p.name, p.price_cents, p.max_units, p.max_professionals, p.ai_daily_quota, p.allow_network";

/**
 * Plano em vigor: assinatura ativa, não vencida e com plano ativo; caso contrário `free`.
 * Plano vencido/suspenso NÃO apaga nem bloqueia dados existentes: só impede criar mais unidades/profissionais além do limite do `free`.
 */
export async function effectivePlan(db: D1Database, orgId: string, nowIso: string): Promise<PlanInfo> {
  const sub = await db
    .prepare(
      `SELECT ${COLS} FROM org_subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.organization_id = ? AND s.status = 'active' AND (s.valid_until IS NULL OR s.valid_until > ?) AND p.active = 1`,
    )
    .bind(orgId, nowIso)
    .first<PlanRow>();
  if (sub) return toInfo(sub);
  const free = await db.prepare(`SELECT ${COLS} FROM plans p WHERE p.id = 'free'`).first<PlanRow>();
  if (!free) throw new HttpError(500, "plan_missing", "Plano base ausente");
  return toInfo(free);
}

export async function planUsage(db: D1Database, orgId: string): Promise<{ units: number; professionals: number }> {
  const [u, p] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM units WHERE organization_id = ?").bind(orgId).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM professionals WHERE organization_id = ? AND status = 'active'").bind(orgId).first<{ n: number }>(),
  ]);
  return { units: u?.n ?? 0, professionals: p?.n ?? 0 };
}

/** Verificação antes de criar (melhor esforço: duas criações simultâneas no limite podem passar por 1). */
export async function assertWithinLimit(db: D1Database, orgId: string, nowIso: string, kind: "units" | "professionals"): Promise<void> {
  const [plan, usage] = await Promise.all([effectivePlan(db, orgId, nowIso), planUsage(db, orgId)]);
  const max = kind === "units" ? plan.maxUnits : plan.maxProfessionals;
  if (max !== null && usage[kind] >= max) {
    const what = kind === "units" ? "unidades" : "profissionais";
    throw new HttpError(409, "plan_limit", `Limite do plano ${plan.name}: ${max} ${what}. Fale com o suporte para mudar de plano.`);
  }
}
