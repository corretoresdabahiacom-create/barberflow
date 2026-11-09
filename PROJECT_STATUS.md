# PROJECT_STATUS — NaRégua

_Atualizado em 2026-11-09. Esta é a fonte da verdade: se algo não está marcado como feito **e testado**, não conte com isso._

## Fase atual
**Fase 1 — implementada; API testada localmente; sem deploy.** Fases 2–4: não iniciadas.

## Entregue e verificado
- API Worker (Hono/TS) sobre D1: organizações, unidades, equipe e RBAC, catálogo, horários e bloqueios, agenda com anti-conflito, reserva pública (Turnstile/honeypot/limites), portal do cliente, clientes + LGPD (export/anonimização), pagamento manual idempotente, relatórios, auditoria, notificações internas. **70 testes passando** (workerd + D1 local) — docs/TEST-PLAN.md.
- Isolamento entre barbearias comprovado por matriz de testes, FKs compostas e varredura estática — docs/ISOLATION.md.
- Front React/PWA (landing, login, reserva pública, gerência de agendamento por link, portal do cliente, painel: agenda, profissionais, serviços, clientes, acessos, relatórios, avisos, ajustes com QR Code) — typecheck + build OK; páginas públicas verificadas em navegador.
- Backup para Google Drive (script + workflow) — **só a lógica pura testada**.
- CI (GitHub Actions) escrito — ainda não rodou no GitHub.

## NÃO feito / NÃO verificado
- **Deploy**: nenhum. Sem URL. Sem conta Cloudflare/Firebase/Google configurada (eu não tenho as credenciais). Passo a passo em docs/INFRASTRUCTURE.md.
- Login real, Turnstile real, upload ao Drive: nunca exercitados contra os serviços.
- Telas autenticadas do painel/portal: sem teste em navegador (apenas compilam).
- CPU de 10 ms por requisição, D1 remoto, carga, pentest, Lighthouse, instalação do PWA em aparelho.
- Pagamentos online, notificações push/e-mail/WhatsApp, IA, financeiro completo, estoque, fidelidade: **não existem**.
- Verificação de marca no INPI e de domínio: pendente (docs/BRAND-REVIEW.md).
- Textos legais: rascunho que precisa de advogado(a) (docs/LEGAL.md).

## Decisões do usuário incorporadas
Nome trocado (NaRégua); Supabase → Cloudflare D1 + Firebase Auth; backup no Google Drive; repositório novo; sem domínio por ora (workers.dev); planos/preços editáveis e vazios; textos legais sob lei brasileira (rascunho).

## Pendências que dependem de você
1. Criar/fornecer projeto Firebase e conta Cloudflare (ou executar docs/INFRASTRUCTURE.md) para o primeiro deploy.
2. Consulta INPI + domínio do nome NaRégua.
3. Revisão jurídica dos textos; dados do controlador (`VITE_OPERATOR_*`).
4. Decidir domínio antes de imprimir QR Codes (ADR-006).
5. Credenciais OAuth do Google Drive para o backup e um teste de restauração.

## Riscos abertos
Limite de CPU do plano Free; rate limit em memória é só freio; `batch()` do D1 só comprovado no emulador; CSP não validada com o login real do Firebase.
