# Plano e resultados de testes

## Executado e aprovado (Fases 1 a 4) — `pnpm test`: **197/197**, mais 3/3 do script de backup
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

| `webpush.test.ts` | 5 | **reproduz byte a byte o vetor de teste do RFC 8291**; round-trip com decifragem do lado do navegador; chaves/payload inválidos; JWT VAPID verificável; allowlist anti-SSRF (8 URLs hostis) |
| `discovery.test.ts` | 6 | opt-in (não aparece por padrão; exige cidade/UF), campos expostos, filtros, desligar/inativar, permissão, validação/injeção, limite por IP |
| `push.test.ts` | 7 | config, validação e SSRF, idempotência/limite de 10/remoção, troca de dono do aparelho, push no chat nos dois sentidos, assinatura expirada apagada, falha do serviço não derruba o chat, push desligado |
| `chat.test.ts` | 9 | só quem agendou na unidade; fluxo e não lidas; validação e limite 20/10 min; bloqueio/reabertura + auditoria; imutável e separação entre clientes; permissões e unidade; isolamento entre organizações; filial sem agendamento; LGPD (exportação, anonimização) |
| `marketing.test.ts` | 13 | permissão só do dono; validação; **público = opt-in vigente**; WhatsApp/serviço não valem; sem provedor; envio + personalização + rodapé + `List-Unsubscribe`; **3 envios simultâneos → 1**; descadastro (query e corpo), idempotente, vale para a fila; token adulterado/forjado; teto diário; segmento inativos; isolamento; rascunho × enviada |
| `ai.test.ts` | 21 | **Fase 4.** IA desligada por padrão; só dono liga/ajusta (auditado); permissões por papel; insights só dono; **cota** (N+1ª → 429, falha não consome, **6 simultâneas c/ cota 2 → 2 passam**), limite = menor entre org e plano, cota por organização, sem provedor → 409; uso sem texto; **PII mascarada**, **nenhum dado de cliente no prompt**, saída sem links/e-mails, **injeção de prompt** (`</dados>`), saída vazia devolve cota, nada é salvo; **cadeia de provedores** com `fetch` falso (fallback, formatos Gemini/Groq, chave fora da URL, log sem prompt, xAI exige modelo, ordem configurável, Workers AI) |
| `plans.test.ts` | 10 | **Fase 4.** Plataforma só para admin verificado (404 p/ os demais, inclusive e-mail não verificado e dono da loja); editar plano reflete na vitrine; gratuito não desativa; assinatura (plano/org inexistente, auditoria); limites de unidades/profissionais (inativo não conta); vencida/suspensa/plano desativado → gratuito sem apagar dados; `/plan` só dono e isolado |
| `network.test.ts` | 10 | **Fase 4.** Plano com rede + só proprietário; aceite explícito obrigatório; convite uso único/expira/só hash/máx. 5; relatório: administradora × membro × fora da rede, **sem nome/telefone/e-mail de cliente**, terceiros fora do total; sair encerra compartilhamento; remover membro/redes distintas; isolamento por URL; período inválido |

Matriz de isolamento ampliada: +10 rotas de chat/campanhas (Fase 3) e +24 da Fase 2 (dono de A → B = 404). Varredura estática passou a cobrir as 8 tabelas novas.
**Limites desses testes:** o remetente de e-mail é falso (nenhum provedor real); o "cron" é chamado como função (`runScheduled`), e só um `wrangler dev --test-scheduled` local confirmou que o handler responde; atomicidade de `batch()` e concorrência só no emulador local.

**Verificação de mutação (Fase 3):** invertido o opt-in de marketing (sem registro passa a receber), desligada a checagem da assinatura do token de descadastro e removida a regra "só conversa com a unidade onde agendou" → 3 + 1 testes falharam; restaurado → 156/156. (Na primeira rodada a regra de unidade NÃO foi pega: faltava o teste da filial na mesma organização; foi escrito.)
**Verificação de mutação:** (Fase 2) removidos propositalmente os guardas de saldo (estoque e pontos) → 5 testes falharam; restaurados → passam. (Fase 1) removido propositalmente o filtro de tenant em `loadCustomer` → o teste "ID de B dentro da URL de A nunca vaza" falhou; restaurado → 70/70.
**Bugs reais achados pelos testes:** telefone fixo de 10 dígitos aceitava celular antigo sem o 9 (corrigido); permissão de serviços permitia admin de unidade alterar preços de toda a organização (corrigida).

## Teste manual em navegador (Chromium, 390×844, app servido por `wrangler dev` com D1 local semeado)
Landing, reserva pública (35 horários, avanço automático para o próximo dia útil), botão bloqueado sem Turnstile (falha fechada), 404 amigável de slug inexistente, redirecionamento `/app` → `/entrar` sem login, tela "configuração pendente" sem Firebase, termos, CSP/HSTS/X-Frame presentes, SW sem interceptar `/api`, manifest, fallback SPA.

**Verificação por mutação (Fase 4):** quebrei de propósito 9 regras (membro vendo todas as linhas, PII sem máscara, cota sem condição, links sem remoção, guarda de administrador, plano inativo, convite sem validade/uso único, bloco `<dados>` aberto) e os testes falharam em cada caso. Uma mutação sobreviveu (plano desativado ainda valendo) → escrevi o teste que faltava e ele agora a pega.

## NÃO testado (lacunas)
- **Fase 4:** nenhum provedor de IA real (Gemini, Groq, OpenRouter, Workers AI, Grok) foi chamado — só simulados; qualidade das respostas em português não avaliada; limites e modelos padrão a confirmar nas páginas oficiais; abas IA/Rede/Plano e `/plataforma` só compilam (sem login Firebase não abrem em navegador); cobrança automática não existe.
- Login real (Firebase), Turnstile real, Google Drive, deploy: sem credenciais.
- Telas autenticadas do painel e do portal do cliente **não foram exercitadas em navegador** (dependem de Firebase); só typecheck + build. Toda a API por trás delas está testada.
- Instalação do PWA em Android/iOS, acessibilidade com leitor de tela, Lighthouse.
- Carga, CPU de 10 ms, D1 remoto, pentest.
- Web Push contra FCM/Mozilla/Apple, e-mail de campanha em provedor real, chat em aparelhos, iOS (PWA instalado), entregabilidade.
- Testes automatizados do front (não há). Abas Financeiro/Estoque/Automação nunca foram abertas em navegador (exigem login Firebase).
