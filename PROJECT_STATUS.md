# PROJECT_STATUS — NaRégua

_Atualizado em 2026-11-11. Esta é a fonte da verdade: se algo não está marcado como feito **e testado**, não conte com isso._

## Fase atual
**Fase 4 — implementada; API testada localmente (IA com provedores simulados); sem deploy.** (Fases 1, 2 e 3 idem.)

## Entregue e verificado
- API Worker (Hono/TS) sobre D1: organizações, unidades, equipe e RBAC, catálogo, horários e bloqueios, agenda com anti-conflito, reserva pública (Turnstile/honeypot/limites), portal do cliente, clientes + LGPD (export/anonimização), pagamento manual idempotente, relatórios, auditoria, notificações internas. **Fase 1: 70 testes** (workerd + D1 local) — docs/TEST-PLAN.md.
- **Fase 2** (API + telas): despesas append-only com estorno; caixa por unidade (abertura/fechamento imutável, esperado × contado); regras e lançamentos de comissão congelados na conclusão; estoque por unidade (movimentações append-only, saldo nunca negativo, concorrência testada); fidelidade (pontos por real, resgate atômico, desligada por padrão); outbox de e-mail + cron de lembretes 24 h (desligado por padrão, remetente injetável). **116 testes** (46 novos) — docs/TEST-PLAN.md.
- **Fase 3** (API + telas): vitrine pública opt-in (`/descobrir`); chat cliente↔barbearia por polling, com bloqueio, limites e LGPD; campanhas de marketing só para quem deu consentimento, com descadastro de 1 clique assinado e teto diário; Web Push (VAPID + criptografia RFC 8291 **reproduzindo o vetor oficial do RFC**), assinaturas com allowlist anti-SSRF, push em segundo plano nas mensagens do chat. **156 testes passando no total** (40 novos).
- **Fase 4** (API + telas): IA assistiva (texto de campanha, descrição de serviço, resumo de números) com cadeia de provedores **Gemini → Groq → OpenRouter → Cloudflare Workers AI → Grok(xAI, pago)**, desligada por padrão, sem dados de cliente, saída sanitizada, cota atômica; redes/franquias com convite e consentimento e relatório só de agregados; planos editáveis (limites de unidades/profissionais, cota de IA, rede), assinatura manual e painel `/plataforma`. **197 testes passando** (41 novos) + 9 mutações verificadas — docs/AI.md, docs/NETWORKS-PLANS.md.
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
- **Web Push real**: nunca enviado a FCM/Mozilla/Apple/WNS (só criptografia/JWT validados localmente e envio com serviço falso). Sem chaves VAPID configuradas, fica desligado. iPhone só recebe push com o PWA instalado na tela de início — não testado em aparelho.
- **Campanhas reais**: dependem do mesmo provedor de e-mail (não testado), de `UNSUBSCRIBE_SECRET` e `PUBLIC_BASE_URL`. Entrega/spam/reputação do domínio remetente: não avaliados.
- **Não feito na Fase 3**: WhatsApp (custo + consentimento + API oficial paga), avaliações/notas de barbearias (exigem moderação), ranking/destaque pago, mapa/geolocalização, anexos/imagens no chat, WebSocket/tempo real (usa polling de 15 s), push para campanhas, agendamento de envio de campanha, segmentos além de "autorizados" e "inativos", testes automatizados do front, telas autenticadas em navegador.
- **Não feito na Fase 2**: cupons de desconto, vendas de produto no caixa (não entram no "esperado"), regras de comissão por serviço na interface (existem na API), resgate de pontos pela interface, push/WhatsApp, link de cancelamento no e-mail de lembrete (o token só é guardado em hash), e-mail de aviso de falta/cancelamento.
- **Fase 4 — não verificado:** NENHUM provedor de IA foi chamado de verdade (sem chaves); modelos padrão, limites e termos de dados dos provedores precisam ser conferidos nas páginas oficiais (a página oficial do Gemini lida estava desatualizada; limites de Groq/OpenRouter vêm de comparativo de terceiros). **Grok (xAI) não tem API gratuita**: está integrado mas só liga com chave e modelo seus. Cota diária de IA da CONTA inteira (limite gratuito dos provedores) não é dividida entre barbearias além da cota de cada uma. Telas IA/Rede/Plano/`/plataforma` não abertas em navegador. Limite de plano é verificado antes de inserir (duas criações simultâneas no limite podem passar por 1).
- **Não existem:** cobrança automática/gateway/notas fiscais (assinatura é registrada à mão), WhatsApp, pagamentos online, avaliações, preços definidos (valores iniciais dos planos são provisórios).
- Verificação de marca no INPI e de domínio: pendente (docs/BRAND-REVIEW.md).
- Textos legais: rascunho que precisa de advogado(a) (docs/LEGAL.md).

## Decisões do usuário incorporadas
Fase 4: IA gratuita (Gemini e outras; Grok integrado, mas pago). Repositório único: github.com/corretoresdabahiacom-create/barberflow (o `barberlow` foi descartado). Nome trocado (NaRégua); Supabase → Cloudflare D1 + Firebase Auth; backup no Google Drive; repositório novo; sem domínio por ora (workers.dev); planos/preços editáveis e vazios; textos legais sob lei brasileira (rascunho).

## Pendências que dependem de você
1. Criar/fornecer projeto Firebase e conta Cloudflare (ou executar docs/INFRASTRUCTURE.md) para o primeiro deploy.
2. Consulta INPI + domínio do nome NaRégua.
3. Revisão jurídica dos textos; dados do controlador (`VITE_OPERATOR_*`).
4. Decidir domínio antes de imprimir QR Codes (ADR-006).
5. Credenciais OAuth do Google Drive para o backup e um teste de restauração.
8. Gerar chaves VAPID (`node scripts/gen-vapid.mjs`) e configurar `VAPID_PRIVATE_KEY` (segredo), `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`; definir `UNSUBSCRIBE_SECRET` (segredo, longo e aleatório) e `PUBLIC_BASE_URL`.
9. Decidir o que a vitrine pode divulgar e se haverá avaliações (e quem modera); validar com advogado(a) a base legal de marketing/chat/vitrine.
6. Escolher o provedor de e-mail para os lembretes (ex.: Resend, plano gratuito — conferir limites), verificar o domínio remetente e configurar `EMAIL_API_KEY`/`EMAIL_FROM`; só então ligar "Lembretes" em Automação.
7. Validar com advogado(a) a base legal dos lembretes de agendamento (tratados como mensagem de serviço, com opt-out) e a política de fidelidade.

10. Fase 4: obter chaves gratuitas (Gemini/Groq/OpenRouter) e conferir modelos/limites/termos de dados; decidir se usa Grok pago; definir preços/limites reais dos planos em `/plataforma`; configurar `PLATFORM_ADMIN_EMAILS`; decidir gateway de cobrança (ex.: Mercado Pago) quando quiser cobrar; validar com advogado(a) o aviso de IA e o aceite de rede.

## Riscos abertos
Limite de CPU do plano Free; rate limit em memória é só freio; `batch()` do D1 só comprovado no emulador (a Fase 2 depende dele em conclusão de atendimento, caixa e estoque); CSP não validada com o login real do Firebase.
