/**
 * Papéis e permissões. Fonte única usada pelo Worker (autorização real)
 * e pelo frontend (apenas para mostrar/esconder elementos; nunca autoriza).
 */
export const ROLES = ["owner", "unit_admin", "manager", "barber"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "org.manage",
  "unit.manage",
  "user.manage",
  "catalog.read",
  "catalog.write",
  "agenda.read",
  "agenda.write",
  "agenda.read_own",
  "agenda.write_own",
  "customer.read",
  "customer.write",
  "payment.create",
  "report.read",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  unit_admin: [
    "unit.manage",
    "catalog.read",
    "catalog.write",
    "agenda.read",
    "agenda.write",
    "customer.read",
    "customer.write",
    "payment.create",
    "report.read",
  ],
  manager: [
    "catalog.read",
    "agenda.read",
    "agenda.write",
    "customer.read",
    "customer.write",
    "report.read",
  ],
  barber: ["catalog.read", "agenda.read_own", "agenda.write_own"],
};

/** Permissões que só valem com vínculo da organização inteira (unit_id nulo). */
export const ORG_LEVEL_PERMISSIONS: readonly Permission[] = [
  "org.manage",
  "user.manage",
  "audit.read",
];

export const APPOINTMENT_STATUSES = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "pix", "debit", "credit", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
