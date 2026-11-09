import { createApp } from "./app";
import { verifyFirebaseToken } from "./auth/firebase";
import type { AppDeps, Env } from "./env";

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

const deps: AppDeps = {
  verifyToken: verifyFirebaseToken,
  verifyTurnstile,
  now: () => new Date(),
};

const app = createApp(deps);

export default app;
