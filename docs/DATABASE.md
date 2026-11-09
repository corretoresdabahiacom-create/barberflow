# Banco de dados (D1/SQLite)

Fonte da verdade: [`apps/worker/migrations/0001_core.sql`](../apps/worker/migrations/0001_core.sql). Não duplicamos o esquema aqui para não divergir.

## Convenções
- IDs `TEXT` (UUID v4). Datas em UTC ISO-8601 (`...Z`). Dinheiro em **centavos inteiros**.
- Toda tabela de dado de barbearia tem `organization_id` e FKs compostas `(organization_id, id)` (ver ISOLATION.md).
- Horários de expediente em minutos desde 00:00 **no fuso da unidade** (`units.timezone`).

## Tabelas
`users` (espelho do Firebase por `firebase_uid`; `sessions_valid_after` p/ revogar sessões) · `organizations` · `units` (`slug` único e **imutável por trigger**) · `memberships` (papel, unidade, convite por e-mail, `can_receive_payments`) · `professionals` · `professional_units` · `services` · `professional_services` (preço/duração opcionais) · `schedules` · `time_blocks` · `customers` · `customer_accounts` (vínculo verificado) · `customer_consents` (**append-only**) · `appointments` · `appointment_items` (preço/duração copiados) · `appointment_slots` (anti-conflito) · `appointment_history` (**append-only**) · `payments` (**append-only**, `UNIQUE(organization_id, idempotency_key)`) · `notifications` · `audit_logs` (**append-only**).

## Anti dupla reserva
`appointment_slots(professional_id, slot, …)` com PK `(professional_id, slot)`, onde `slot = floor(epoch_ms / 5min)`. Um agendamento de 30 min ocupa 6 linhas. Cancelar apaga as linhas; remarcar apaga e reinsere no mesmo `batch`.

## Imutabilidade
Triggers `RAISE(ABORT, 'append_only')` em UPDATE/DELETE de `audit_logs`, `appointment_history`, `customer_consents`, `payments`; `units_slug_immutable` no slug. Efeito colateral intencional: anonimização LGPD **não apaga** pagamentos, só desidentifica o cliente.

## Migrações
Arquivos numerados em `apps/worker/migrations/`. Local: `pnpm --filter @naregua/worker db:migrate:local`. Remoto: `db:migrate:remote` (exige conta Cloudflare + `database_id` real em `wrangler.jsonc`). **Nunca editar migração já aplicada**; criar a próxima.
