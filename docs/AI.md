# IA assistiva (Fase 4)

**Estado honesto:** implementada e testada **somente com provedores falsos** (`fetch` e binding simulados). **Nenhum provedor real foi chamado** (sem chaves). Os formatos de requisição seguem a documentação pública, mas só se provam na primeira chamada real.

## O que a IA faz (e não faz)
- Sugere texto de campanha, descrição de serviço e um resumo em linguagem simples dos números do período.
- **Nunca** envia, salva ou altera nada sozinha: devolve sugestão; a pessoa revisa e copia.
- **Nenhum dado de cliente** vai para a IA. Entram só: texto livre digitado pelo dono (com e-mail/telefone/CPF/CNPJ mascarados), nome da barbearia, nomes de serviços do catálogo e números agregados.
- A saída é tratada como **não confiável**: links, e-mails e blocos de código são removidos (anti-phishing por injeção de prompt); tamanho limitado; o texto do usuário vai dentro de `<dados>…</dados>` e não consegue fechar o bloco.

## Controles
| Controle | Onde |
|---|---|
| Desligada por padrão; só o proprietário liga (`org.manage`) e define a cota da barbearia | `PUT /api/orgs/:id/ai/settings` |
| Cota diária efetiva = **menor** entre cota da barbearia e cota do plano; reserva **atômica** (INSERT condicional) — 6 chamadas simultâneas com cota 2 → 2 passam (testado) | `ai_usage` |
| Falha do provedor devolve a reserva (não consome cota) | idem |
| Limite por usuário: 10 chamadas/min (memória do isolate, freio) | `rateLimit` |
| Registro de uso só com metadados (sem texto enviado/recebido) | `ai_usage` |
| Permissões: `ai.use` (dono, admin de unidade, gerente); campanha exige também `marketing.manage` (dono); descrição exige `catalog.write`; resumo/ajustes só dono | `permissions.ts` |

## Provedores (cadeia com fallback; ordem em `AI_PROVIDER_ORDER`, padrão abaixo)
Um provedor só entra na cadeia se a chave estiver configurada. Erro, timeout (15 s), HTTP ≠ 2xx ou resposta vazia → tenta o próximo. Se todos falharem: 503 e a cota é devolvida.

| Ordem | Id | Segredo/variável | O que a pesquisa desta fase (nov/2026) encontrou | Risco |
|---|---|---|---|---|
| 1 | `gemini` | `GEMINI_API_KEY`, `GEMINI_MODEL` (padrão `gemini-2.5-flash`) | Camada gratuita sem cartão, limites baixos e variáveis por modelo (comparativo de abr/2026: ~5–15 req/min, 20–1.500 req/dia). **No plano gratuito o conteúdo pode ser usado para melhorar produtos do Google** (a exceção de treino vale para UE/Reino Unido/EEA). | Nome/limites de modelo mudam; a página oficial lida estava desatualizada → **confirme no AI Studio** |
| 2 | `groq` | `GROQ_API_KEY`, `GROQ_MODEL` (padrão `llama-3.3-70b-versatile`) | Gratuito, sem cartão (~30 req/min, ~1.000 req/dia, segundo comparativo de terceiros); sem treino com seus dados, segundo o mesmo comparativo | Terceiro, não confirmado na página oficial |
| 3 | `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (padrão `openrouter/free`) | Modelos gratuitos: ~20 req/min e ~50 req/dia (1.000/dia após depósito de US$ 10), segundo comparativo | Modelos gratuitos mudam/somem; o id padrão deve ser conferido |
| 4 | `workers-ai` | binding `AI` (já em `wrangler.jsonc`), `WORKERS_AI_MODEL` (padrão `@cf/meta/llama-3.1-8b-instruct`) | **10.000 Neurons/dia grátis**, zera 00:00 UTC; ao estourar no plano Free, as chamadas falham (documentação oficial da Cloudflare) | Modelo menor/qualidade menor em português |
| 5 | `xai` (**Grok**) | `XAI_API_KEY` **e** `XAI_MODEL` (obrigatório) | **A API do Grok não tem camada gratuita publicada**: é cobrada por token. Programas de créditos "por compartilhar dados" aparecem só em páginas de terceiros, não confirmados. | **Pago.** Só ligue se aceitar o custo e os termos. Sem `XAI_MODEL` não entra na cadeia |

Seu pedido foi "grok, Gemini e outras gratuitas": Gemini, Groq, OpenRouter e Workers AI são gratuitos (com os limites acima); **Grok está integrado, mas é pago** — por isso fica por último e desligado até haver chave.

## Privacidade (ler antes de ligar)
Planos gratuitos de alguns provedores **podem usar o conteúdo enviado para melhorar produtos** (Gemini grátis, por exemplo). Por isso o sistema não envia dado de cliente. O painel mostra esse aviso. Para dados mais sensíveis no futuro, use um plano pago com termos de não-treino ou o Workers AI. Registrar o uso de IA e seus subprocessadores nos termos/política (docs/LEGAL.md) é pendência jurídica.

## Como configurar (opcional)
```
npx wrangler secret put GEMINI_API_KEY     # idem GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY
# vars no wrangler.jsonc: GEMINI_MODEL, GROQ_MODEL, OPENROUTER_MODEL, XAI_MODEL, WORKERS_AI_MODEL, AI_PROVIDER_ORDER
```
Depois, o proprietário liga a IA na aba **IA**. Sem nenhuma chave e sem o binding, a aba avisa que não há provedor.
