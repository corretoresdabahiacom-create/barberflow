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
| Vazamento por erro | Handler global devolve mensagem genérica; detalhes só no log |
| Segredos | Nenhum no repositório; Turnstile secret via `wrangler secret`; `.dev.vars` ignorado |

## Limitações honestas
- **Rate limit em memória por isolate**: serve como freio, não como barreira; a barreira real é Turnstile + limites no banco.
- **CPU de 10 ms** do plano Free não foi medida (só em produção). A verificação RSA é a operação mais cara por requisição.
- Nenhum teste de carga, pentest ou revisão externa foi feito.
- Firebase, Turnstile e Google Drive **não foram exercitados contra os serviços reais** (sem credenciais).
- Sem MFA nesta fase (Firebase suporta; não configurado).
- D1 remoto não foi testado: atomicidade de `batch()` foi comprovada somente no emulador local.
