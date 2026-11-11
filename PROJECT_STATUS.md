# PROJECT_STATUS — NaRégua

_Atualizado em 2026-11-10. Esta é a fonte da verdade: se algo não está marcado como feito **e testado**, não conte com isso._

## Fase atual
**Fase 2 — implementada; API testada localmente; sem deploy.** (Fase 1 idem.) Fases 3–4: não iniciadas.

## Entregue e verificado
- API Worker (Hono/TS) sobre D1: organizações, unidades, equipe e RBAC, catálogo, horários e bloqueios, agenda com anti-conflito, reserva pública (Turnstile/honeypot/limites), portal do cliente, clientes + LGPD (export/anonimização), pagamento manual idempotente, relatórios, auditoria, notificações internas. **Fase 1: 70 testes** (workerd + D1 local) — docs/TEST-PLAN.md.
- **Fase 2** (API + telas): despesas append-only com estorno; caixa por unidade (abertura/fechamento imutável, esperado × contado); regras e lançamentos de comissão congelados na conclusão; estoque por unidade (movimentações append-only, saldo nunca negativo, concorrência testada); fidelidade (pontos por real, resgate atômico, desligada por padrão); outbox de e-mail + cron de lembretes 24 h (desligado por padrão, remetente injetável). **116 testes passando no total** (46 novos) — docs/TEST-PLAN.md.
- Isolamento entre barbearias comprovado por matriz de testes, FKs compostas e varredura estática — docs/ISOLATION.md.
- Front React/PWA (landing, login, reserva pública, gerência de agendamento por link, portal do cliente, painel: agenda, profissionais, serviços, clientes, acessos, relatórios, avisos, ajustes com QR Code) — typecheck + build OK; páginas públicas verificadas em navegador. Novas abas Financeiro, Estoque e Automação: só typecheck + build.
- Backup para Google Drive (script + workflow) — **só a lógica pura testada**.
- CI (GitHub Actions) escrito — ainda não rodou no GitHub.

## NÃO feito / NÃO verificado
- **Deploy**: nenhum. Sem URL. Sem conta Cloudflare/Firebase/Google configurada (eu não tenho as credenciais). Passo a passo em docs/INFRASTRUCTURE.md.
- Login real, Turnstile real, upload ao Drive: nunca exercitados contra os serviços.
- Telas autenticadas do painel/portal: sem teste em navegador (apenas compilam).
- CPU de 10 ms por requisição, D1 remoto, carga, pentest, Lighthouse, instalação do PWA em aparelho.
- **E-mail real**: o envio por HTTP (formato Resend) **nunca foi chamado contra um provedor**; só roda com `EMAIL_API_KEY` + `EMAIL_FROM`. Os testes usam remetente falso. Cron `*/15 * * * *` só foi acionado no `wrangler dev` local (sem provedor = não faz nada); nunca em produção, CPU/subrequests não medidos.
- **Não feito na Fase 2**: cupons de desconto, vendas de produto no caixa (não entram no "esperado"), regras de comissão por serviço na interface (existem na API), resgate de pontos pela interface, push/WhatsApp, link de cancelamento no e-mail de lembrete (o token só é guardado em hash), e-mail de aviso de falta/cancelamento.
- Pagamentos online, push/WhatsApp, IA, marketing: **não existem**.
- Verificação de marca no INPI e de domínio: pendente (docs/BRAND-REVIEW.md).
- Textos legais: rascunho que precisa de advogado(a) (docs/LEGAL.md).

## Decisões do usuário incorporadas
Repositório único: github.com/corretoresdabahiacom-create/barberflow (o `barberlow` foi descartado). Nome trocado (NaRégua); Supabase → Cloudflare D1 + Firebase Auth; backup no Google Drive; repositório novo; sem domínio por ora (workers.dev); planos/preços editáveis e vazios; textos legais sob lei brasileira (rascunho).

## Pendências que dependem de você
1. Criar/fornecer projeto Firebase e conta Cloudflare (ou executar docs/INFRASTRUCTURE.md) para o primeiro deploy.
2. Consulta INPI + domínio do nome NaRégua.
3. Revisão jurídica dos textos; dados do controlador (`VITE_OPERATOR_*`).
4. Decidir domínio antes de imprimir QR Codes (ADR-006).
5. Credenciais OAuth do Google Drive para o backup e um teste de restauração.
6. Escolher o provedor de e-mail para os lembretes (ex.: Resend, plano gratuito — conferir limites), verificar o domínio remetente e configurar `EMAIL_API_KEY`/`EMAIL_FROM`; só então ligar "Lembretes" em Automação.
7. Validar com advogado(a) a base legal dos lembretes de agendamento (tratados como mensagem de serviço, com opt-out) e a política de fidelidade.

## Riscos abertos
Limite de CPU do plano Free; rate limit em memória é só freio; `batch()` do D1 só comprovado no emulador (a Fase 2 depende dele em conclusão de atendimento, caixa e estoque); CSP não validada com o login real do Firebase.
