import { Hono } from "hono";
import { z } from "zod";
import { PAYMENT_METHODS } from "@naregua/shared";
import type { AppEnv } from "../auth/middleware";
import { can, requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { getAppointment } from "../domain/booking";
import { HttpError, forbidden, notFound, parseBody } from "../lib/http";
import { isoNow, newId } from "../lib/util";

export const paymentRoutes = new Hono<AppEnv>();

const payBody = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    amountCents: z.number().int().min(1).max(100_000_000),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

interface PayRow {
  id: string;
  appointment_id: string;
  method: string;
  amount_cents: number;
  received_at: string;
}

// Registro MANUAL de recebimento. A Fase 1 não confirma Pix/cartão automaticamente.
paymentRoutes.post("/appointments/:id/payments", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const key = c.req.header("idempotency-key") ?? "";
  if (key.length < 8 || key.length > 100 || !/^[A-Za-z0-9_\-:.]+$/.test(key)) {
    throw new HttpError(400, "idempotency_key_required", "Cabeçalho Idempotency-Key obrigatório (8–100 caracteres)");
  }
  const appt = await getAppointment(c.env.DB, org.id, c.req.param("id"));
  requirePerm(org, "payment.create", appt.unit_id);
  // Profissional só com a flag de recebimento: apenas nos próprios atendimentos.
  if (!can(org, "agenda.write", appt.unit_id)) {
    const pro = await c.env.DB.prepare("SELECT user_id FROM professionals WHERE organization_id = ? AND id = ?")
      .bind(org.id, appt.professional_id)
      .first<{ user_id: string | null }>();
    if (pro?.user_id !== user.id) throw forbidden();
  }
  const b = await parseBody(c, payBody);
  if (appt.status !== "confirmed" && appt.status !== "completed") {
    throw new HttpError(409, "not_payable", "Só é possível registrar pagamento de atendimento confirmado ou concluído");
  }

  const existing = await c.env.DB.prepare("SELECT id, appointment_id, method, amount_cents, received_at FROM payments WHERE organization_id = ? AND idempotency_key = ?")
    .bind(org.id, key)
    .first<PayRow>();
  const replay = (p: PayRow) => {
    if (p.appointment_id !== appt.id || p.method !== b.method || p.amount_cents !== b.amountCents) {
      throw new HttpError(409, "idempotency_conflict", "Esta chave já foi usada com outros dados");
    }
    return c.json({ payment: { id: p.id, method: p.method, amountCents: p.amount_cents, receivedAt: p.received_at }, replayed: true }, 200);
  };
  if (existing) return replay(existing);

  const now = isoNow(c.get("deps").now());
  const pid = newId();
  // Insert condicional e atômico: só grava se (já pago + valor) <= total do atendimento.
  let changes = 0;
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO payments (id, organization_id, unit_id, appointment_id, customer_id, method, amount_cents, received_at, idempotency_key, note, created_by_user_id, created_at)
         SELECT ?, a.organization_id, a.unit_id, a.id, a.customer_id, ?, ?, ?, ?, ?, ?, ?
           FROM appointments a
          WHERE a.organization_id = ? AND a.id = ?
            AND (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.organization_id = a.organization_id AND p.appointment_id = a.id) + ? <= a.total_cents`,
      ).bind(pid, b.method, b.amountCents, now, key, b.note ?? null, user.id, now, org.id, appt.id, b.amountCents),
    ]);
    changes = res[0]?.meta.changes ?? 0;
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: payments")) {
      const again = await c.env.DB.prepare("SELECT id, appointment_id, method, amount_cents, received_at FROM payments WHERE organization_id = ? AND idempotency_key = ?")
        .bind(org.id, key)
        .first<PayRow>();
      if (again) return replay(again);
    }
    throw e;
  }
  if (changes === 0) throw new HttpError(409, "overpayment", "O valor ultrapassa o total do atendimento");

  await c.env.DB.batch([
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "payment.recorded", entity: "payment", entityId: pid, details: { appointmentId: appt.id, method: b.method, amountCents: b.amountCents }, now }),
  ]);
  return c.json({ payment: { id: pid, method: b.method, amountCents: b.amountCents, receivedAt: now }, replayed: false }, 201);
});

paymentRoutes.get("/appointments/:id/payments", async (c) => {
  const org = c.get("org");
  const appt = await getAppointment(c.env.DB, org.id, c.req.param("id"));
  if (!can(org, "agenda.read", appt.unit_id) && !can(org, "payment.create", appt.unit_id)) throw notFound();
  const { results } = await c.env.DB.prepare(
    "SELECT id, method, amount_cents, received_at, note FROM payments WHERE organization_id = ? AND appointment_id = ? ORDER BY received_at",
  )
    .bind(org.id, appt.id)
    .all();
  return c.json({ payments: results, totalCents: appt.total_cents });
});
