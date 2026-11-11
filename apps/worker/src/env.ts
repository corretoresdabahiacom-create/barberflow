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
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
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
}
