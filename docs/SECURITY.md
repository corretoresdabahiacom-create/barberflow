# Segurança e modelo de ameaças (Fase 1)

## Controles implementados (todos com teste, salvo onde indicado)
| Ameaça | Controle |
|---|---|
| Token forjado/expirado/outro projeto | Verificação RS256 + iss/aud/exp/iat; chave desconhecida recusada (testes de auth) |
| Acesso a dados de outra barbearia | Tenant derivado de vínculos, 404, FKs compostas, matriz de isolamento |
| Escalada de privilégio | RBAC no servidor; owner não atribuível; último dono protegido |
| Dupla reserva / corrida | PK em `appointment_slots`; teste com 8 requisições simultâneas |
| Spam/sabotagem da agenda pública | Turnstile (falha fechada), honeypot, 10 reservas/10 min/IP (best-effort em memória), ≤3 futuras e ≤5/24 h por telefone |
| Sequestro de histórico por telefone | Vínculo só por e-mail verificado (teste com atacante) |
| Cancelamento por terceiros | Token aleatório 192 bits, só hash SHA-256 no banco, comparação em tempo constante |
| Pagamento duplicado/excedente | Idempotency-Key + insert condicional atômico; testado com concorrência |
| Adulteração de trilhas | Triggers append-only |
| Sessão roubada | Revogação global (`sessions_valid_after`) |
| XSS/clickjacking | CSP restrita, X-Frame-Options, nosniff; React escapa por padrão (CSP **verificada só como cabeçalho presente**, não auditada contra o Firebase real) |
| SQL injection | Somente `bind`; varredura confere que `${}` em SQL só monta placeholders/colunas fixas |
| Financeiro/estoque/fidelidade (Fase 2) | `Idempotency-Key` obrigatória; lançamentos append-only por trigger; correção só por estorno/ajuste; inserts condicionais atômicos (saldo de estoque e de pontos nunca negativo, mesmo com concorrência — testado); permissões por unidade; comissão do profissional só a própria |
| Lembretes por e-mail | desligado por padrão (organização + provedor); só para cliente com e-mail e **sem opt-out vigente**; um por agendamento (`dedupe_key`); corpo sem telefone e sem token; tentativas limitadas; fila visível só ao dono |
| Vitrine pública | opt-in por unidade (`listed`, exige cidade/UF); só campos de divulgação (sem telefone nem IDs); limite por IP; parâmetros validados |
| Chat | só cliente com vínculo verificado **e** agendamento na unidade; equipe por permissão/unidade; limites de 20 (cliente) e 60 (equipe) msgs/10 min; mensagens ≤ 1000 caracteres, imutáveis; bloqueio pela equipe; apagado na anonimização |
| Marketing | opt-in explícito vigente (sem registro = não recebe), rechecado no envio; link de descadastro assinado (HMAC-SHA256) + `List-Unsubscribe`; teto de 200/dia/organização; só o proprietário; reivindicação atômica contra envio duplo |
| Web Push | criptografia aes128gcm validada contra o vetor do RFC 8291; JWT VAPID ES256; **allowlist de hosts** (FCM, Mozilla, Apple, WNS) — o Worker nunca chama URL arbitrária do usuário (SSRF); máx. 10 aparelhos/conta; payload sem dados sensíveis (nome + trecho); falha de push não afeta a operação |
| Vazamento por erro | Handler global devolve mensagem genérica; detalhes só no log |
| Segredos | Nenhum no repositório; Turnstile secret via `wrangler secret`; `.dev.vars` ignorado |

## Fase 4
| Tema | Controle |
|---|---|
| Privacidade da IA | nada de dado de cliente para provedores; texto do dono com PII mascarada; teste prova que nome/telefone/e-mail de cliente não aparecem no prompt |
| Injeção de prompt | entrada em `<dados>…</dados>` sem permitir fechar o bloco; instrução de sistema de não obedecer; saída sem links/e-mails; humano revisa; nada é enviado/gravado pela IA |
| Abuso/custo | desligada por padrão, cota atômica por barbearia ∧ plano, limite por usuário, timeout de 15 s |
| Chaves de IA | só em `wrangler secret`; Gemini usa cabeçalho `x-goog-api-key` (nunca na URL); log de erro só com id do provedor e status |
| Rede/franquia | consentimento explícito, convite hash/expira/uso único, 4 agregados fixos, saída imediata, 404 para quem está fora |
| Plataforma | `/api/platform/*` só para e-mails verificados da lista; 404 para os demais |

## Limitações honestas
- **Rate limit em memória por isolate**: serve como freio, não como barreira; a barreira real é Turnstile + limites no banco.
- **CPU de 10 ms** do plano Free não foi medida (só em produção). A verificação RSA é a operação mais cara por requisição.
- Nenhum teste de carga, pentest ou revisão externa foi feito.
- Firebase, Turnstile e Google Drive **não foram exercitados contra os serviços reais** (sem credenciais).
- Chat por polling (sem WebSocket) consome leituras do D1; push é melhor esforço, sem retry. Mensagens de chat **não são criptografadas de ponta a ponta** (a barbearia e o operador do sistema podem lê-las) — dizer isso ao usuário.
- Sem MFA nesta fase (Firebase suporta; não configurado).
- D1 remoto não foi testado: atomicidade de `batch()` foi comprovada somente no emulador local.
