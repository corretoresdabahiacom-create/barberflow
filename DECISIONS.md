# Decisões de arquitetura (ADR)

Cada decisão tem contexto, escolha e consequências. Mudanças relevantes entram aqui.

## ADR-001 — Nome: NaRégua (substitui BarberFlow)
BarberFlow tinha conflito de marca (concorrente brasileiro no mesmo segmento e homônimo no Canadá). **NaRégua** é termo popular brasileiro de barbearia ("cabelo na régua"), curto e memorável. A busca web feita não achou produto conflitante, **mas isso não é busca de anterioridade**: consulta no INPI (classes 9, 35, 42) e checagem de domínio **precisam ser feitas por uma pessoa** antes de investir na marca. Ver docs/BRAND-REVIEW.md.

## ADR-002 — Cloudflare Workers + D1 no lugar de Supabase/Postgres
Pedido do usuário: backend gratuito e Cloudflare. Consequência: **sem RLS** e sem `EXCLUDE` do Postgres. Substituições: acesso ao banco apenas pelo Worker, `organization_id` + chaves estrangeiras compostas em toda tabela de cliente, testes de isolamento cruzado, varredura estática de SQL (docs/ISOLATION.md); anti-conflito de agenda via `appointment_slots` com chave primária (profissional, bloco de 5 min).

## ADR-003 — Firebase Authentication (Spark) para login
Senhas nunca passam pelo Worker (PBKDF2 estouraria o limite de ~10 ms de CPU do plano Free). O Worker verifica o ID token RS256 com WebCrypto e JWKS do Google. Login por telefone/SMS exige plano Blaze → **não usado**. E-mail verificado é pré-requisito para criar organização, assumir convites e vincular histórico de cliente.

## ADR-004 — Identidade do cliente: vínculo só por e-mail verificado
Cliente da barbearia (`customers`) ≠ conta de login (`customer_accounts`). O vínculo nasce de e-mail verificado pelo provedor ou de reserva autenticada; **nunca por telefone digitado** (evita sequestro de histórico). Reserva pública sem conta é permitida, protegida por Turnstile (falha fechada), honeypot, limites por IP e por telefone, e token de cancelamento aleatório (só o hash SHA-256 é guardado).

## ADR-005 — Backup no Google Drive via GitHub Actions
Service accounts não têm cota no Drive; usa-se OAuth com refresh token e escopo `drive.file`. Dump do D1 é criptografado (AES-256/PBKDF2) antes de sair do runner. **O envio real não foi testado** (sem credenciais); apenas a lógica pura tem teste.

## ADR-006 — Sem domínio próprio por ora
Uso de `*.workers.dev`. Impacto: o `authDomain` do Firebase e a origem do Turnstile precisam incluir o host definitivo; o QR Code codifica a URL completa, então **trocar de domínio depois invalida QR Codes já impressos** (a menos que o endereço antigo redirecione). Decidir o domínio antes de imprimir material.

## ADR-007 — Preços e planos editáveis, sem cobrança
`apps/web/src/config/plans.ts` com preço `null` ("Em breve"). Nenhum gateway implementado. Ao definir preços, edita-se a config (e, na Fase 4, tabela no banco).

## ADR-008 — Textos legais: rascunho por IA sob a LGPD
`apps/web/src/content/legal.ts`. Editável e **obrigatoriamente revisável por advogado(a)** antes de publicar; dados do controlador vêm de variáveis `VITE_OPERATOR_*`.

## ADR-009 — Pagamentos manuais, imutáveis e idempotentes (Fase 1)
Sem Pix/cartão automático. Registro manual com `Idempotency-Key` obrigatória, inserção condicional atômica que impede somar mais que o total, tabela append-only (correções futuras = estorno em novo lançamento).

## ADR-010 — D1 `batch()` como transação
Verificado **localmente** (workerd/miniflare): falha no meio do batch desfaz tudo (teste `booking.test.ts`). Não foi verificado em D1 remoto — repetir o teste após o primeiro deploy.
