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
  /** E-mails (verificados) dos administradores da plataforma, separados por vírgula. Vazio = ninguém. */
  PLATFORM_ADMIN_EMAILS?: string;
  /** IA assistiva — todas opcionais; um provedor só entra na cadeia se a chave existir. Chaves via `wrangler secret put`. */
  AI_PROVIDER_ORDER?: string; // ex.: "gemini,groq,openrouter,workers-ai,xai" (padrão)
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  XAI_API_KEY?: string; // Grok: API paga (sem camada gratuita publicada) — só entra se você configurar a chave
  XAI_MODEL?: string; // obrigatório para o xAI entrar na cadeia (nome do modelo muda com frequência)
  /** Binding do Cloudflare Workers AI (cota gratuita diária da conta). */
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  WORKERS_AI_MODEL?: string;
}

export interface AiRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface AiResult {
  text: string;
  provider: string;
}

/** Cadeia de provedores de IA com fallback. Lança `Error("ai_unavailable")` se todos falharem. */
export interface AiClient {
  /** Provedores configurados (ordem da cadeia). Nunca expõe chaves. */
  available: (env: Env) => string[];
  generate: (req: AiRequest, env: Env) => Promise<AiResult>;
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
  ai: AiClient;
}
