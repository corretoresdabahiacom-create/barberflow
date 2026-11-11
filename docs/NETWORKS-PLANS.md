# Redes/franquias, planos e assinatura (Fase 4)

## Redes
- Cada barbearia segue **isolada**. Só 4 números agregados cruzam o limite: atendimentos concluídos, receita dos concluídos, clientes novos (quantidade) e faltas (quantidade). **Nenhum dado de cliente.**
- Fluxo com consentimento: a administradora cria a rede (plano com `allow_network`) → gera convite de **uso único, 7 dias, guardado só como hash** (máx. 5 abertos) → o proprietário da outra barbearia entra com `acceptSharing: true` (aceite registrado: quem, quando, e quais campos na auditoria) → pode **sair a qualquer momento** (o compartilhamento termina na hora e a administradora é avisada na auditoria).
- Uma barbearia participa de **uma** rede. Administradora vê uma linha por barbearia; membro vê só a própria linha + total da rede. Quem está fora da rede recebe 404.
- Só o proprietário (`org.manage`) usa as rotas de rede.

## Planos (editáveis, sem preço no código)
- Tabela `plans` (preço nulo = "a definir", limites nulos = ilimitado, cota de IA/dia, permite rede, ativo). Os valores iniciais (`free` 2 unidades/5 profissionais/10 IA; `pro` 5/20/50; `rede` ilimitado/200/rede) são **placeholders de produto, não decisão comercial** — edite em `/plataforma`.
- Limites aplicados ao **criar** unidade e profissional (409 `plan_limit`). Verificação antes de inserir: duas criações simultâneas no limite podem passar por 1 (melhor esforço).
- Assinatura **manual** (`org_subscriptions`): plano, situação, validade. Vencida, suspensa ou com plano desativado → vale o limite do `free`. Nada é apagado nem bloqueado em dados existentes.
- Administração da plataforma: e-mails (verificados) em `PLATFORM_ADMIN_EMAILS`; todos os demais recebem 404 em `/api/platform/*`. Mudanças de assinatura entram na auditoria da barbearia.
- **Cobrança automática NÃO existe**: sem gateway, sem cartão, sem Pix automático, sem notas fiscais. Opção futura para o Brasil: Mercado Pago (assinaturas/Pix) — exige conta, webhooks assinados e revisão fiscal; não iniciado.
