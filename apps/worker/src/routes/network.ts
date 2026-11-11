import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { effectivePlan } from "../domain/plans";
import { HttpError, notFound, parseBody, parseQuery, rateLimit } from "../lib/http";
import { isoNow, newId, randomToken, sha256Hex, toIso } from "../lib/util";

/**
 * Redes/franquias. Cada organização continua isolada: SÓ números agregados cruzam o limite e SÓ depois do aceite
 * explícito do proprietário de cada organização. Nenhum dado de cliente (nome, telefone, e-mail) é compartilhado.
 */
export const networkRoutes = new Hono<AppEnv>();

export const SHARED_FIELDS = ["completed_appointments", "completed_revenue_cents", "new_customers", "no_shows"] as const;
const INVITE_TTL_MS = 7 * 86400_000;
const MAX_OPEN_INVITES = 5;

interface Membership { network_id: string; name: string; admin_organization_id: string }

async function myNetwork(db: D1Database, orgId: string): Promise<Membership | null> {
  return db
    .prepare("SELECT n.id AS network_id, n.name AS name, n.admin_organization_id AS admin_organization_id FROM network_members m JOIN networks n ON n.id = m.network_id WHERE m.organization_id = ?")
    .bind(orgId)
    .first<Membership>();
}

networkRoutes.get("/network", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const now = isoNow(c.get("deps").now());
  const plan = await effectivePlan(c.env.DB, org.id, now);
  const mem = await myNetwork(c.env.DB, org.id);
  if (!mem) return c.json({ network: null, canCreate: plan.allowNetwork, sharedFields: SHARED_FIELDS });
  const isAdmin = mem.admin_organization_id === org.id;
  const { results } = await c.env.DB.prepare(
    "SELECT m.organization_id AS organization_id, o.name AS name, m.consented_at AS consented_at FROM network_members m JOIN organizations o ON o.id = m.organization_id WHERE m.network_id = ? ORDER BY m.consented_at",
  ).bind(mem.network_id).all<{ organization_id: string; name: string; consented_at: string }>(); // tenant-ok: lista só nomes de organizações que aceitaram entrar na rede
  return c.json({
    network: { id: mem.network_id, name: mem.name, role: isAdmin ? "admin" : "member", memberCount: results.length },
    // Só o administrador da rede vê a lista de membros; os demais veem apenas a quantidade.
    members: isAdmin ? results : undefined,
    sharedFields: SHARED_FIELDS,
  });
});

networkRoutes.post("/network", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const b = await parseBody(c, z.object({ name: z.string().trim().min(2).max(80) }).strict());
  const now = isoNow(c.get("deps").now());
  const plan = await effectivePlan(c.env.DB, org.id, now);
  if (!plan.allowNetwork) throw new HttpError(403, "plan_no_network", `O plano ${plan.name} não inclui rede/franquia.`);
  if (await myNetwork(c.env.DB, org.id)) throw new HttpError(409, "already_in_network", "Esta organização já participa de uma rede.");
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO networks (id, name, admin_organization_id, created_at) VALUES (?, ?, ?, ?)").bind(id, b.name, org.id, now),
      c.env.DB.prepare("INSERT INTO network_members (network_id, organization_id, consented_by_user_id, consented_at) VALUES (?, ?, ?, ?)").bind(id, org.id, user.id, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "network.created", entity: "network", entityId: id, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) throw new HttpError(409, "already_in_network", "Esta organização já participa de uma rede.");
    throw e;
  }
  return c.json({ id }, 201);
});

// Convite de uso único (7 dias). O código só aparece AQUI, uma vez; no banco fica apenas o hash.
networkRoutes.post("/network/invites", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const mem = await myNetwork(c.env.DB, org.id);
  if (!mem || mem.admin_organization_id !== org.id) throw new HttpError(403, "not_network_admin", "Só a organização administradora da rede convida.");
  const nowMs = c.get("deps").now().getTime();
  const now = toIso(nowMs);
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM network_invites WHERE network_id = ? AND used_at IS NULL AND expires_at > ?").bind(mem.network_id, now).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_INVITES) throw new HttpError(409, "too_many_invites", `Máximo de ${MAX_OPEN_INVITES} convites abertos.`);
  const code = randomToken(24);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO network_invites (id, network_id, code_hash, expires_at, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId(), mem.network_id, await sha256Hex(code), toIso(nowMs + INVITE_TTL_MS), user.id, now),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "network.invite_created", entity: "network", entityId: mem.network_id, now }),
  ]);
  return c.json({ code, expiresAt: toIso(nowMs + INVITE_TTL_MS) }, 201);
});

// Entrar = ACEITE EXPLÍCITO de compartilhar os números agregados listados em `sharedFields`.
networkRoutes.post("/network/join", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const deps = c.get("deps");
  const nowMs = deps.now().getTime();
  rateLimit(`netjoin:${user.id}`, 10, 60_000, nowMs);
  const b = await parseBody(c, z.object({ code: z.string().min(10).max(80), acceptSharing: z.literal(true) }).strict());
  if (await myNetwork(c.env.DB, org.id)) throw new HttpError(409, "already_in_network", "Esta organização já participa de uma rede.");
  const now = toIso(nowMs);
  const hash = await sha256Hex(b.code);
  const claim = await c.env.DB.prepare("UPDATE network_invites SET used_at = ?, used_by_organization_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, org.id, hash, now).run();
  if ((claim.meta.changes ?? 0) === 0) throw new HttpError(404, "invalid_invite", "Convite inválido ou expirado");
  const inv = await c.env.DB.prepare("SELECT network_id FROM network_invites WHERE code_hash = ?").bind(hash).first<{ network_id: string }>();
  if (!inv) throw notFound();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO network_members (network_id, organization_id, consented_by_user_id, consented_at) VALUES (?, ?, ?, ?)").bind(inv.network_id, org.id, user.id, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "network.joined", entity: "network", entityId: inv.network_id, details: { shared: SHARED_FIELDS }, now }),
    ]);
  } catch (e) {
    await c.env.DB.prepare("UPDATE network_invites SET used_at = NULL, used_by_organization_id = NULL WHERE code_hash = ?").bind(hash).run(); // devolve o convite
    if (e instanceof Error && e.message.includes("UNIQUE")) throw new HttpError(409, "already_in_network", "Esta organização já participa de uma rede.");
    throw e;
  }
  return c.json({ ok: true });
});

// Sair a qualquer momento: o compartilhamento termina na hora.
networkRoutes.post("/network/leave", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const mem = await myNetwork(c.env.DB, org.id);
  if (!mem) throw notFound();
  const now = isoNow(c.get("deps").now());
  if (mem.admin_organization_id === org.id) {
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM network_members WHERE network_id = ?").bind(mem.network_id).first<{ n: number }>(); // tenant-ok: cross-org por desenho: contagem de membros da rede após o aceite de cada organização
    if ((n?.n ?? 0) > 1) throw new HttpError(409, "admin_has_members", "Remova os demais membros antes de encerrar a rede.");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM network_invites WHERE network_id = ?").bind(mem.network_id),
      c.env.DB.prepare("DELETE FROM network_members WHERE network_id = ? AND organization_id = ?").bind(mem.network_id, org.id),
      c.env.DB.prepare("DELETE FROM networks WHERE id = ? AND admin_organization_id = ?").bind(mem.network_id, org.id),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "network.dissolved", entity: "network", entityId: mem.network_id, now }),
    ]);
    return c.json({ ok: true });
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM network_members WHERE network_id = ? AND organization_id = ?").bind(mem.network_id, org.id),
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "network.left", entity: "network", entityId: mem.network_id, now }),
    auditStmt(c.env.DB, { orgId: mem.admin_organization_id, actorUserId: user.id, action: "network.member_left", entity: "network", entityId: mem.network_id, details: { organizationId: org.id }, now }),
  ]);
  return c.json({ ok: true });
});

networkRoutes.delete("/network/members/:memberOrgId", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const mem = await myNetwork(c.env.DB, org.id);
  if (!mem || mem.admin_organization_id !== org.id) throw new HttpError(403, "not_network_admin", "Só a organização administradora da rede remove membros.");
  const target = c.req.param("memberOrgId");
  if (target === org.id) throw new HttpError(409, "cannot_remove_self", "Use 'encerrar rede' para sair como administradora.");
  const now = isoNow(c.get("deps").now());
  const r = await c.env.DB.prepare("DELETE FROM network_members WHERE network_id = ? AND organization_id = ?").bind(mem.network_id, target).run();
  if ((r.meta.changes ?? 0) === 0) throw notFound();
  await c.env.DB.batch([
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "network.member_removed", entity: "network", entityId: mem.network_id, details: { organizationId: target }, now }),
    auditStmt(c.env.DB, { orgId: target, actorUserId: user.id, action: "network.removed_by_admin", entity: "network", entityId: mem.network_id, now }),
  ]);
  return c.json({ ok: true });
});

const rangeQuery = z.object({ from: z.string().max(40), to: z.string().max(40) });

interface Row { organization_id: string; name: string; completed: number; revenue_cents: number; new_customers: number; no_shows: number }

// Relatório agregado. Administrador: uma linha por organização (nome + números). Membro: só a própria linha + total da rede.
networkRoutes.get("/network/report", async (c) => {
  const org = c.get("org");
  requirePerm(org, "org.manage");
  const mem = await myNetwork(c.env.DB, org.id);
  if (!mem) throw notFound();
  const q = parseQuery(c, rangeQuery);
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to || to - from > 366 * 86400_000) throw new HttpError(400, "validation_error", "Período inválido (máximo 366 dias)");
  const f = toIso(from);
  const t = toIso(to);

  const { results: members } = await c.env.DB.prepare("SELECT m.organization_id AS id, o.name AS name FROM network_members m JOIN organizations o ON o.id = m.organization_id WHERE m.network_id = ?").bind(mem.network_id).all<{ id: string; name: string }>(); // tenant-ok: membros consentidos da própria rede; sem dados de cliente
  const ids = members.map((m) => m.id);
  const marks = ids.map(() => "?").join(",");
  const [appts, custs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT organization_id, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'completed' THEN total_cents ELSE 0 END) AS revenue_cents,
              SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_shows
         FROM appointments WHERE organization_id IN (${marks}) AND starts_at >= ? AND starts_at < ? GROUP BY organization_id`,
    ).bind(...ids, f, t).all<{ organization_id: string; completed: number; revenue_cents: number; no_shows: number }>(),
    c.env.DB.prepare(`SELECT organization_id, COUNT(*) AS n FROM customers WHERE organization_id IN (${marks}) AND created_at >= ? AND created_at < ? GROUP BY organization_id`).bind(...ids, f, t).all<{ organization_id: string; n: number }>(),
  ]);
  const rows: Row[] = members.map((m) => {
    const a = appts.results.find((r) => r.organization_id === m.id);
    return { organization_id: m.id, name: m.name, completed: a?.completed ?? 0, revenue_cents: a?.revenue_cents ?? 0, new_customers: custs.results.find((r) => r.organization_id === m.id)?.n ?? 0, no_shows: a?.no_shows ?? 0 };
  });
  const total = rows.reduce((s, r) => ({ completed: s.completed + r.completed, revenue_cents: s.revenue_cents + r.revenue_cents, new_customers: s.new_customers + r.new_customers, no_shows: s.no_shows + r.no_shows }), { completed: 0, revenue_cents: 0, new_customers: 0, no_shows: 0 });
  const isAdmin = mem.admin_organization_id === org.id;
  return c.json({
    from: f, to: t, memberCount: rows.length, total,
    organizations: isAdmin ? rows : rows.filter((r) => r.organization_id === org.id).map((r) => ({ ...r })),
    sharedFields: SHARED_FIELDS,
  });
});
