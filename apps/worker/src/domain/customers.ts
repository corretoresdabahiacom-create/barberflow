import { normalizeEmail, normalizePhone } from "@naregua/shared";
import { HttpError } from "../lib/http";
import { newId } from "../lib/util";

export interface ContactInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

/**
 * Localiza cliente da organização pelo telefone normalizado (cliente mais antigo) ou cria um novo.
 * Nunca sobrescreve dados de um cliente existente: quem agenda sem login não altera cadastro de terceiros.
 */
export async function findOrCreateCustomer(
  db: D1Database,
  orgId: string,
  c: ContactInput,
  now: string,
): Promise<{ id: string; created: boolean }> {
  const phoneNorm = normalizePhone(c.phone);
  const emailNorm = normalizeEmail(c.email);
  if (!phoneNorm) throw new HttpError(400, "validation_error", "Telefone inválido (informe DDD + número)");

  const existing = await db
    .prepare(
      `SELECT id FROM customers
        WHERE organization_id = ? AND phone_norm = ? AND status = 'active'
        ORDER BY created_at LIMIT 1`,
    )
    .bind(orgId, phoneNorm)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };

  const id = newId();
  await db
    .prepare(
      `INSERT INTO customers (id, organization_id, name, phone, phone_norm, email, email_norm, status, no_show_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    )
    .bind(id, orgId, c.name.trim(), c.phone ?? null, phoneNorm, c.email?.trim() ?? null, emailNorm, now, now)
    .run();
  return { id, created: true };
}

export function consentStmts(
  db: D1Database,
  orgId: string,
  customerId: string,
  channels: { email: boolean; whatsapp: boolean },
  granted: boolean,
  source: string,
  now: string,
  purpose: "marketing" | "service_notifications" = "marketing",
): D1PreparedStatement[] {
  const rows: D1PreparedStatement[] = [];
  const add = (channel: string) =>
    rows.push(
      db
        .prepare(
          `INSERT INTO customer_consents (id, organization_id, customer_id, purpose, channel, granted, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId(), orgId, customerId, purpose, channel, granted ? 1 : 0, source, now),
    );
  if (channels.email) add("email");
  if (channels.whatsapp) add("whatsapp");
  return rows;
}
