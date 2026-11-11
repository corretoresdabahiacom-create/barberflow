import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { HttpError, notFound, parseBody } from "../lib/http";
import { idempotencyKey } from "../lib/scope";
import { isoNow, newId } from "../lib/util";

export const loyaltyRoutes = new Hono<AppEnv>();

// Automação da organização (editável): fidelidade e lembretes por e-mail. Ambos DESLIGADOS por padrão.
loyaltyRoutes.get("/automation", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const row = await c.env.DB.prepare("SELECT loyalty_points_per_real, reminders_enabled FROM organizations WHERE id = ?").bind(org.id).first<{ loyalty_points_per_real: number; reminders_enabled: number }>(); // tenant-ok: organizations é a própria organização do contexto
  return c.json({ loyaltyPointsPerReal: row?.loyalty_points_per_real ?? 0, remindersEnabled: row?.reminders_enabled === 1 });
});

loyaltyRoutes.put("/automation", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const b = await parseBody(c, z.object({ loyaltyPointsPerReal: z.number().int().min(0).max(100).optional(), remindersEnabled: z.boolean().optional() }).strict());
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organizations SET loyalty_points_per_real = COALESCE(?, loyalty_points_per_real), reminders_enabled = COALESCE(?, reminders_enabled), updated_at = ? WHERE id = ?")
      .bind(b.loyaltyPointsPerReal ?? null, b.remindersEnabled === undefined ? null : b.remindersEnabled ? 1 : 0, now, org.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "automation.updated", entity: "organization", entityId: org.id, details: b, now }),
  ]);
  return c.json({ ok: true });
});

async function requireCustomer(db: D1Database, orgId: string, cid: string) {
  const cu = await db.prepare("SELECT id, status FROM customers WHERE organization_id = ? AND id = ?").bind(orgId, cid).first<{ id: string; status: string }>();
  if (!cu) throw notFound();
  return cu;
}

loyaltyRoutes.get("/customers/:id/loyalty", async (c) => {
  const org = c.get("org");
  requirePerm(org, "customer.read");
  const cu = await requireCustomer(c.env.DB, org.id, c.req.param("id"));
  const [bal, ledger] = await Promise.all([
    c.env.DB.prepare("SELECT COALESCE(SUM(points),0) AS balance FROM loyalty_ledger WHERE organization_id = ? AND customer_id = ?").bind(org.id, cu.id).first<{ balance: number }>(),
    c.env.DB.prepare("SELECT id, kind, points, note, appointment_id, created_at FROM loyalty_ledger WHERE organization_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50").bind(org.id, cu.id).all(),
  ]);
  return c.json({ balance: bal?.balance ?? 0, ledger: ledger.results });
});

loyaltyRoutes.post("/customers/:id/loyalty/redeem", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "customer.write");
  const key = idempotencyKey(c);
  const cu = await requireCustomer(c.env.DB, org.id, c.req.param("id"));
  if (cu.status === "anonymized") throw new HttpError(409, "anonymized", "Cliente anonimizado");
  const b = await parseBody(c, z.object({ points: z.number().int().min(1).max(1_000_000), note: z.string().trim().min(2).max(200) }).strict());

  const find = () => c.env.DB.prepare("SELECT id, customer_id, points FROM loyalty_ledger WHERE organization_id = ? AND idempotency_key = ?").bind(org.id, key).first<{ id: string; customer_id: string; points: number }>();
  const replay = (r: { id: string; customer_id: string; points: number }) => {
    if (r.customer_id !== cu.id || r.points !== -b.points) throw new HttpError(409, "idempotency_conflict", "Esta chave já foi usada com outros dados");
    return c.json({ id: r.id, replayed: true }, 200);
  };
  const prior = await find();
  if (prior) return replay(prior);

  const now = isoNow(c.get("deps").now());
  const lid = newId();
  let changes = 0;
  try {
    // Atômico: só resgata se o saldo cobrir os pontos (impede saldo negativo mesmo em concorrência).
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO loyalty_ledger (id, organization_id, customer_id, appointment_id, kind, points, note, idempotency_key, created_by_user_id, created_at)
         SELECT ?, c.organization_id, c.id, NULL, 'redeem', ?, ?, ?, ?, ?
           FROM customers c
          WHERE c.organization_id = ? AND c.id = ?
            AND (SELECT COALESCE(SUM(l.points), 0) FROM loyalty_ledger l WHERE l.organization_id = c.organization_id AND l.customer_id = c.id) >= ?`,
      ).bind(lid, -b.points, b.note, key, user.id, now, org.id, cu.id, b.points),
    ]);
    changes = res[0]?.meta.changes ?? 0;
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: loyalty_ledger")) {
      const again = await find();
      if (again) return replay(again);
    }
    throw e;
  }
  if (changes === 0) throw new HttpError(409, "insufficient_points", "Saldo de pontos insuficiente");
  await c.env.DB.batch([auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "loyalty.redeemed", entity: "customer", entityId: cu.id, details: { points: b.points }, now })]);
  return c.json({ id: lid, replayed: false }, 201);
});

// Visibilidade da fila de e-mails (somente proprietário): sem corpo da mensagem, só estado.
loyaltyRoutes.get("/outbox", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, status, attempts, next_attempt_at, last_error, created_at, sent_at FROM outbox WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50",
  ).bind(org.id).all();
  return c.json({ outbox: results });
});
