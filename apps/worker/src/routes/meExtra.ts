import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { staffToNotify, notifyStmt } from "../lib/audit";
import { background, pushToUsers } from "../domain/push";
import { HttpError, notFound, parseBody, parseQuery, rateLimit } from "../lib/http";
import { isoNow, newId } from "../lib/util";
import { isAllowedPushEndpoint } from "../lib/webpush";
import { loadPublicUnit } from "./public";

/** Rotas do usuário logado: Web Push e chat (lado do cliente). Montado dentro de /api/me (requireAuth já aplicado). */
export const meExtraRoutes = new Hono<AppEnv>();

// ---------------- Web Push ----------------
meExtraRoutes.get("/push/config", (c) => {
  const enabled = c.get("deps").push.enabled(c.env);
  return c.json({ enabled, publicKey: enabled ? c.env.VAPID_PUBLIC_KEY : null });
});

const subBody = z
  .object({
    endpoint: z.string().max(1000),
    keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(20).max(30) }).strict(),
  })
  .strict();

meExtraRoutes.post("/push/subscriptions", async (c) => {
  const user = c.get("user");
  if (!c.get("deps").push.enabled(c.env)) throw new HttpError(409, "push_not_configured", "Notificações push não estão ativas neste servidor");
  const b = await parseBody(c, subBody);
  if (!isAllowedPushEndpoint(b.endpoint)) throw new HttpError(400, "invalid_endpoint", "Endpoint de push não permitido");
  const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND endpoint <> ?").bind(user.id, b.endpoint).first<{ n: number }>())?.n ?? 0;
  if (n >= 10) throw new HttpError(409, "too_many_subscriptions", "Limite de 10 aparelhos por conta");
  const now = isoNow(c.get("deps").now());
  // o mesmo aparelho pode trocar de dono (logout/login): a assinatura passa para o usuário atual
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).bind(newId(), user.id, b.endpoint, b.keys.p256dh, b.keys.auth, now).run();
  return c.json({ ok: true }, 201);
});

meExtraRoutes.delete("/push/subscriptions", async (c) => {
  const b = await parseBody(c, z.object({ endpoint: z.string().max(1000) }).strict());
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(c.get("user").id, b.endpoint).run();
  return c.json({ ok: true });
});

// ---------------- Chat do cliente ----------------
interface Link { customer_id: string; organization_id: string }

/** O cliente só conversa com unidades onde já tem agendamento e vínculo verificado (customer_accounts). */
async function chatLink(db: D1Database, userId: string, unit: { id: string; organization_id: string }): Promise<Link> {
  const link = await db
    .prepare(
      `SELECT ca.customer_id, ca.organization_id FROM customer_accounts ca
        WHERE ca.user_id = ? AND ca.organization_id = ?
          AND EXISTS (SELECT 1 FROM appointments a WHERE a.organization_id = ca.organization_id AND a.customer_id = ca.customer_id AND a.unit_id = ?)
        LIMIT 1`,
    )
    .bind(userId, unit.organization_id, unit.id)
    .first<Link>();
  if (!link) throw new HttpError(403, "chat_unavailable", "O chat fica disponível depois do seu primeiro agendamento nesta barbearia");
  return link;
}

meExtraRoutes.get("/chat", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT u.slug AS unit_slug, u.name AS unit_name, o.name AS organization_name, t.id AS thread_id, COALESCE(t.customer_unread, 0) AS unread, t.last_message_at
       FROM customer_accounts ca
       JOIN units u ON u.organization_id = ca.organization_id AND u.status = 'active'
       JOIN organizations o ON o.id = u.organization_id AND o.status = 'active'
       LEFT JOIN chat_threads t ON t.organization_id = ca.organization_id AND t.unit_id = u.id AND t.customer_id = ca.customer_id
      WHERE ca.user_id = ?
        AND EXISTS (SELECT 1 FROM appointments a WHERE a.organization_id = ca.organization_id AND a.customer_id = ca.customer_id AND a.unit_id = u.id)
      ORDER BY t.last_message_at DESC, u.name LIMIT 50`,
  ).bind(user.id).all();
  return c.json({ chats: results });
});

meExtraRoutes.get("/chat/:slug/messages", async (c) => {
  const user = c.get("user");
  const unit = await loadPublicUnit(c.env.DB, c.req.param("slug"));
  const link = await chatLink(c.env.DB, user.id, unit);
  const t = await c.env.DB.prepare("SELECT id, status FROM chat_threads WHERE organization_id = ? AND unit_id = ? AND customer_id = ?").bind(link.organization_id, unit.id, link.customer_id).first<{ id: string; status: string }>();
  if (!t) return c.json({ status: "open", messages: [] });
  const { results } = await c.env.DB.prepare("SELECT id, sender_kind, body, created_at FROM chat_messages WHERE organization_id = ? AND thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").bind(link.organization_id, t.id).all();
  await c.env.DB.prepare("UPDATE chat_threads SET customer_unread = 0 WHERE organization_id = ? AND id = ?").bind(link.organization_id, t.id).run();
  return c.json({ status: t.status, messages: [...results].reverse() });
});

meExtraRoutes.post("/chat/:slug/messages", async (c) => {
  const user = c.get("user");
  const deps = c.get("deps");
  const unit = await loadPublicUnit(c.env.DB, c.req.param("slug"));
  const link = await chatLink(c.env.DB, user.id, unit);
  const b = await parseBody(c, z.object({ body: z.string().trim().min(1).max(1000) }).strict());
  const nowMs = deps.now().getTime();
  rateLimit(`chat-cust:${user.id}`, 20, 10 * 60_000, nowMs);
  const now = isoNow(new Date(nowMs));
  const mid = newId();
  const res = await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO chat_threads (id, organization_id, unit_id, customer_id, status, customer_unread, staff_unread, last_message_at, created_at) VALUES (?, ?, ?, ?, 'open', 0, 0, ?, ?)")
      .bind(newId(), link.organization_id, unit.id, link.customer_id, now, now),
    c.env.DB.prepare(
      `INSERT INTO chat_messages (id, organization_id, thread_id, sender_kind, sender_user_id, body, created_at)
       SELECT ?, t.organization_id, t.id, 'customer', ?, ?, ? FROM chat_threads t
        WHERE t.organization_id = ? AND t.unit_id = ? AND t.customer_id = ? AND t.status = 'open'`,
    ).bind(mid, user.id, b.body, now, link.organization_id, unit.id, link.customer_id),
    c.env.DB.prepare("UPDATE chat_threads SET last_message_at = ?, staff_unread = staff_unread + 1 WHERE organization_id = ? AND unit_id = ? AND customer_id = ? AND status = 'open'")
      .bind(now, link.organization_id, unit.id, link.customer_id),
  ]);
  if ((res[1]?.meta.changes ?? 0) === 0) throw new HttpError(403, "thread_blocked", "A barbearia encerrou esta conversa");

  // Avisa quem atende a unidade (donos, admins e gerentes): aviso interno + push em segundo plano.
  const staff = await staffToNotify(c.env.DB, link.organization_id, unit.id, "-");
  const cu = await c.env.DB.prepare("SELECT name FROM customers WHERE organization_id = ? AND id = ?").bind(link.organization_id, link.customer_id).first<{ name: string }>();
  const title = `Mensagem de ${cu?.name ?? "cliente"}`;
  if (staff.length > 0) {
    await c.env.DB.batch(staff.map((uid) => notifyStmt(c.env.DB, { userId: uid, orgId: link.organization_id, kind: "chat", title, body: b.body.slice(0, 120), now })));
    await background(c, pushToUsers(c.env, deps, staff, { title, body: b.body, url: "/app/chat" }));
  }
  return c.json({ id: mid }, 201);
});

export { notFound, parseQuery };
