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

## Fase 2: impacto em escritas do D1
Concluir um atendimento passa a gravar +1 comissão e (se a fidelidade estiver ligada) +1 lançamento de pontos. O cron de lembretes (a cada 15 min = 96 execuções/dia, 1 dos 5 crons gratuitos) faz 1 leitura de varredura + até 50 inserts + até 20 envios (≤ 20 subrequests) por execução; sem provedor de e-mail configurado ele sai sem consultar nada. Valores estimados, **não medidos**. E-mail transacional não é gratuito ilimitado: conferir o plano gratuito do provedor escolhido.

## Fase 3: impacto
Chat por polling de 15 s (só com a aba aberta e visível): cada conversa ativa ≈ 4 leituras/min por participante — com muitas conversas simultâneas isso consome leituras do D1 (5 milhões/dia) e requisições do Worker (100 mil/dia) mais rápido que a agenda; é o primeiro recurso a migrar para Durable Objects/WebSocket se crescer. Web Push não tem custo de provedor (usa os serviços dos navegadores), mas cada envio é 1 subrequest. Campanhas: até 200 e-mails/dia/organização, dentro de 20 envios por execução do cron — o gargalo real é a cota do provedor de e-mail (conferir).

## Estimativa honesta
Uma barbearia média (100 agendamentos/dia) cabe folgadamente. O primeiro gargalo previsível é **escrita no D1** (100 mil/dia) com muitas barbearias; o segundo, a CPU de 10 ms. A saída é o plano pago do Workers (valor a conferir no site da Cloudflare) — decisão sua, não implementada.

## Custo atual
R$ 0 de infraestrutura. Nenhum serviço pago foi contratado ou configurado.
