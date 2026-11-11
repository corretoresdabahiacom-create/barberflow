# Plano e resultados de testes

## Executado e aprovado (Fases 1 e 2) — `pnpm test`: **116/116**, mais 3/3 do script de backup
Ambiente: Vitest 4 dentro do **workerd** (runtime real do Workers) com **D1 local** (miniflare). Evidência **local**: não substitui testes em D1/Workers remotos.

| Arquivo | Testes | Cobre |
|---|:-:|---|
| `auth.test.ts` | 11 | sem token, lixo, chave desconhecida, aud/iss errados, expirado, payload adulterado, criação de usuário, suspenso, revogação de sessões, e-mail não verificado, limite de 3 organizações, slug reservado/duplicado |
| `isolation.test.ts` | 8 | matriz de ~45 rotas (dono de A → B = 404), 401 sem login, IDs cruzados, escrita cruzada, FK composta no banco, listagens, página pública, usuário em duas lojas |
| `rbac.test.ts` | 10 | barbeiro (tudo negado + escopo próprio), flag de recebimento, gerente, admin de unidade vs outra unidade e catálogo org-wide, slug imutável, último dono, convites por e-mail verificado, vínculo suspenso, cliente x atacante com mesmo telefone |
| `booking.test.ts` | 17 | disponibilidade (expediente, domingo, passado, janela, antecedência), bloqueios, **8 reservas simultâneas → 1 vence / 7 `slot_taken` pelo banco**, sobreposição parcial, **atomicidade do batch** (rollback), remarcação com conflito, cancelamento libera horário, Turnstile/honeypot/limites, token de cancelamento, janela de cancelamento, preço copiado, fluxo de status, no-show, notificações |
| `payments.test.ts` | 13 | Idempotency-Key, replay, conflito de chave, excesso, **pagamentos concorrentes**, valores inválidos, não pagável, chave por organização, relatório, **triggers append-only**, consentimentos, LGPD export/anonimização, dedupe de clientes, validação de agenda/serviços |
| `static-tenant.test.ts` | 4 | varredura de SQL (`organization_id`/`tenant-ok:`), SQL sem concatenação de entrada |
| `unit.test.ts` | 7 | fuso (São Paulo, DST de Nova York), datas, telefone, e-mail, RBAC puro |
| `finance.test.ts` | 15 | **Fase 2.** Comissão congelada (padrão, por serviço, sem regra = 0, arredondamento p/ baixo), não duplica, sem comissão em falta, relatório e visão própria; despesas (idempotência, validação, estorno único, append-only); **caixa** (esperado = abertura + dinheiro − despesas em dinheiro, PIX fora, diferença, fechamento imutável, um aberto por unidade, 4 fechamentos paralelos → 1 vence); resumo; permissões por papel e por unidade |
| `stock.test.ts` | 11 | compra/venda/perda/ajuste, preço congelado, **saldo nunca negativo**, **8 vendas simultâneas c/ saldo 5 → 5 passam**, idempotência, validações, saldo por unidade, append-only, permissões, SKU único, produto inativo, produto de outra organização → 404 |
| `loyalty.test.ts` | 8 | desligada por padrão, ganho 1×/atendimento, sem pontos em cancelamento, resgate (insuficiente/idempotente), **5 resgates simultâneos c/ saldo 20 → 2 passam**, append-only, configuração só do dono, isolamento |
| `outbox.test.ts` | 12 | enfileira+envia, dedupe, desligado por padrão, sem provedor, opt-out, janela +2 h/+24 h e status, cliente sem e-mail, retry com backoff até 5 → `failed`, recuperação, `skipped` se cancelado, isolamento entre organizações, visibilidade da fila, **2 execuções simultâneas → 1 envio** |

Matriz de isolamento ampliada: +24 rotas da Fase 2 (dono de A → B = 404). Varredura estática passou a cobrir as 8 tabelas novas.
**Limites desses testes:** o remetente de e-mail é falso (nenhum provedor real); o "cron" é chamado como função (`runScheduled`), e só um `wrangler dev --test-scheduled` local confirmou que o handler responde; atomicidade de `batch()` e concorrência só no emulador local.

**Verificação de mutação:** (Fase 2) removidos propositalmente os guardas de saldo (estoque e pontos) → 5 testes falharam; restaurados → passam. (Fase 1) removido propositalmente o filtro de tenant em `loadCustomer` → o teste "ID de B dentro da URL de A nunca vaza" falhou; restaurado → 70/70.
**Bugs reais achados pelos testes:** telefone fixo de 10 dígitos aceitava celular antigo sem o 9 (corrigido); permissão de serviços permitia admin de unidade alterar preços de toda a organização (corrigida).

## Teste manual em navegador (Chromium, 390×844, app servido por `wrangler dev` com D1 local semeado)
Landing, reserva pública (35 horários, avanço automático para o próximo dia útil), botão bloqueado sem Turnstile (falha fechada), 404 amigável de slug inexistente, redirecionamento `/app` → `/entrar` sem login, tela "configuração pendente" sem Firebase, termos, CSP/HSTS/X-Frame presentes, SW sem interceptar `/api`, manifest, fallback SPA.

## NÃO testado (lacunas)
- Login real (Firebase), Turnstile real, Google Drive, deploy: sem credenciais.
- Telas autenticadas do painel e do portal do cliente **não foram exercitadas em navegador** (dependem de Firebase); só typecheck + build. Toda a API por trás delas está testada.
- Instalação do PWA em Android/iOS, acessibilidade com leitor de tela, Lighthouse.
- Carga, CPU de 10 ms, D1 remoto, pentest.
- Testes automatizados do front (não há). Abas Financeiro/Estoque/Automação nunca foram abertas em navegador (exigem login Firebase).
