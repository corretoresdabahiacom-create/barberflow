import type { AppDeps, Env } from "../env";
import { makeUnsubToken } from "../lib/unsub";
import { isoNow, newId, toIso } from "../lib/util";

/** Teto diário de destinatários por organização (protege a cota gratuita do provedor de e-mail e evita spam). */
export const CAMPAIGN_DAILY_CAP = 200;

export interface Segment {
  segment: "all_consented" | "inactive";
  inactiveDays: number | null;
}

/**
 * Público da campanha: cliente ativo, com e-mail, com consentimento de MARKETING por e-mail VIGENTE
 * (opt-in explícito: sem registro = não recebe). "inactive" = tem atendimento concluído, mas nenhum nos últimos N dias.
 */
export function audienceSql(seg: Segment, nowMs: number): { from: string; binds: (string | number)[] } {
  let from = `FROM customers c
    WHERE c.organization_id = ? AND c.status = 'active' AND c.email_norm IS NOT NULL
      AND COALESCE((SELECT k.granted FROM customer_consents k
                     WHERE k.organization_id = c.organization_id AND k.customer_id = c.id AND k.purpose = 'marketing' AND k.channel = 'email'
                     ORDER BY k.created_at DESC, k.rowid DESC LIMIT 1), 0) = 1`;
  const binds: (string | number)[] = [];
  if (seg.segment === "inactive") {
    const cutoff = toIso(nowMs - (seg.inactiveDays ?? 60) * 86400_000);
    from += `
      AND EXISTS (SELECT 1 FROM appointments a WHERE a.organization_id = c.organization_id AND a.customer_id = c.id AND a.status = 'completed')
      AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.organization_id = c.organization_id AND a.customer_id = c.id AND a.status = 'completed' AND a.starts_at >= ?)`;
    binds.push(cutoff);
  }
  return { from, binds };
}

export const firstName = (n: string): string => n.trim().split(/\s+/)[0] ?? n;

export function marketingConfigured(env: Env, deps: AppDeps): boolean {
  return Boolean(env.UNSUBSCRIBE_SECRET && env.PUBLIC_BASE_URL && deps.email.enabled(env));
}

export async function buildCampaignEmail(env: Env, orgName: string, c: { subject: string; body: string }, cust: { id: string; name: string; orgId: string }) {
  const token = await makeUnsubToken(env.UNSUBSCRIBE_SECRET!, cust.orgId, cust.id);
  const base = env.PUBLIC_BASE_URL!.replace(/\/+$/, "");
  const humanUrl = `${base}/sair?t=${token}`;
  const body = [
    c.body.replaceAll("{{nome}}", firstName(cust.name)),
    "",
    "—",
    `Você recebe este e-mail porque autorizou receber novidades de ${orgName}.`,
    `Para não receber mais, acesse: ${humanUrl}`,
  ].join("\n");
  return { subject: c.subject.replaceAll("{{nome}}", firstName(cust.name)), body, unsubscribeUrl: `${base}/api/public/unsubscribe?t=${token}` };
}

export { isoNow, newId };
