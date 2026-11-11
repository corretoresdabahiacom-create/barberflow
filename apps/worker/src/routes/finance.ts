import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { HttpError, notFound, parseBody, parseQuery } from "../lib/http";
import { idempotencyKey, parseRangeIso, requireUnit, unitScope } from "../lib/scope";
import { isoNow, newId } from "../lib/util";

export const financeRoutes = new Hono<AppEnv>();

const id = z.string().min(10).max(64);
const range = z.object({ from: z.string().max(40), to: z.string().max(40), unitId: id.optional() });

// ---------------------------------------------------------------- Despesas (append-only; correção = estorno)
const expenseBody = z
  .object({
    unitId: id,
    category: z.string().trim().min(2).max(40),
    description: z.string().trim().max(200).nullable().optional(),
    amountCents: z.number().int().min(1).max(100_000_000),
    paidWith: z.enum(["cash", "other"]),
  })
  .strict();

interface ExpenseRow { id: string; unit_id: string; category: string; amount_cents: number; paid_with: string; reverses_id: string | null }

const EXP_COLS = "id, unit_id, category, description, amount_cents, paid_with, reverses_id, created_at, created_by_user_id";

financeRoutes.post("/expenses", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const key = idempotencyKey(c);
  const b = await parseBody(c, expenseBody);
  requirePerm(org, "finance.write", b.unitId);
  await requireUnit(c.env.DB, org.id, b.unitId);

  const find = () =>
    c.env.DB.prepare("SELECT id, unit_id, category, amount_cents, paid_with, reverses_id FROM expenses WHERE organization_id = ? AND idempotency_key = ?")
      .bind(org.id, key)
      .first<ExpenseRow>();
  const replay = (e: ExpenseRow) => {
    if (e.unit_id !== b.unitId || e.category !== b.category || e.amount_cents !== b.amountCents || e.paid_with !== b.paidWith || e.reverses_id !== null) {
      throw new HttpError(409, "idempotency_conflict", "Esta chave já foi usada com outros dados");
    }
    return c.json({ id: e.id, replayed: true }, 200);
  };
  const prior = await find();
  if (prior) return replay(prior);

  const now = isoNow(c.get("deps").now());
  const eid = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO expenses (id, organization_id, unit_id, category, description, amount_cents, paid_with, reverses_id, idempotency_key, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).bind(eid, org.id, b.unitId, b.category, b.description ?? null, b.amountCents, b.paidWith, key, user.id, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "expense.recorded", entity: "expense", entityId: eid, details: { amountCents: b.amountCents, paidWith: b.paidWith }, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: expenses")) {
      const again = await find();
      if (again) return replay(again);
    }
    throw e;
  }
  return c.json({ id: eid, replayed: false }, 201);
});

financeRoutes.post("/expenses/:id/reverse", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const key = idempotencyKey(c);
  const orig = await c.env.DB.prepare("SELECT id, unit_id, category, amount_cents, paid_with, reverses_id FROM expenses WHERE organization_id = ? AND id = ?")
    .bind(org.id, c.req.param("id"))
    .first<ExpenseRow>();
  if (!orig) throw notFound();
  requirePerm(org, "finance.write", orig.unit_id);
  if (orig.reverses_id) throw new HttpError(409, "not_reversible", "Um estorno não pode ser estornado");
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(200) }).strict());

  const prior = await c.env.DB.prepare("SELECT id, reverses_id FROM expenses WHERE organization_id = ? AND idempotency_key = ?").bind(org.id, key).first<{ id: string; reverses_id: string | null }>();
  if (prior) {
    if (prior.reverses_id !== orig.id) throw new HttpError(409, "idempotency_conflict", "Esta chave já foi usada com outros dados");
    return c.json({ id: prior.id, replayed: true }, 200);
  }
  const now = isoNow(c.get("deps").now());
  const rid = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO expenses (id, organization_id, unit_id, category, description, amount_cents, paid_with, reverses_id, idempotency_key, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(rid, org.id, orig.unit_id, orig.category, `Estorno: ${b.reason}`, orig.amount_cents, orig.paid_with, orig.id, key, user.id, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "expense.reversed", entity: "expense", entityId: orig.id, details: { reversalId: rid }, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("ux_expense_reversal")) throw new HttpError(409, "already_reversed", "Despesa já estornada");
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: expenses.organization_id, expenses.reverses_id")) throw new HttpError(409, "already_reversed", "Despesa já estornada");
    throw e;
  }
  return c.json({ id: rid, replayed: false }, 201);
});

financeRoutes.get("/expenses", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, range.extend({ limit: z.coerce.number().int().min(1).max(200).default(100) }));
  const { f, t } = parseRangeIso(q.from, q.to);
  const sc = unitScope(org, "finance.read", q.unitId);
  const { results } = await c.env.DB.prepare(
    `SELECT ${EXP_COLS} FROM expenses WHERE organization_id = ? AND created_at >= ? AND created_at < ?${sc.sql} ORDER BY created_at DESC LIMIT ?`,
  ).bind(org.id, f, t, ...sc.binds, q.limit).all();
  return c.json({ expenses: results });
});

// ---------------------------------------------------------------- Caixa (por unidade)
// Esperado = abertura + recebimentos em DINHEIRO no período − despesas pagas em DINHEIRO (líquidas de estorno).
// Vendas de produtos de estoque NÃO entram no caixa nesta fase (limitação documentada).
const EXPECTED_SQL = `(
  opening_cents
  + (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
      WHERE p.organization_id = cash_sessions.organization_id AND p.unit_id = cash_sessions.unit_id AND p.method = 'cash'
        AND p.received_at >= cash_sessions.opened_at AND p.received_at <= ?)
  - (SELECT COALESCE(SUM(CASE WHEN e.reverses_id IS NULL THEN e.amount_cents ELSE -e.amount_cents END), 0) FROM expenses e
      WHERE e.organization_id = cash_sessions.organization_id AND e.unit_id = cash_sessions.unit_id AND e.paid_with = 'cash'
        AND e.created_at >= cash_sessions.opened_at AND e.created_at <= ?)
)`;

financeRoutes.post("/cash/open", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const b = await parseBody(c, z.object({ unitId: id, openingCents: z.number().int().min(0).max(100_000_000) }).strict());
  requirePerm(org, "finance.write", b.unitId);
  await requireUnit(c.env.DB, org.id, b.unitId);
  const now = isoNow(c.get("deps").now());
  const sid = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO cash_sessions (id, organization_id, unit_id, opening_cents, opened_by_user_id, opened_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(sid, org.id, b.unitId, b.openingCents, user.id, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "cash.opened", entity: "cash_session", entityId: sid, details: { openingCents: b.openingCents }, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) throw new HttpError(409, "cash_already_open", "Já existe um caixa aberto nesta unidade");
    throw e;
  }
  return c.json({ id: sid }, 201);
});

financeRoutes.post("/cash/:id/close", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT id, unit_id, closed_at FROM cash_sessions WHERE organization_id = ? AND id = ?").bind(org.id, c.req.param("id")).first<{ id: string; unit_id: string; closed_at: string | null }>();
  if (!row) throw notFound();
  requirePerm(org, "finance.write", row.unit_id);
  const b = await parseBody(c, z.object({ countedCents: z.number().int().min(0).max(1_000_000_000), note: z.string().trim().max(300).nullable().optional() }).strict());
  const now = isoNow(c.get("deps").now());
  // Fechamento atômico e imutável: só fecha se ainda estiver aberto; esperado calculado no próprio UPDATE.
  const res = await c.env.DB.prepare(
    `UPDATE cash_sessions SET closed_at = ?, closed_by_user_id = ?, counted_cents = ?, note = ?,
            expected_cents = ${EXPECTED_SQL}, difference_cents = ? - ${EXPECTED_SQL}
      WHERE organization_id = ? AND id = ? AND closed_at IS NULL`,
  ).bind(now, user.id, b.countedCents, b.note ?? null, now, now, b.countedCents, now, now, org.id, row.id).run();
  if ((res.meta.changes ?? 0) === 0) throw new HttpError(409, "cash_already_closed", "Caixa já fechado");
  const closed = await c.env.DB.prepare("SELECT id, unit_id, opening_cents, opened_at, closed_at, counted_cents, expected_cents, difference_cents, note FROM cash_sessions WHERE organization_id = ? AND id = ?").bind(org.id, row.id).first();
  await c.env.DB.batch([
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "cash.closed", entity: "cash_session", entityId: row.id, details: { countedCents: b.countedCents }, now }),
  ]);
  return c.json({ session: closed });
});

financeRoutes.get("/cash", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, z.object({ unitId: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }));
  const sc = unitScope(org, "finance.read", q.unitId);
  const now = isoNow(c.get("deps").now());
  const { results } = await c.env.DB.prepare(
    `SELECT id, unit_id, opening_cents, opened_at, closed_at, counted_cents, expected_cents, difference_cents, note,
            CASE WHEN closed_at IS NULL THEN ${EXPECTED_SQL} ELSE NULL END AS running_expected_cents
       FROM cash_sessions WHERE organization_id = ?${sc.sql} ORDER BY opened_at DESC LIMIT ?`,
  ).bind(now, now, org.id, ...sc.binds, q.limit).all();
  return c.json({ sessions: results });
});

// ---------------------------------------------------------------- Regras de comissão (somente proprietário)
financeRoutes.get("/commission-rules", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const { results } = await c.env.DB.prepare("SELECT id, professional_id, service_id, rate_bp, updated_at FROM commission_rules WHERE organization_id = ? ORDER BY professional_id, service_id").bind(org.id).all();
  return c.json({ rules: results });
});

financeRoutes.put("/commission-rules", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const b = await parseBody(c, z.object({ professionalId: id, serviceId: id.nullable().optional(), rateBp: z.number().int().min(0).max(10000) }).strict());
  const pro = await c.env.DB.prepare("SELECT id FROM professionals WHERE organization_id = ? AND id = ?").bind(org.id, b.professionalId).first();
  if (!pro) throw notFound();
  if (b.serviceId) {
    const svc = await c.env.DB.prepare("SELECT id FROM services WHERE organization_id = ? AND id = ?").bind(org.id, b.serviceId).first();
    if (!svc) throw notFound();
  }
  const now = isoNow(c.get("deps").now());
  const conflict = b.serviceId ? "(organization_id, professional_id, service_id) WHERE service_id IS NOT NULL" : "(organization_id, professional_id) WHERE service_id IS NULL";
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO commission_rules (id, organization_id, professional_id, service_id, rate_bp, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT ${conflict} DO UPDATE SET rate_bp = excluded.rate_bp, updated_at = excluded.updated_at`,
    ).bind(newId(), org.id, b.professionalId, b.serviceId ?? null, b.rateBp, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "commission_rule.set", entity: "professional", entityId: b.professionalId, details: { serviceId: b.serviceId ?? null, rateBp: b.rateBp }, now }),
  ]);
  return c.json({ ok: true });
});

financeRoutes.delete("/commission-rules/:id", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const now = isoNow(c.get("deps").now());
  const res = await c.env.DB.prepare("DELETE FROM commission_rules WHERE organization_id = ? AND id = ?").bind(org.id, c.req.param("id")).run();
  if ((res.meta.changes ?? 0) === 0) throw notFound();
  await c.env.DB.batch([auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "commission_rule.deleted", entity: "commission_rule", entityId: c.req.param("id"), now })]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Relatórios financeiros
financeRoutes.get("/finance/commissions", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, range);
  const { f, t } = parseRangeIso(q.from, q.to);
  const sc = unitScope(org, "finance.read", q.unitId, "ce.unit_id");
  const { results } = await c.env.DB.prepare(
    `SELECT ce.professional_id, p.name, COUNT(*) AS appointments, SUM(ce.base_cents) AS base_cents, SUM(ce.commission_cents) AS commission_cents
       FROM commission_entries ce JOIN professionals p ON p.organization_id = ce.organization_id AND p.id = ce.professional_id
      WHERE ce.organization_id = ? AND ce.created_at >= ? AND ce.created_at < ?${sc.sql}
      GROUP BY ce.professional_id, p.name ORDER BY commission_cents DESC`,
  ).bind(org.id, f, t, ...sc.binds).all();
  return c.json({ from: f, to: t, commissions: results });
});

// Profissional vê apenas as PRÓPRIAS comissões (vínculo professionals.user_id).
financeRoutes.get("/finance/commissions/mine", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const q = parseQuery(c, range.omit({ unitId: true }));
  const { f, t } = parseRangeIso(q.from, q.to);
  const pro = await c.env.DB.prepare("SELECT id, name FROM professionals WHERE organization_id = ? AND user_id = ?").bind(org.id, user.id).first<{ id: string; name: string }>();
  if (!pro) throw notFound();
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS appointments, COALESCE(SUM(base_cents),0) AS base_cents, COALESCE(SUM(commission_cents),0) AS commission_cents
       FROM commission_entries WHERE organization_id = ? AND professional_id = ? AND created_at >= ? AND created_at < ?`,
  ).bind(org.id, pro.id, f, t).first();
  return c.json({ from: f, to: t, professional: pro, ...row });
});

financeRoutes.get("/finance/summary", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, range);
  const { f, t } = parseRangeIso(q.from, q.to);
  const sp = unitScope(org, "finance.read", q.unitId, "unit_id");
  const [rev, exp, com, prod] = await Promise.all([
    c.env.DB.prepare(`SELECT method, COALESCE(SUM(amount_cents),0) AS cents FROM payments WHERE organization_id = ? AND received_at >= ? AND received_at < ?${sp.sql} GROUP BY method`).bind(org.id, f, t, ...sp.binds).all<{ method: string; cents: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END),0) AS cents FROM expenses WHERE organization_id = ? AND created_at >= ? AND created_at < ?${sp.sql}`).bind(org.id, f, t, ...sp.binds).first<{ cents: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(commission_cents),0) AS cents FROM commission_entries WHERE organization_id = ? AND created_at >= ? AND created_at < ?${sp.sql}`).bind(org.id, f, t, ...sp.binds).first<{ cents: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(-qty * COALESCE(unit_price_cents,0)),0) AS cents FROM stock_movements WHERE organization_id = ? AND kind = 'sale' AND created_at >= ? AND created_at < ?${sp.sql}`).bind(org.id, f, t, ...sp.binds).first<{ cents: number }>(),
  ]);
  const servicesReceived = rev.results.reduce((s, r) => s + r.cents, 0);
  const expenses = exp?.cents ?? 0;
  const commissions = com?.cents ?? 0;
  const productSales = prod?.cents ?? 0;
  return c.json({
    from: f, to: t,
    receivedByMethod: rev.results,
    servicesReceivedCents: servicesReceived,
    productSalesCents: productSales,
    expensesCents: expenses,
    commissionsCents: commissions,
    // resultado = recebido (serviços + produtos) − despesas − comissões (regime de caixa simplificado)
    resultCents: servicesReceived + productSales - expenses - commissions,
  });
});
