import type { AppDeps, Env, PushSub } from "../env";

export interface PushPayload {
  title: string;
  body: string;
  /** caminho interno aberto ao tocar na notificação */
  url: string;
}

/**
 * Envio de Web Push "melhor esforço" (não bloqueia a resposta, não faz retry): a notificação interna
 * e o chat continuam existindo no banco; o push apenas avisa. Assinaturas expiradas (404/410) são apagadas.
 */
export async function pushToUsers(env: Env, deps: AppDeps, userIds: string[], payload: PushPayload): Promise<void> {
  try {
    if (userIds.length === 0 || !deps.push.enabled(env)) return;
    const uniq = [...new Set(userIds)].slice(0, 20);
    const { results } = await env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${uniq.map(() => "?").join(",")}) LIMIT 30`,
    )
      .bind(...uniq)
      .all<PushSub>();
    const msg = JSON.stringify({ title: payload.title.slice(0, 80), body: payload.body.slice(0, 160), url: payload.url });
    for (const sub of results) {
      try {
        if ((await deps.push.send(sub, msg, env)) === "gone") {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
        }
      } catch (e) {
        console.error("push_failed", e instanceof Error ? e.message : "unknown");
      }
    }
  } catch (e) {
    console.error("push_failed", e instanceof Error ? e.message : "unknown");
  }
}

/** Roda em segundo plano quando há ExecutionContext (produção); em testes aguarda para ficar determinístico. */
export async function background(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, p: Promise<unknown>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (ctx) ctx.waitUntil(p);
  else await p;
}
