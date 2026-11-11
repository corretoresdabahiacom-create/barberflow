import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt, notifyStmt } from "../lib/audit";
import { background, pushToUsers } from "../domain/push";
import { HttpError, notFound, parseBody, parseQuery, rateLimit } from "../lib/http";
import { unitScope } from "../lib/scope";
import { isoNow, newId } from "../lib/util";

/** Chat — lado da equipe (rotas da organização). O lado do cliente fica em /api/me/chat. */
export const chatRoutes = new Hono<AppEnv>();

const id = z.string().min(10).max(64);
const msgBody = z.object({ body: z.string().trim().min(1).max(1000) }).strict();

interface Thread { id: string; unit_id: string; customer_id: string; status: string }
async function loadThread(db: D1Database, orgId: string, tid: string): Promise<Thread> {
  const t = await db.prepare("SELECT id, unit_id, customer_id, status FROM chat_threads WHERE organization_id = ? AND id = ?").bind(orgId, tid).first<Thread>();
  if (!t) throw notFound();
  return t;
}

chatRoutes.get("/chat/threads", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, z.object({ unitId: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }));
  const sc = unitScope(org, "chat.read", q.unitId, "t.unit_id");
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.unit_id, t.status, t.staff_unread, t.last_message_at, cu.name AS customer_name, u.name AS unit_name,
            (SELECT m.body FROM chat_messages m WHERE m.organization_id = t.organization_id AND m.thread_id = t.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_body
       FROM chat_threads t
       JOIN customers cu ON cu.organization_id = t.organization_id AND cu.id = t.customer_id
       JOIN units u ON u.organization_id = t.organization_id AND u.id = t.unit_id
      WHERE t.organization_id = ?${sc.sql} ORDER BY t.last_message_at DESC LIMIT ?`,
  ).bind(org.id, ...sc.binds, q.limit).all();
  return c.json({ threads: results });
});

chatRoutes.get("/chat/threads/:id/messages", async (c) => {
  const org = c.get("org");
  const t = await loadThread(c.env.DB, org.id, c.req.param("id"));
  requirePerm(org, "chat.read", t.unit_id);
  const { results } = await c.env.DB.prepare(
    "SELECT id, sender_kind, body, created_at FROM chat_messages WHERE organization_id = ? AND thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100",
  ).bind(org.id, t.id).all();
  await c.env.DB.prepare("UPDATE chat_threads SET staff_unread = 0 WHERE organization_id = ? AND id = ?").bind(org.id, t.id).run();
  return c.json({ status: t.status, messages: [...results].reverse() });
});

chatRoutes.post("/chat/threads/:id/messages", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const deps = c.get("deps");
  const t = await loadThread(c.env.DB, org.id, c.req.param("id"));
  requirePerm(org, "chat.write", t.unit_id);
  const b = await parseBody(c, msgBody);
  const nowMs = deps.now().getTime();
  rateLimit(`chat-staff:${user.id}`, 60, 10 * 60_000, nowMs);
  if (t.status !== "open") throw new HttpError(409, "thread_blocked", "Conversa bloqueada");
  const now = isoNow(new Date(nowMs));
  const mid = newId();
  const res = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO chat_messages (id, organization_id, thread_id, sender_kind, sender_user_id, body, created_at)
       SELECT ?, t.organization_id, t.id, 'staff', ?, ?, ? FROM chat_threads t WHERE t.organization_id = ? AND t.id = ? AND t.status = 'open'`,
    ).bind(mid, user.id, b.body, now, org.id, t.id),
    c.env.DB.prepare("UPDATE chat_threads SET last_message_at = ?, customer_unread = customer_unread + 1 WHERE organization_id = ? AND id = ? AND status = 'open'").bind(now, org.id, t.id),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) throw new HttpError(409, "thread_blocked", "Conversa bloqueada");

  const { results: accounts } = await c.env.DB.prepare("SELECT user_id FROM customer_accounts WHERE organization_id = ? AND customer_id = ?").bind(org.id, t.customer_id).all<{ user_id: string }>();
  const orgRow = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(org.id).first<{ name: string }>(); // tenant-ok: organizations é a própria organização do contexto
  const title = orgRow?.name ?? "NaRégua";
  if (accounts.length > 0) {
    await c.env.DB.batch(accounts.map((a) => notifyStmt(c.env.DB, { userId: a.user_id, orgId: org.id, kind: "chat", title: `Nova mensagem de ${title}`, body: b.body.slice(0, 120), now })));
    await background(c, pushToUsers(c.env, deps, accounts.map((a) => a.user_id), { title, body: b.body, url: "/c" }));
  }
  return c.json({ id: mid }, 201);
});

chatRoutes.patch("/chat/threads/:id", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const t = await loadThread(c.env.DB, org.id, c.req.param("id"));
  requirePerm(org, "chat.write", t.unit_id);
  const b = await parseBody(c, z.object({ status: z.enum(["open", "blocked"]) }).strict());
  const now = isoNow(c.get("deps").now());
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE chat_threads SET status = ? WHERE organization_id = ? AND id = ?").bind(b.status, org.id, t.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: `chat.${b.status === "blocked" ? "blocked" : "reopened"}`, entity: "chat_thread", entityId: t.id, now }),
  ]);
  return c.json({ ok: true });
});
