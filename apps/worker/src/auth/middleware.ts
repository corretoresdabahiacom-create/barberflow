import { createMiddleware } from "hono/factory";
import { normalizeEmail } from "@naregua/shared";
import type { AppDeps, Env, TokenClaims } from "../env";
import { HttpError, notFound } from "../lib/http";
import { isoNow, newId } from "../lib/util";
import type { MembershipCtx, OrgContext } from "./rbac";

export interface UserRow {
  id: string;
  firebase_uid: string;
  email: string | null;
  email_norm: string | null;
  email_verified: number;
  display_name: string | null;
  status: "active" | "suspended";
  sessions_valid_after: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    deps: AppDeps;
    user: UserRow;
    claims: TokenClaims;
    org: OrgContext;
  };
};

export const withDeps = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    c.set("deps", deps);
    await next();
  });

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) throw new HttpError(401, "unauthenticated", "Login necessário");

  const deps = c.get("deps");
  const claims = await deps.verifyToken(m[1] as string, c.env);
  if (!claims) throw new HttpError(401, "invalid_token", "Sessão inválida ou expirada");

  const db = c.env.DB;
  const now = isoNow(deps.now());
  const emailNorm = normalizeEmail(claims.email);

  let user = await db
    .prepare("SELECT * FROM users WHERE firebase_uid = ?")
    .bind(claims.uid)
    .first<UserRow>();

  if (!user) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO users (id, firebase_uid, email, email_norm, email_verified, display_name, status, sessions_valid_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
      )
      .bind(newId(), claims.uid, claims.email, emailNorm, claims.emailVerified ? 1 : 0, claims.name, now, now)
      .run();
    user = await db.prepare("SELECT * FROM users WHERE firebase_uid = ?").bind(claims.uid).first<UserRow>();
  } else if (
    user.email !== claims.email ||
    user.email_verified !== (claims.emailVerified ? 1 : 0) ||
    (claims.name && user.display_name !== claims.name)
  ) {
    await db
      .prepare("UPDATE users SET email = ?, email_norm = ?, email_verified = ?, display_name = COALESCE(?, display_name), updated_at = ? WHERE id = ?")
      .bind(claims.email, emailNorm, claims.emailVerified ? 1 : 0, claims.name, now, user.id)
      .run();
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>();
  }
  if (!user) throw new HttpError(500, "user_unavailable", "Falha ao carregar usuário");

  if (user.status === "suspended") throw new HttpError(403, "account_suspended", "Conta suspensa");
  // Revogação de sessões: tokens emitidos antes do corte são recusados.
  if (claims.iat < user.sessions_valid_after) throw new HttpError(401, "session_revoked", "Sessão revogada");

  c.set("claims", claims);
  c.set("user", user);
  await next();
});

/** Resolve o contexto de organização a partir dos VÍNCULOS do usuário; o ID da URL nunca autoriza por si. */
export const requireOrg = createMiddleware<AppEnv>(async (c, next) => {
  const orgId = c.req.param("orgId");
  const user = c.get("user");
  if (!orgId) throw notFound();

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.unit_id, m.role, m.can_receive_payments
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active' AND o.status = 'active'`,
  )
    .bind(orgId, user.id)
    .all<MembershipCtx>();

  // Sem vínculo (ou organização de outro tenant): 404, sem revelar que o ID existe.
  if (results.length === 0) throw notFound();
  c.set("org", { id: orgId, memberships: results });
  await next();
});
