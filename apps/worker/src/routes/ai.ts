import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { campaignPrompt, cleanOutput, insightsPrompt, parseCampaign, serviceDescPrompt } from "../domain/ai";
import { effectivePlan } from "../domain/plans";
import { HttpError, parseBody, parseQuery, rateLimit } from "../lib/http";
import { isoNow, newId, toIso } from "../lib/util";

export const aiRoutes = new Hono<AppEnv>();

type Feature = "campaign_copy" | "service_description" | "insights";

interface Settings { enabled: number; daily_quota: number }

async function loadSettings(db: D1Database, orgId: string): Promise<Settings> {
  return (await db.prepare("SELECT enabled, daily_quota FROM ai_settings WHERE organization_id = ?").bind(orgId).first<Settings>()) ?? { enabled: 0, daily_quota: 20 };
}

async function usedToday(db: D1Database, orgId: string, day: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE organization_id = ? AND day = ? AND status IN ('reserved','ok')").bind(orgId, day).first<{ n: number }>();
  return r?.n ?? 0;
}

aiRoutes.get("/ai", async (c) => {
  const org = c.get("org");
  requirePerm(org, "ai.use");
  const deps = c.get("deps");
  const now = isoNow(deps.now());
  const [s, plan, used] = await Promise.all([loadSettings(c.env.DB, org.id), effectivePlan(c.env.DB, org.id, now), usedToday(c.env.DB, org.id, now.slice(0, 10))]);
  const limit = Math.min(s.daily_quota, plan.aiDailyQuota);
  return c.json({
    enabled: s.enabled === 1,
    providers: deps.ai.available(c.env), // nomes apenas; nunca chaves
    orgDailyQuota: s.daily_quota,
    planDailyQuota: plan.aiDailyQuota,
    effectiveDailyQuota: limit,
    usedToday: used,
    notice: "Textos enviados à IA podem ser processados por terceiros (planos gratuitos de alguns provedores podem usar o conteúdo para melhorar produtos). Nenhum dado de cliente é enviado.",
  });
});

aiRoutes.put("/ai/settings", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const b = await parseBody(c, z.object({ enabled: z.boolean(), dailyQuota: z.number().int().min(0).max(1000) }).strict());
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ai_settings (organization_id, enabled, daily_quota, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET enabled = excluded.enabled, daily_quota = excluded.daily_quota, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
    ).bind(org.id, b.enabled ? 1 : 0, b.dailyQuota, user.id, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "ai.settings_changed", entity: "ai_settings", entityId: org.id, details: { enabled: b.enabled, dailyQuota: b.dailyQuota }, now }),
  ]);
  return c.json({ ok: true });
});

/**
 * Reserva 1 uso da cota de forma atômica (INSERT condicional): chamadas simultâneas não passam do limite.
 * Falha do provedor devolve a reserva (status `error` não conta).
 */
async function withAi<T>(c: import("hono").Context<AppEnv>, feature: Feature, run: () => Promise<{ value: T; provider: string }>): Promise<T> {
  const org = c.get("org");
  const user = c.get("user");
  const deps = c.get("deps");
  const nowMs = deps.now().getTime();
  const now = toIso(nowMs);
  const day = now.slice(0, 10);

  rateLimit(`ai:${user.id}`, 10, 60_000, nowMs);
  const s = await loadSettings(c.env.DB, org.id);
  if (s.enabled !== 1) throw new HttpError(403, "ai_disabled", "A IA está desativada nesta organização. O proprietário pode ativá-la em Ajustes de IA.");
  if (deps.ai.available(c.env).length === 0) throw new HttpError(409, "ai_not_configured", "Nenhum provedor de IA configurado no servidor.");
  const plan = await effectivePlan(c.env.DB, org.id, now);
  const limit = Math.min(s.daily_quota, plan.aiDailyQuota);

  const id = newId();
  const r = await c.env.DB.prepare(
    `INSERT INTO ai_usage (id, organization_id, user_id, feature, provider, status, day, created_at)
     SELECT ?, ?, ?, ?, NULL, 'reserved', ?, ?
      WHERE (SELECT COUNT(*) FROM ai_usage WHERE organization_id = ? AND day = ? AND status IN ('reserved','ok')) < ?`,
  ).bind(id, org.id, user.id, feature, day, now, org.id, day, limit).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(429, "ai_quota", `Cota diária de IA esgotada (${limit}/dia). Volta amanhã (UTC) ou peça aumento do plano.`);

  try {
    const out = await run();
    await c.env.DB.prepare("UPDATE ai_usage SET status = 'ok', provider = ? WHERE organization_id = ? AND id = ?").bind(out.provider, org.id, id).run();
    return out.value;
  } catch (e) {
    await c.env.DB.prepare("UPDATE ai_usage SET status = 'error' WHERE organization_id = ? AND id = ?").bind(org.id, id).run();
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, "ai_unavailable", "Os provedores de IA não responderam agora. Tente novamente em instantes.");
  }
}

aiRoutes.post("/ai/campaign-copy", async (c) => {
  const org = c.get("org");
  requirePerm(org, "ai.use");
  requirePerm(org, "marketing.manage");
  const b = await parseBody(
    c,
    z.object({ goal: z.string().trim().min(5).max(300), tone: z.enum(["amigavel", "formal", "divertido"]).default("amigavel"), offer: z.string().trim().max(200).optional() }).strict(),
  );
  const orgRow = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(org.id).first<{ name: string }>(); // tenant-ok: organizations é a própria organização do contexto
  const p = campaignPrompt(b.goal, b.tone, b.offer, orgRow?.name ?? "a barbearia");
  const suggestion = await withAi(c, "campaign_copy", async () => {
    const res = await c.get("deps").ai.generate(p, c.env);
    const parsed = parseCampaign(res.text);
    if (!parsed) throw new Error("bad_output");
    return { value: parsed, provider: res.provider };
  });
  return c.json({ suggestion, note: "Sugestão da IA: revise antes de salvar. Nada é enviado automaticamente." });
});

aiRoutes.post("/ai/service-description", async (c) => {
  const org = c.get("org");
  requirePerm(org, "ai.use");
  requirePerm(org, "catalog.write");
  const b = await parseBody(c, z.object({ serviceName: z.string().trim().min(2).max(80), details: z.string().trim().max(300).optional() }).strict());
  const p = serviceDescPrompt(b.serviceName, b.details);
  const description = await withAi(c, "service_description", async () => {
    const res = await c.get("deps").ai.generate(p, c.env);
    const text = cleanOutput(res.text, 400);
    if (text.length < 2) throw new Error("bad_output");
    return { value: text, provider: res.provider };
  });
  return c.json({ description });
});

const periodQuery = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) });

/** Números agregados da organização (sem nenhum dado pessoal). Também úteis sem IA. */
async function metrics(db: D1Database, orgId: string, nowMs: number, days: number) {
  const from = toIso(nowMs - days * 86400_000);
  const to = toIso(nowMs);
  const [byStatus, top, newCust] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents FROM appointments WHERE organization_id = ? AND starts_at >= ? AND starts_at < ? GROUP BY status").bind(orgId, from, to).all<{ status: string; n: number; cents: number }>(),
    db.prepare(
      `SELECT i.name AS name, COUNT(*) AS n, COALESCE(SUM(i.price_cents),0) AS cents
         FROM appointment_items i JOIN appointments a ON a.organization_id = i.organization_id AND a.id = i.appointment_id
        WHERE a.organization_id = ? AND a.status = 'completed' AND a.starts_at >= ? AND a.starts_at < ?
        GROUP BY i.service_id, i.name ORDER BY n DESC LIMIT 5`,
    ).bind(orgId, from, to).all<{ name: string; n: number; cents: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM customers WHERE organization_id = ? AND created_at >= ? AND created_at < ?").bind(orgId, from, to).first<{ n: number }>(),
  ]);
  const st = (k: string) => byStatus.results.find((r) => r.status === k);
  return {
    periodDays: days,
    appointments: Object.fromEntries(byStatus.results.map((r) => [r.status, r.n])),
    completedRevenueCents: st("completed")?.cents ?? 0,
    newCustomers: newCust?.n ?? 0,
    topServices: top.results.map((r) => ({ name: r.name, count: r.n, revenueCents: r.cents })),
  };
}

aiRoutes.get("/ai/metrics", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const q = parseQuery(c, periodQuery);
  return c.json({ metrics: await metrics(c.env.DB, org.id, c.get("deps").now().getTime(), q.days) });
});

// Insights: apenas proprietário (agrega a organização inteira).
aiRoutes.post("/ai/insights", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  requirePerm(org, "ai.use");
  const b = await parseBody(c, periodQuery.extend({ days: z.number().int().min(7).max(90).default(30) }).strict());
  const m = await metrics(c.env.DB, org.id, c.get("deps").now().getTime(), b.days);
  const p = insightsPrompt(JSON.stringify(m));
  const summary = await withAi(c, "insights", async () => {
    const res = await c.get("deps").ai.generate(p, c.env);
    const text = cleanOutput(res.text, 2500);
    if (text.length < 2) throw new Error("bad_output");
    return { value: text, provider: res.provider };
  });
  return c.json({ metrics: m, summary });
});
