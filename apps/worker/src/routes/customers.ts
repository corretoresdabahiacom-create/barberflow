import { Hono } from "hono";
import { z } from "zod";
import { normalizeEmail, normalizePhone } from "@naregua/shared";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { consentStmts } from "../domain/customers";
import { HttpError, notFound, parseBody, parseQuery } from "../lib/http";
import { isoNow, newId } from "../lib/util";

export const customerRoutes = new Hono<AppEnv>();

const id = z.string().min(10).max(64);

customerRoutes.get("/customers", async (c) => {
  const org = c.get("org");
  requirePerm(org, "customer.read");
  const q = parseQuery(c, z.object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }));
  const binds: (string | number)[] = [org.id];
  let where = "status <> 'anonymized'";
  if (q.q) {
    const digits = q.q.replace(/\D/g, "");
    const like = `%${q.q.toLowerCase().replace(/[%_]/g, "")}%`;
    where += " AND (LOWER(name) LIKE ? OR email_norm LIKE ?" + (digits.length >= 4 ? " OR phone_norm LIKE ?" : "") + ")";
    binds.push(like, like);
    if (digits.length >= 4) binds.push(`%${digits}%`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, phone, email, status, no_show_count, created_at FROM customers WHERE organization_id = ? AND ${where} ORDER BY name LIMIT ? OFFSET ?`,
  )
    .bind(...binds, q.limit, q.offset)
    .all();
  return c.json({ customers: results });
});

const contact = z
  .object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().min(8).max(25),
    email: z.string().max(254).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

customerRoutes.post("/customers", async (c) => {
  const org = c.get("org");
  requirePerm(org, "customer.write");
  const b = await parseBody(c, contact);
  const phoneNorm = normalizePhone(b.phone);
  if (!phoneNorm) throw new HttpError(400, "validation_error", "Telefone inválido (informe DDD + número)");
  const emailNorm = b.email ? normalizeEmail(b.email) : null;
  if (b.email && !emailNorm) throw new HttpError(400, "validation_error", "E-mail inválido");

  const dup = await c.env.DB.prepare("SELECT id FROM customers WHERE organization_id = ? AND phone_norm = ? AND status = 'active' LIMIT 1")
    .bind(org.id, phoneNorm)
    .first<{ id: string }>();
  if (dup) throw new HttpError(409, "customer_exists", "Já existe cliente com este telefone");

  const now = isoNow(c.get("deps").now());
  const cid = newId();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO customers (id, organization_id, name, phone, phone_norm, email, email_norm, notes, status, no_show_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    ).bind(cid, org.id, b.name, b.phone, phoneNorm, b.email?.trim() ?? null, emailNorm, b.notes ?? null, now, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "customer.created", entity: "customer", entityId: cid, now }),
  ]);
  return c.json({ id: cid }, 201);
});

async function loadCustomer(db: D1Database, orgId: string, cid: string) {
  const row = await db
    .prepare("SELECT id, name, phone, phone_norm, email, notes, status, no_show_count, created_at FROM customers WHERE organization_id = ? AND id = ?")
    .bind(orgId, cid)
    .first<{ id: string; name: string; phone: string | null; phone_norm: string | null; email: string | null; notes: string | null; status: string; no_show_count: number; created_at: string }>();
  if (!row) throw notFound();
  return row;
}

customerRoutes.get("/customers/:id", async (c) => {
  const org = c.get("org");
  requirePerm(org, "customer.read");
  const cu = await loadCustomer(c.env.DB, org.id, c.req.param("id"));
  const [appts, consents, paid] = await Promise.all([
    c.env.DB.prepare("SELECT id, starts_at, status, total_cents, professional_id FROM appointments WHERE organization_id = ? AND customer_id = ? ORDER BY starts_at DESC LIMIT 30")
      .bind(org.id, cu.id).all(),
    c.env.DB.prepare(
      `SELECT purpose, channel, granted, source, created_at FROM customer_consents k
        WHERE organization_id = ? AND customer_id = ? AND created_at = (
          SELECT MAX(created_at) FROM customer_consents WHERE organization_id = k.organization_id AND customer_id = k.customer_id AND purpose = k.purpose AND channel = k.channel)`,
    ).bind(org.id, cu.id).all(),
    c.env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS total FROM payments WHERE organization_id = ? AND customer_id = ?").bind(org.id, cu.id).first<{ total: number }>(),
  ]);
  const { phone_norm: _p, ...safe } = cu;
  return c.json({ customer: safe, appointments: appts.results, consents: consents.results, totalPaidCents: paid?.total ?? 0 });
});

customerRoutes.patch("/customers/:id", async (c) => {
  const org = c.get("org");
  requirePerm(org, "customer.write");
  const cu = await loadCustomer(c.env.DB, org.id, c.req.param("id"));
  if (cu.status === "anonymized") throw new HttpError(409, "anonymized", "Cliente anonimizado não pode ser alterado");
  const b = await parseBody(c, contact.partial().extend({ status: z.enum(["active", "inactive"]).optional() }).strict());

  let phoneNorm: string | null | undefined;
  if (b.phone !== undefined) {
    phoneNorm = normalizePhone(b.phone);
    if (!phoneNorm) throw new HttpError(400, "validation_error", "Telefone inválido (informe DDD + número)");
    const dup = await c.env.DB.prepare("SELECT id FROM customers WHERE organization_id = ? AND phone_norm = ? AND status = 'active' AND id <> ? LIMIT 1")
      .bind(org.id, phoneNorm, cu.id)
      .first();
    if (dup) throw new HttpError(409, "customer_exists", "Já existe outro cliente com este telefone");
  }
  let emailNorm: string | null | undefined;
  if (b.email !== undefined) {
    emailNorm = b.email ? normalizeEmail(b.email) : null;
    if (b.email && !emailNorm) throw new HttpError(400, "validation_error", "E-mail inválido");
  }
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE customers SET name = COALESCE(?, name),
              phone = CASE WHEN ? THEN ? ELSE phone END, phone_norm = CASE WHEN ? THEN ? ELSE phone_norm END,
              email = CASE WHEN ? THEN ? ELSE email END, email_norm = CASE WHEN ? THEN ? ELSE email_norm END,
              notes = CASE WHEN ? THEN ? ELSE notes END, status = COALESCE(?, status), updated_at = ?
        WHERE organization_id = ? AND id = ?`,
    ).bind(
      b.name ?? null,
      b.phone !== undefined ? 1 : 0, b.phone ?? null, b.phone !== undefined ? 1 : 0, phoneNorm ?? null,
      b.email !== undefined ? 1 : 0, b.email?.trim() ?? null, b.email !== undefined ? 1 : 0, emailNorm ?? null,
      b.notes !== undefined ? 1 : 0, b.notes ?? null, b.status ?? null, now, org.id, cu.id,
    ),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "customer.updated", entity: "customer", entityId: cu.id, details: { fields: Object.keys(b) }, now }),
  ]);
  return c.json({ ok: true });
});

// Registro de consentimento (append-only): cada mudança é uma nova linha, com origem.
customerRoutes.post("/customers/:id/consents", async (c) => {
  const org = c.get("org");
  requirePerm(org, "customer.write");
  const cu = await loadCustomer(c.env.DB, org.id, c.req.param("id"));
  if (cu.status === "anonymized") throw new HttpError(409, "anonymized", "Cliente anonimizado");
  const b = await parseBody(c, z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional(), granted: z.boolean(), source: z.enum(["staff_recorded", "customer_request"]).default("staff_recorded"), purpose: z.enum(["marketing", "service_notifications"]).default("marketing") }).strict());
  if (b.email === undefined && b.whatsapp === undefined) throw new HttpError(400, "validation_error", "Informe ao menos um canal");
  const now = isoNow(c.get("deps").now());
  const stmts = [
    ...consentStmts(c.env.DB, org.id, cu.id, { email: b.email === true, whatsapp: b.whatsapp === true }, b.granted, b.source, now, b.purpose),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "customer.consent", entity: "customer", entityId: cu.id, details: { granted: b.granted, purpose: b.purpose }, now }),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ ok: true }, 201);
});

// LGPD: exportação dos dados do titular (somente proprietário).
customerRoutes.get("/customers/:id/export", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const cu = await loadCustomer(c.env.DB, org.id, c.req.param("id"));
  const q = (sql: string) => c.env.DB.prepare(sql).bind(org.id, cu.id).all();
  const [appts, payments, consents, chat, loyalty] = await Promise.all([
    q("SELECT id, starts_at, ends_at, status, total_cents, notes FROM appointments WHERE organization_id = ? AND customer_id = ? ORDER BY starts_at"),
    q("SELECT id, method, amount_cents, received_at FROM payments WHERE organization_id = ? AND customer_id = ? ORDER BY received_at"),
    q("SELECT purpose, channel, granted, source, created_at FROM customer_consents WHERE organization_id = ? AND customer_id = ? ORDER BY created_at"),
    q("SELECT m.sender_kind, m.body, m.created_at FROM chat_messages m JOIN chat_threads t ON t.organization_id = m.organization_id AND t.id = m.thread_id WHERE m.organization_id = ? AND t.customer_id = ? ORDER BY m.created_at"),
    q("SELECT kind, points, note, created_at FROM loyalty_ledger WHERE organization_id = ? AND customer_id = ? ORDER BY created_at"),
  ]);
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "customer.exported", entity: "customer", entityId: cu.id, now })]);
  const { phone_norm: _p, ...safe } = cu;
  c.header("Cache-Control", "no-store");
  return c.json({ exportedAt: now, customer: safe, appointments: appts.results, payments: payments.results, consents: consents.results, chatMessages: chat.results, loyaltyLedger: loyalty.results });
});

// LGPD: anonimização (somente proprietário). Mantém registros financeiros/agenda sem identificar a pessoa.
customerRoutes.post("/customers/:id/anonymize", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const cu = await loadCustomer(c.env.DB, org.id, c.req.param("id"));
  if (cu.status === "anonymized") return c.json({ ok: true });
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE customers SET name = 'Cliente anonimizado', phone = NULL, phone_norm = NULL, email = NULL, email_norm = NULL, notes = NULL,
              status = 'anonymized', updated_at = ? WHERE organization_id = ? AND id = ?`,
    ).bind(now, org.id, cu.id),
    c.env.DB.prepare("DELETE FROM customer_accounts WHERE organization_id = ? AND customer_id = ?").bind(org.id, cu.id),
    // LGPD: conversas do chat são apagadas (conteúdo pessoal); lançamentos financeiros e de pontos permanecem sem identificar a pessoa.
    c.env.DB.prepare("DELETE FROM chat_messages WHERE organization_id = ? AND thread_id IN (SELECT id FROM chat_threads WHERE organization_id = ? AND customer_id = ?)").bind(org.id, org.id, cu.id),
    c.env.DB.prepare("DELETE FROM chat_threads WHERE organization_id = ? AND customer_id = ?").bind(org.id, cu.id),
    c.env.DB.prepare("UPDATE outbox SET to_email = 'removido', subject = '', body = '', status = CASE WHEN status = 'pending' THEN 'skipped' ELSE status END WHERE organization_id = ? AND customer_id = ?").bind(org.id, cu.id),
    c.env.DB.prepare("UPDATE appointments SET notes = NULL, cancel_token_hash = NULL, updated_at = ? WHERE organization_id = ? AND customer_id = ?").bind(now, org.id, cu.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: c.get("user").id, action: "customer.anonymized", entity: "customer", entityId: cu.id, now }),
  ]);
  return c.json({ ok: true });
});
