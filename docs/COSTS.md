# Custos e limites (planos gratuitos)

Valores conferidos na documentação oficial durante a Fase 1; **podem mudar** — revalidar antes de lançar.

| Serviço | Limite gratuito relevante | Onde pesa no NaRégua |
|---|---|---|
| Workers Free | 100 mil requisições/dia; **10 ms de CPU** por requisição; 50 subrequests; 5 crons/conta | verificação do token; sem hashing de senha no Worker |
| D1 Free | 5 milhões de leituras e 100 mil escritas/dia; 5 GB; 10 bancos | cada reserva ≈ 15–25 escritas (agendamento, itens, 6 slots, histórico, auditoria, notificações) → ordem de **~4–6 mil reservas/dia** no teto de escritas |
| Firebase Auth (Spark) | 50 mil usuários ativos/mês; sem SMS | login por e-mail/Google apenas |
| Turnstile | gratuito | reserva pública |
| GitHub Actions | minutos gratuitos (repo público ilimitado) | CI e backup diário |
| Google Drive | 15 GB da conta | backups criptografados com retenção de 30 dias |

## Estimativa honesta
Uma barbearia média (100 agendamentos/dia) cabe folgadamente. O primeiro gargalo previsível é **escrita no D1** (100 mil/dia) com muitas barbearias; o segundo, a CPU de 10 ms. A saída é o plano pago do Workers (valor a conferir no site da Cloudflare) — decisão sua, não implementada.

## Custo atual
R$ 0 de infraestrutura. Nenhum serviço pago foi contratado ou configurado.
