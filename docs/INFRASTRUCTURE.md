# Infraestrutura — passo a passo (nada disso foi executado por mim)

Eu **não tenho credenciais** de Cloudflare, Firebase ou Google. Estes são os passos para você fazer o primeiro deploy. Todos usam planos gratuitos.

## 1. Firebase (login)
1. Console Firebase → criar projeto (plano **Spark**).
2. Authentication → habilitar **E-mail/senha** e **Google**. *Não* habilitar telefone (exige Blaze).
3. Authentication → Settings → Authorized domains: adicionar o host `*.workers.dev` do seu Worker (ou o domínio próprio).
4. Project settings → Web app → copiar `apiKey`, `authDomain`, `projectId`, `appId` para `apps/web/.env.local` (ver `.env.example`).
5. `FIREBASE_PROJECT_ID` em `apps/worker/wrangler.jsonc` (vars) = o mesmo `projectId`.

## 2. Cloudflare
```bash
cd apps/worker
npx wrangler login
npx wrangler d1 create naregua-db          # copie o database_id para wrangler.jsonc
pnpm db:migrate:remote
npx wrangler secret put TURNSTILE_SECRET_KEY
```
Lembretes por e-mail (opcional, Fase 2): `npx wrangler secret put EMAIL_API_KEY` e definir `EMAIL_FROM` em `vars` (remetente verificado no provedor; o código usa o formato da API do Resend). O cron `*/15 * * * *` já está em `wrangler.jsonc`. Sem esses dois valores o recurso fica inerte. Depois, o proprietário liga em Painel → Automação. **Nunca testado com provedor real.**

Web Push (opcional, Fase 3): `node scripts/gen-vapid.mjs`; `npx wrangler secret put VAPID_PRIVATE_KEY`; `VAPID_PUBLIC_KEY` e `VAPID_SUBJECT` (ex.: `mailto:contato@seudominio.com.br`) em `vars`. O front busca a chave pública pela API — não há variável `VITE_`. **Nunca testado contra FCM/Mozilla/Apple.**

Campanhas (opcional): além do e-mail acima, `npx wrangler secret put UNSUBSCRIBE_SECRET` (string longa e aleatória; **trocá-la invalida os links de descadastro já enviados** — não troque depois de enviar) e `PUBLIC_BASE_URL` (`https://seu-host`) em `vars`.

Turnstile: dashboard → Turnstile → novo widget (modo gerenciado) → `site key` em `TURNSTILE_SITE_KEY` (wrangler.jsonc vars) **e** `VITE_TURNSTILE_SITE_KEY` (front); `secret key` só via `wrangler secret`.

## 3. Build e deploy
```bash
pnpm build                      # gera apps/web/dist
cd apps/worker && npx wrangler deploy
```
O Worker serve `/api/*` e, para o resto, os arquivos de `apps/web/dist` (com `_headers`, CSP incluída).

## 4. Depois do primeiro deploy (obrigatório validar)
- Repetir manualmente o teste de atomicidade do `batch` no D1 remoto (ADR-010).
- Medir CPU por requisição no dashboard (limite Free ≈ 10 ms) em `POST /api/public/units/:slug/appointments` e em rotas autenticadas.
- Conferir se a CSP não bloqueia o login do Firebase/Google (ajustar `public/_headers` se necessário).
- Criar a primeira organização e testar reserva pública ponta a ponta com Turnstile real.

## 5. GitHub Actions
CI (`ci.yml`) roda sem segredos. Backup (`backup.yml`): ver BACKUP-RESTORE.md.

IA (opcional, Fase 4): veja docs/AI.md. `npx wrangler secret put GEMINI_API_KEY` (e/ou `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`+`XAI_MODEL`); o binding `AI` do Workers AI já está em `wrangler.jsonc` (exige conta Cloudflare; cota grátis 10.000 Neurons/dia). Administração da plataforma: defina `PLATFORM_ADMIN_EMAILS` (seu e-mail verificado) em `vars` e abra `/plataforma`. **Nada disso foi exercitado contra serviços reais.**
