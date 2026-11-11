import { createApp } from "./app";
import { verifyFirebaseToken } from "./auth/firebase";
import { runScheduled } from "./domain/outbox";
import type { AppDeps, EmailSender, Env, PushSender } from "./env";
import { createAiClient } from "./lib/ai";
import { encryptPayload, vapidAuthHeader } from "./lib/webpush";

/** Cloudflare Turnstile. Falha FECHADA: sem segredo configurado, nenhuma reserva pública é aceita. */
async function verifyTurnstile(token: string | undefined, ip: string | null, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY || !token) return false;
  try {
    const form = new FormData();
    form.set("secret", env.TURNSTILE_SECRET_KEY);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Provedor de e-mail por HTTP (formato compatível com a API do Resend).
 * ATENÇÃO: nunca testado contra um provedor real nesta fase — só ativa com EMAIL_API_KEY + EMAIL_FROM configurados.
 */
const email: EmailSender = {
  enabled: (env) => Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM),
  send: async (msg, env) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.body,
        ...(msg.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${msg.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`email_provider_${res.status}`);
  },
};

/** Web Push direto aos serviços de push (FCM/Mozilla/Apple/WNS). NUNCA testado contra um serviço real. */
const push: PushSender = {
  enabled: (env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
  send: async (sub, payload, env) => {
    const body = await encryptPayload(new TextEncoder().encode(payload), sub.p256dh, sub.auth);
    const authorization = await vapidAuthHeader(sub.endpoint, env.VAPID_SUBJECT!, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!, Math.floor(Date.now() / 1000));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { authorization, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "3600", urgency: "normal" },
      body,
    });
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) throw new Error(`push_service_${res.status}`);
    return "ok";
  },
};

const deps: AppDeps = {
  verifyToken: verifyFirebaseToken,
  verifyTurnstile,
  now: () => new Date(),
  email,
  push,
  ai: createAiClient(),
};

const app = createApp(deps);

export default {
  fetch: app.fetch,
  // Cron (a cada 15 min): enfileira e envia lembretes. Falhas não derrubam o isolate.
  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, deps).then(() => undefined, (e) => console.error("scheduled_failed", e instanceof Error ? e.message : "unknown")));
  },
};
