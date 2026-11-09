import { newId } from "./util";

export interface AuditInput {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  now: string;
}

export function auditStmt(db: D1Database, a: AuditInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs (id, organization_id, actor_user_id, action, entity, entity_id, details, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      a.orgId,
      a.actorUserId,
      a.action,
      a.entity,
      a.entityId ?? null,
      a.details ? JSON.stringify(a.details) : null,
      a.ip ?? null,
      a.now,
    );
}

export async function audit(db: D1Database, a: AuditInput): Promise<void> {
  await auditStmt(db, a).run();
}

export function notifyStmt(
  db: D1Database,
  n: { userId: string; orgId: string | null; kind: string; title: string; body?: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, organization_id, kind, title, body, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(newId(), n.userId, n.orgId, n.kind, n.title, n.body ?? null, n.now);
}

/** Quem da equipe deve ser avisado sobre um agendamento: donos, admins/gerentes da unidade e o profissional. */
export async function staffToNotify(
  db: D1Database,
  orgId: string,
  unitId: string,
  professionalId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id FROM memberships
        WHERE organization_id = ? AND status = 'active' AND user_id IS NOT NULL
          AND (role = 'owner' OR (unit_id = ? AND role IN ('unit_admin','manager')))
       UNION
       SELECT user_id FROM professionals
        WHERE organization_id = ? AND id = ? AND user_id IS NOT NULL`,
    )
    .bind(orgId, unitId, orgId, professionalId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}
