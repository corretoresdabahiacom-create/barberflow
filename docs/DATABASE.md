# Banco de dados (D1/SQLite)

Fonte da verdade: [`0003_discovery_chat_marketing_push.sql`](../apps/worker/migrations/0003_discovery_chat_marketing_push.sql) (Fase 3), [`0001_core.sql`](../apps/worker/migrations/0001_core.sql) (Fase 1) e [`0002_finance_stock_loyalty_outbox.sql`](../apps/worker/migrations/0002_finance_stock_loyalty_outbox.sql) (Fase 2). Não duplicamos o esquema aqui para não divergir.

## Convenções
- IDs `TEXT` (UUID v4). Datas em UTC ISO-8601 (`...Z`). Dinheiro em **centavos inteiros**.
- Toda tabela de dado de barbearia tem `organization_id` e FKs compostas `(organization_id, id)` (ver ISOLATION.md).
- Horários de expediente em minutos desde 00:00 **no fuso da unidade** (`units.timezone`).

## Tabelas
`users` (espelho do Firebase por `firebase_uid`; `sessions_valid_after` p/ revogar sessões) · `organizations` · `units` (`slug` único e **imutável por trigger**) · `memberships` (papel, unidade, convite por e-mail, `can_receive_payments`) · `professionals` · `professional_units` · `services` · `professional_services` (preço/duração opcionais) · `schedules` · `time_blocks` · `customers` · `customer_accounts` (vínculo verificado) · `customer_consents` (**append-only**) · `appointments` · `appointment_items` (preço/duração copiados) · `appointment_slots` (anti-conflito) · `appointment_history` (**append-only**) · `payments` (**append-only**, `UNIQUE(organization_id, idempotency_key)`) · `notifications` · `audit_logs` (**append-only**).

**Fase 2:** `expenses` (**append-only**; estorno = linha com `reverses_id`, um por despesa) · `commission_rules` (padrão do profissional e por serviço; pontos-base) · `commission_entries` (**append-only**, `UNIQUE(org, appointment)`, congeladas na conclusão por `INSERT…SELECT` no mesmo `batch` da transição) · `cash_sessions` (um aberto por unidade por índice parcial; **imutável após fechar**) · `products` · `stock_movements` (**append-only**, saldo = `SUM(qty)` por unidade, insert condicional impede saldo negativo) · `loyalty_ledger` (**append-only**, `UNIQUE(org, appointment, kind)` → ganha uma vez; resgate condicional ao saldo) · `outbox` (fila de e-mails, `dedupe_key` única; processada pelo cron). Colunas novas em `organizations`: `loyalty_points_per_real` (0 = desligado) e `reminders_enabled` (0 = desligado).

**Fase 3:** `units` ganha `city`, `state`, `description`, `listed` (vitrine, **desligada por padrão**) · `chat_threads` (uma por cliente×unidade; `status` open/blocked; contadores de não lidas) · `chat_messages` (imutáveis por trigger de UPDATE; **apagadas na anonimização LGPD**) · `campaigns` (rascunho/enviada) · `outbox` recriada com `kind` `campaign`, `campaign_id`, `unsubscribe_url` · `push_subscriptions` (por usuário/aparelho, `endpoint` único).

## Anti dupla reserva
`appointment_slots(professional_id, slot, …)` com PK `(professional_id, slot)`, onde `slot = floor(epoch_ms / 5min)`. Um agendamento de 30 min ocupa 6 linhas. Cancelar apaga as linhas; remarcar apaga e reinsere no mesmo `batch`.

## Imutabilidade
Triggers `RAISE(ABORT, 'append_only')` em UPDATE/DELETE de `audit_logs`, `appointment_history`, `customer_consents`, `payments`, `expenses`, `commission_entries`, `stock_movements`, `loyalty_ledger` (e `cash_sessions` depois de fechado); `units_slug_immutable` no slug. Efeito colateral intencional: anonimização LGPD **não apaga** pagamentos, só desidentifica o cliente.

## Migrações
Arquivos numerados em `apps/worker/migrations/`. Local: `pnpm --filter @naregua/worker db:migrate:local`. Remoto: `db:migrate:remote` (exige conta Cloudflare + `database_id` real em `wrangler.jsonc`). **Nunca editar migração já aplicada**; criar a próxima.
