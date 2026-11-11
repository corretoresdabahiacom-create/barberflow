import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { audienceSql, buildCampaignEmail, CAMPAIGN_DAILY_CAP, marketingConfigured } from "../domain/marketing";
import { HttpError, notFound, parseBody } from "../lib/http";
import { isoNow, newId, toIso } from "../lib/util";

export const marketingRoutes = new Hono<AppEnv>();

const campaignBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    subject: z.string().trim().min(2).max(150),
    body: z.string().trim().min(2).max(5000),
    segment: z.enum(["all_consented", "inactive"]),
    inactiveDays: z.number().int().min(7).max(730).nullable().optional(),
  })
  .strict()
  .refine((b) => b.segment !== "inactive" || !!b.inactiveDays, "informe inactiveDays (7–730) para o segmento inativos");

interface CampaignRow { id: string; name: string; subject: string; body: string; segment: "all_consented" | "inactive"; inactive_days: number | null; status: string; recipients_count: number; created_at: string; sent_at: string | null }
const COLS = "id, name, subject, body, segment, inactive_days, status, recipients_count, created_at, sent_at";

async function loadCampaign(db: D1Database, orgId: string, id: string): Promise<CampaignRow> {
  const row = await db.prepare(`SELECT ${COLS} FROM campaigns WHERE organization_id = ? AND id = ?`).bind(orgId, id).first<CampaignRow>();
  if (!row) throw notFound();
  return row;
}

marketingRoutes.get("/campaigns", async (c) => {
  const org = c.get("org");
  requirePerm(org, "marketing.manage");
  const { results } = await c.env.DB.prepare(`SELECT ${COLS} FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50`).bind(org.id).all();
  const configured = marketingConfigured(c.env, c.get("deps"));
  return c.json({ campaigns: results, configured, dailyCap: CAMPAIGN_DAILY_CAP });
});

marketingRoutes.post("/campaigns", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "marketing.manage");
  const b = await parseBody(c, campaignBody);
  const now = isoNow(c.get("deps").now());
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO campaigns (id, organization_id, name, subject, body, segment, inactive_days, status, recipients_count, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)")
      .bind(id, org.id, b.name, b.subject, b.body, b.segment, b.segment === "inactive" ? (b.inactiveDays ?? null) : null, user.id, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "campaign.created", entity: "campaign", entityId: id, now }),
  ]);
  return c.json({ id }, 201);
});

marketingRoutes.delete("/campaigns/:id", async (c) => {
  const org = c.get("org");
  requirePerm(org, "marketing.manage");
  const camp = await loadCampaign(c.env.DB, org.id, c.req.param("id"));
  if (camp.status !== "draft") throw new HttpError(409, "not_draft", "Campanha já enviada não pode ser apagada");
  await c.env.DB.prepare("DELETE FROM campaigns WHERE organization_id = ? AND id = ? AND status = 'draft'").bind(org.id, camp.id).run();
  return c.json({ ok: true });
});

// Prévia do público: apenas contagem (nenhum dado pessoal sai daqui).
marketingRoutes.get("/campaigns/:id/audience", async (c) => {
  const org = c.get("org");
  requirePerm(org, "marketing.manage");
  const camp = await loadCampaign(c.env.DB, org.id, c.req.param("id"));
  const a = audienceSql({ segment: camp.segment, inactiveDays: camp.inactive_days }, c.get("deps").now().getTime());
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${a.from}`).bind(org.id, ...a.binds).first<{ n: number }>();
  return c.json({ count: row?.n ?? 0, dailyCap: CAMPAIGN_DAILY_CAP });
});

marketingRoutes.post("/campaigns/:id/send", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "marketing.manage");
  const deps = c.get("deps");
  if (!marketingConfigured(c.env, deps)) {
    throw new HttpError(409, "marketing_not_configured", "Envio de campanhas indisponível: provedor de e-mail e segredo de descadastro não configurados no servidor");
  }
  const camp = await loadCampaign(c.env.DB, org.id, c.req.param("id"));
  if (camp.status !== "draft") throw new HttpError(409, "already_sent", "Campanha já enviada");
  const nowMs = deps.now().getTime();
  const now = isoNow(new Date(nowMs));

  const a = audienceSql({ segment: camp.segment, inactiveDays: camp.inactive_days }, nowMs);
  const count = (await c.env.DB.prepare(`SELECT COUNT(*) AS n ${a.from}`).bind(org.id, ...a.binds).first<{ n: number }>())?.n ?? 0;
  if (count === 0) throw new HttpError(409, "empty_audience", "Nenhum cliente com consentimento de marketing neste segmento");
  const used = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE organization_id = ? AND kind = 'campaign' AND created_at >= ?").bind(org.id, toIso(nowMs - 86400_000)).first<{ n: number }>())?.n ?? 0;
  const remaining = Math.max(0, CAMPAIGN_DAILY_CAP - used);
  if (count > remaining) {
    throw new HttpError(409, "daily_cap", `Limite diário de ${CAMPAIGN_DAILY_CAP} e-mails de campanha: público de ${count}, restam ${remaining} nas últimas 24 h. Restrinja o segmento ou tente amanhã.`);
  }

  // Reivindica a campanha (draft → sent) antes de enfileirar: dois cliques simultâneos não duplicam.
  const claim = await c.env.DB.prepare("UPDATE campaigns SET status = 'sent', sent_at = ?, recipients_count = ? WHERE organization_id = ? AND id = ? AND status = 'draft'").bind(now, count, org.id, camp.id).run();
  if ((claim.meta.changes ?? 0) === 0) throw new HttpError(409, "already_sent", "Campanha já enviada");

  const orgRow = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(org.id).first<{ name: string }>(); // tenant-ok: organizations é a própria organização do contexto
  const { results } = await c.env.DB.prepare(`SELECT c.id AS id, c.name AS name, c.email AS email ${a.from} ORDER BY c.id LIMIT ?`).bind(org.id, ...a.binds, CAMPAIGN_DAILY_CAP).all<{ id: string; name: string; email: string }>();
  const stmts: D1PreparedStatement[] = [];
  for (const r of results) {
    const m = await buildCampaignEmail(c.env, orgRow?.name ?? "a barbearia", camp, { id: r.id, name: r.name, orgId: org.id });
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO outbox (id, organization_id, customer_id, appointment_id, campaign_id, kind, to_email, subject, body, unsubscribe_url, status, attempts, next_attempt_at, dedupe_key, created_at)
         VALUES (?, ?, ?, NULL, ?, 'campaign', ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).bind(newId(), org.id, r.id, camp.id, r.email, m.subject, m.body, m.unsubscribeUrl, now, `campaign:${camp.id}:${r.id}`, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  await c.env.DB.batch([auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "campaign.sent", entity: "campaign", entityId: camp.id, details: { recipients: results.length }, now })]);
  return c.json({ queued: results.length }, 202);
});

// Andamento da campanha (contagens por status; sem e-mails dos clientes).
marketingRoutes.get("/campaigns/:id/progress", async (c) => {
  const org = c.get("org");
  requirePerm(org, "marketing.manage");
  const camp = await loadCampaign(c.env.DB, org.id, c.req.param("id"));
  const { results } = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM outbox WHERE organization_id = ? AND campaign_id = ? GROUP BY status").bind(org.id, camp.id).all();
  return c.json({ campaign: camp, outbox: results });
});
