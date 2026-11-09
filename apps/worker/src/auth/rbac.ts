import { ORG_LEVEL_PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from "@naregua/shared";
import { forbidden } from "../lib/http";

export interface MembershipCtx {
  id: string;
  unit_id: string | null;
  role: Role;
  can_receive_payments: number;
}

export interface OrgContext {
  id: string;
  memberships: MembershipCtx[];
}

function grants(m: MembershipCtx, perm: Permission): boolean {
  if (ROLE_PERMISSIONS[m.role].includes(perm)) return true;
  return perm === "payment.create" && m.can_receive_payments === 1;
}

/** `unitId` ausente = "em alguma unidade a que pertenço" (listas filtram depois por allowedUnits). */
export function can(org: OrgContext, perm: Permission, unitId?: string | null): boolean {
  const orgLevel = ORG_LEVEL_PERMISSIONS.includes(perm);
  for (const m of org.memberships) {
    if (!grants(m, perm)) continue;
    if (m.unit_id === null) return true; // vínculo da organização inteira (owner)
    if (orgLevel) continue; // permissões de organização exigem vínculo org-wide
    if (unitId == null || m.unit_id === unitId) return true;
  }
  return false;
}

export function requirePerm(org: OrgContext, perm: Permission, unitId?: string | null): void {
  if (!can(org, perm, unitId)) throw forbidden();
}

/** Unidades em que o usuário tem a permissão: "all" ou lista. */
export function allowedUnits(org: OrgContext, perm: Permission): "all" | string[] {
  const ids = new Set<string>();
  for (const m of org.memberships) {
    if (!grants(m, perm)) continue;
    if (m.unit_id === null) return "all";
    ids.add(m.unit_id);
  }
  return [...ids];
}
