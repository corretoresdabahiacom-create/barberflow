# Arquitetura

```
Navegador (PWA React) ──HTTPS──▶ Cloudflare Worker (Hono)
   │  Firebase Auth SDK                │  /api/*  → rotas
   │  (login, ID token)                │  demais  → Static Assets (SPA, fallback index.html)
   └──────────ID token (Bearer)────────┤
                                       ├─ verifica JWT (JWKS Google, WebCrypto)
                                       ├─ D1 (SQLite) — único caminho de acesso aos dados
                                       └─ Turnstile siteverify (reserva pública)
```

## Camadas do Worker (`apps/worker/src`)
- `app.ts` — monta o Hono: cabeçalhos de segurança, CORS por lista, limite de corpo (64 KB), erros JSON sem vazar detalhes. `createApp(deps)` recebe dependências injetáveis (`verifyToken`, `verifyTurnstile`, `now`) — os testes injetam um verificador com **o mesmo código de verificação**, mudando só a origem das chaves públicas; não existe backdoor em produção.
- `index.ts` — fiação de produção (token Firebase real, Turnstile real que **falha fechado** sem segredo).
- `auth/` — verificação do token, `requireAuth` (usuário local, suspensão, revogação de sessões), `requireOrg` (tenant derivado dos vínculos do usuário, 404 se não houver), RBAC.
- `domain/` — disponibilidade (função pura), reserva/remarcação/cancelamento/transições, clientes.
- `routes/` — `public` (sem login), `me` (cliente logado), `orgs` + `catalog`, `agenda`, `customers`, `payments`, `reports` (painel, sob `/api/orgs/:orgId`).

## Fluxo de reserva
1. Disponibilidade = expediente − bloqueios − blocos já ocupados − antecedência mínima (puro, testado).
2. `createAppointment` revalida e grava, em **um batch**: agendamento, itens (preço/duração copiados), `appointment_slots` (um por bloco de 5 min), histórico, auditoria, notificações.
3. Se duas pessoas pegam o mesmo horário, a PK `(professional_id, slot)` rejeita a segunda → 409 `slot_taken` e o batch inteiro é desfeito.

## Limites do plano Free que moldam o código
10 ms de CPU/requisição (sem hash de senha, sem criptografia pesada), 50 subrequests, 100 mil req/dia, D1 com 100 mil escritas/dia. Inserções de slots em lotes de 20 linhas (≤100 parâmetros por comando SQLite).

## O que ainda não existe
Notificação push/e-mail/WhatsApp, IA, pagamentos online, financeiro completo, estoque, fidelidade, redes/franquias — ver docs/ROADMAP.md.
