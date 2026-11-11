# Documentos legais

Rascunhos de **Termos de Uso** e **Política de Privacidade** sob a legislação brasileira (LGPD, Marco Civil, CDC) estão em `apps/web/src/content/legal.ts` e são exibidos em `/termos` e `/privacidade` com aviso de rascunho.

- Escritos por IA como ponto de partida. **Exigem revisão por advogado(a)** antes de publicar.
- Dados do controlador vêm de `VITE_OPERATOR_NAME`, `VITE_OPERATOR_DOCUMENT`, `VITE_PRIVACY_EMAIL` (sem eles o texto mostra `[PREENCHER]`).
- Papéis LGPD assumidos: cada barbearia = **controladora** dos dados de seus clientes; NaRégua = **operadora**; para cadastro de contas e segurança da plataforma, NaRégua = controladora.
- Implementado no produto: consentimento de marketing separado, opcional e registrado (append-only); exportação e anonimização do titular pelo dono; trilha de auditoria.
- Falta: fluxo para o próprio titular pedir exportação/eliminação sem passar pela barbearia, política de retenção automatizada, registro de operações (art. 37), RIPD, contrato de operador (DPA) para barbearias, aviso de cookies (hoje só armazenamento essencial).

## Fase 3 — pontos para o(a) advogado(a)
- **Marketing**: consentimento separado, específico e revogável; descadastro de 1 clique; registro append-only de cada mudança. Confirmar o texto de coleta do consentimento na reserva.
- **Chat**: conteúdo é dado pessoal; é apagado na anonimização e entra na exportação. Definir prazo de retenção (hoje: indefinido até a anonimização).
- **Vitrine**: só divulga o que o estabelecimento escolhe; avaliações NÃO existem.
- **Push**: depende de permissão do navegador; payload mínimo.

