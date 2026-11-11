import type { AppDeps, Env } from "../env";
import { isoNow, newId, toIso } from "../lib/util";

/**
 * Lembretes por e-mail via outbox (fila no D1) processada por cron.
 * - Só enfileira se a organização ligou `reminders_enabled`, o cliente informou e-mail ao agendar, NÃO registrou
 *   opt-out vigente (service_notifications/email com granted=0) e o provedor de e-mail está configurado.
 *   Lembrete de agendamento é mensagem de serviço (execução do contrato), não marketing; base legal a validar com advogado.
 * - `dedupe_key` UNIQUE: um lembrete por agendamento, mesmo se o cron rodar duas vezes.
 * - Envio com "lease" (claim atômico), até 5 tentativas com backoff exponencial, no máximo 20 envios por execução
 *   (limite de 50 subrequests por invocação no plano Free).
 */
export const MAX_ATTEMPTS = 5;
export const SEND_BATCH = 20;
const ENQUEUE_BATCH = 50;
const LEASE_MS = 10 * 60_000;

interface Candidate {
  appointment_id: string;
  organization_id: string;
  customer_id: string;
  customer_name: string;
  email: string;
  starts_at: string;
  timezone: string;
  unit_name: string;
  unit_phone: string | null;
  org_name: string;
}

export function reminderMessage(c: Candidate): { subject: string; body: string } {
  const when = new Intl.DateTimeFormat("pt-BR", { timeZone: c.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date(c.starts_at));
  const first = c.customer_name.split(" ")[0] ?? c.customer_name;
  return {
    subject: `Lembrete: seu horário na ${c.org_name} é ${when}`,
    body: [
      `Olá, ${first}!`,
      "",
      `Lembrando do seu horário na ${c.org_name} (${c.unit_name}): ${when}.`,
      c.unit_phone ? `Precisa remarcar ou cancelar? Fale com a unidade: ${c.unit_phone}.` : "Precisa remarcar ou cancelar? Fale com a unidade.",
      "",
      "Você recebe este aviso por ter agendado conosco. Para deixar de receber lembretes, peça à barbearia para registrar a sua preferência.",
    ].join("\n"),
  };
}

/** Enfileira lembretes de confirmados que começam entre +2h e +24h. Retorna quantos foram enfileirados. */
export async function enqueueReminders(db: D1Database, nowMs: number): Promise<number> {
  const from = toIso(nowMs + 2 * 3600_000);
  const to = toIso(nowMs + 24 * 3600_000);
  const { results } = await db
    .prepare(
      `SELECT a.id AS appointment_id, a.organization_id, c.id AS customer_id, c.name AS customer_name, c.email AS email, a.starts_at,
              u.timezone, u.name AS unit_name, u.phone AS unit_phone, o.name AS org_name
         FROM appointments a
         JOIN organizations o ON o.id = a.organization_id AND o.reminders_enabled = 1 AND o.status = 'active'
         JOIN customers c ON c.organization_id = a.organization_id AND c.id = a.customer_id AND c.status = 'active' AND c.email IS NOT NULL
         JOIN units u ON u.organization_id = a.organization_id AND u.id = a.unit_id
        WHERE a.status = 'confirmed' AND a.starts_at > ? AND a.starts_at <= ? -- tenant-ok: varredura global do cron; cada linha carrega o próprio organization_id
          AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.dedupe_key = 'reminder24h:' || a.id)
          AND COALESCE((SELECT k.granted FROM customer_consents k
                         WHERE k.organization_id = a.organization_id AND k.customer_id = c.id AND k.purpose = 'service_notifications' AND k.channel = 'email'
                         ORDER BY k.created_at DESC, k.rowid DESC LIMIT 1), 1) = 1
        ORDER BY a.starts_at LIMIT ?`,
    )
    .bind(from, to, ENQUEUE_BATCH)
    .all<Candidate>();
  if (results.length === 0) return 0;
  const now = isoNow(new Date(nowMs));
  const stmts = results.map((r) => {
    const m = reminderMessage(r);
    return db
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, organization_id, customer_id, appointment_id, kind, to_email, subject, body, status, attempts, next_attempt_at, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, 'reminder', ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .bind(newId(), r.organization_id, r.customer_id, r.appointment_id, r.email, m.subject, m.body, now, `reminder24h:${r.appointment_id}`, now);
  });
  await db.batch(stmts);
  return stmts.length;
}

const backoffMs = (attempts: number): number => Math.min(5 * 60_000 * 2 ** (attempts - 1), 6 * 3600_000);

export interface DispatchResult { sent: number; retried: number; failed: number; skipped: number }

/** Envia pendentes vencidos. Um agendamento que deixou de estar confirmado vira `skipped` (sem enviar). */
export async function dispatchOutbox(db: D1Database, env: Env, deps: AppDeps, nowMs: number): Promise<DispatchResult> {
  const out: DispatchResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  const now = isoNow(new Date(nowMs));
  const { results } = await db
    .prepare("SELECT id, to_email, subject, body, attempts, appointment_id, organization_id, kind, customer_id, unsubscribe_url FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?") // tenant-ok: fila global processada pelo cron; cada linha carrega organization_id
    .bind(now, SEND_BATCH)
    .all<{ id: string; to_email: string; subject: string; body: string; attempts: number; appointment_id: string | null; organization_id: string; kind: string; customer_id: string | null; unsubscribe_url: string | null }>();

  for (const m of results) {
    // lease: só quem conseguir avançar next_attempt_at processa esta mensagem
    const claim = await db
      .prepare("UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?") // tenant-ok: chave primária da fila, linha já carregada com seu organization_id
      .bind(toIso(nowMs + LEASE_MS), m.id, now)
      .run();
    if ((claim.meta.changes ?? 0) === 0) continue;
    const attempts = m.attempts + 1;

    if (m.appointment_id) {
      const still = await db
        .prepare("SELECT 1 AS ok FROM appointments WHERE organization_id = ? AND id = ? AND status = 'confirmed'")
        .bind(m.organization_id, m.appointment_id)
        .first();
      if (!still) {
        await db.prepare("UPDATE outbox SET status = 'skipped', last_error = 'appointment_not_confirmed' WHERE id = ?").bind(m.id).run(); // tenant-ok: chave primária da fila
        out.skipped++;
        continue;
      }
    }
    if (m.kind === "campaign" && m.customer_id) {
      // o cliente pode ter se descadastrado depois do enfileiramento: o consentimento vigente é rechecado no envio
      const consent = await db
        .prepare(
          `SELECT granted FROM customer_consents WHERE organization_id = ? AND customer_id = ? AND purpose = 'marketing' AND channel = 'email'
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .bind(m.organization_id, m.customer_id)
        .first<{ granted: number }>();
      if (consent?.granted !== 1) {
        await db.prepare("UPDATE outbox SET status = 'skipped', last_error = 'consent_revoked' WHERE id = ?").bind(m.id).run(); // tenant-ok: chave primária da fila
        out.skipped++;
        continue;
      }
    }
    try {
      await deps.email.send({ to: m.to_email, subject: m.subject, body: m.body, unsubscribeUrl: m.unsubscribe_url }, env);
      await db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(now, m.id).run(); // tenant-ok: chave primária da fila
      out.sent++;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : "send_failed").slice(0, 200);
      if (attempts >= MAX_ATTEMPTS) {
        await db.prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?").bind(msg, m.id).run(); // tenant-ok: chave primária da fila
        out.failed++;
      } else {
        await db.prepare("UPDATE outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?").bind(toIso(nowMs + backoffMs(attempts)), msg, m.id).run(); // tenant-ok: chave primária da fila
        out.retried++;
      }
    }
  }
  return out;
}

export async function runScheduled(env: Env, deps: AppDeps): Promise<{ enqueued: number } & DispatchResult> {
  const nowMs = deps.now().getTime();
  // Sem provedor de e-mail configurado: nada é enfileirado nem enviado (recurso desligado).
  if (!deps.email.enabled(env)) return { enqueued: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const enqueued = await enqueueReminders(env.DB, nowMs);
  const d = await dispatchOutbox(env.DB, env, deps, nowMs);
  return { enqueued, ...d };
}
