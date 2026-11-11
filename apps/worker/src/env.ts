export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ENVIRONMENT: string;
  APP_NAME: string;
  FIREBASE_PROJECT_ID: string;
  TURNSTILE_SITE_KEY: string;
  /** Segredo do Turnstile: definir com `wrangler secret put`. Nunca em vars/repositório. */
  TURNSTILE_SECRET_KEY?: string;
  /** Origens permitidas para CORS, separadas por vírgula. Vazio = mesma origem apenas. */
  ALLOWED_ORIGINS: string;
  /** Provedor de e-mail transacional (HTTP). Opcionais: sem eles, lembretes ficam desligados. Segredo via `wrangler secret put`. */
  EMAIL_API_KEY?: string;
  /** Remetente verificado no provedor, ex.: "NaRégua <avisos@seudominio.com.br>". */
  EMAIL_FROM?: string;
  /** Web Push (VAPID). Gere com `node scripts/gen-vapid.mjs`. Privada = segredo (`wrangler secret put`). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Contato do remetente exigido pelo VAPID, ex.: "mailto:contato@seudominio.com.br". */
  VAPID_SUBJECT?: string;
  /** Segredo para assinar links de descadastro (HMAC). Sem ele, campanhas ficam desligadas. */
  UNSUBSCRIBE_SECRET?: string;
  /** URL pública do app (https://...), usada nos links dos e-mails de campanha. */
  PUBLIC_BASE_URL?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** Link de descadastro de 1 clique (campanhas): vira cabeçalho List-Unsubscribe. */
  unsubscribeUrl?: string | null;
}

export interface PushSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSender {
  enabled: (env: Env) => boolean;
  /** "gone" = assinatura expirada (404/410): será apagada. Outros erros lançam. */
  send: (sub: PushSub, payload: string, env: Env) => Promise<"ok" | "gone">;
}

export interface EmailSender {
  enabled: (env: Env) => boolean;
  /** Lança erro se o envio falhar (o outbox faz retry/backoff). */
  send: (msg: EmailMessage, env: Env) => Promise<void>;
}

export interface TokenClaims {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** Instante de emissão (epoch segundos). */
  iat: number;
}

export interface AppDeps {
  verifyToken: (token: string, env: Env) => Promise<TokenClaims | null>;
  verifyTurnstile: (token: string | undefined, ip: string | null, env: Env) => Promise<boolean>;
  now: () => Date;
  email: EmailSender;
  push: PushSender;
}
