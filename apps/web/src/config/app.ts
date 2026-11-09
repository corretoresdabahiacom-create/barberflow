/** Configuração editável do produto. Nada aqui é segredo (vai para o navegador). */
export const APP_NAME = import.meta.env.VITE_APP_NAME || "NaRégua";
export const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || "";

/** Dados do controlador para os documentos legais. Preencha antes de publicar. */
export const OPERATOR = {
  name: import.meta.env.VITE_OPERATOR_NAME || "[RAZÃO SOCIAL — PREENCHER]",
  document: import.meta.env.VITE_OPERATOR_DOCUMENT || "[CNPJ — PREENCHER]",
  contactEmail: import.meta.env.VITE_PRIVACY_EMAIL || "[E-MAIL DO ENCARREGADO/CONTATO LGPD — PREENCHER]",
};

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};
export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);
export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || "";
