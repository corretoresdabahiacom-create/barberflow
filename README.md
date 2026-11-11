# NaRégua

SaaS de agenda e gestão para barbearias: **painel administrativo** + **PWA do cliente** (reserva por QR Code/link, sem baixar app).

> Estado atual: **Fases 1, 2 e 3 implementadas e testadas localmente. Nada foi publicado (deploy não realizado).** Veja [PROJECT_STATUS.md](PROJECT_STATUS.md) — fonte da verdade sobre o que existe, o que foi testado e o que falta.

## Stack (100% plano gratuito para começar)
| Camada | Tecnologia |
|---|---|
| API + hospedagem do front | Cloudflare Workers (Hono, TypeScript) + Workers Static Assets |
| Banco | Cloudflare D1 (SQLite) |
| Login | Firebase Authentication (Spark) — o Worker só verifica o ID token |
| Anti-robô | Cloudflare Turnstile |
| Front | React 19 + Vite + Tailwind 4, PWA com service worker próprio |
| Backup | GitHub Actions → arquivo criptografado → Google Drive |

## Estrutura
```
apps/worker   API (Hono) + migrations D1 + testes (Vitest em workerd)
apps/web      SPA/PWA (React)
packages/shared  permissões, normalização de telefone/e-mail, formatação
docs/         arquitetura, isolamento, segurança, custos, backup, testes…
scripts/      envio de backup ao Google Drive
```

## Rodar localmente
```bash
corepack enable && pnpm install
pnpm test                 # 156 testes da API (workerd + D1 local)
pnpm typecheck && pnpm build
cd apps/worker && pnpm db:migrate:local
# terminal 1:  pnpm dev:worker      (http://localhost:8787, serve também o front buildado)
# terminal 2:  pnpm dev:web         (http://localhost:5173 com proxy para /api)
```
Login e reserva pública exigem configuração externa (Firebase e Turnstile): [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md). Sem ela o app mostra estados "configuração pendente" — nunca finge funcionar.

## Documentação
[ARCHITECTURE](docs/ARCHITECTURE.md) · [ISOLATION](docs/ISOLATION.md) · [DATABASE](docs/DATABASE.md) · [PERMISSIONS](docs/PERMISSIONS.md) · [SECURITY](docs/SECURITY.md) · [INFRASTRUCTURE](docs/INFRASTRUCTURE.md) · [COSTS](docs/COSTS.md) · [BACKUP-RESTORE](docs/BACKUP-RESTORE.md) · [TEST-PLAN](docs/TEST-PLAN.md) · [BRAND-REVIEW](docs/BRAND-REVIEW.md) · [LEGAL](docs/LEGAL.md) · [ROADMAP](docs/ROADMAP.md) · [DECISIONS](DECISIONS.md)
