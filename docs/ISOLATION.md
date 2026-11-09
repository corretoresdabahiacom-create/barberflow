# Isolamento entre barbearias (substitui o "RLS")

D1 não tem Row Level Security. Garantias que usamos no lugar, em camadas:

1. **Único caminho de acesso**: só o Worker fala com o D1; o navegador nunca recebe credencial de banco.
2. **Tenant derivado, nunca informado**: `requireOrg` busca os vínculos ativos do usuário autenticado na organização da URL. Sem vínculo → **404** (não revela se o ID existe). O ID na URL jamais autoriza sozinho.
3. **Toda SQL de dado de cliente filtra `organization_id`**, e o `UPDATE`/`DELETE` também.
4. **Chaves estrangeiras compostas** `(organization_id, id)`: o banco recusa um agendamento de A apontando para cliente/profissional de B (teste `banco recusa referência cruzada`).
5. **Varredura estática** (`test/static-tenant.test.ts`): falha se alguma SQL em tabela de tenant não menciona `organization_id`, salvo marcador `tenant-ok: <justificativa>` (hoje: busca pública por slug e por token secreto do agendamento; contagem global de organizações por dono). É rede de proteção, **não prova**: um `JOIN ... organization_id` textual passa na varredura mesmo sem filtrar.
6. **Testes comportamentais** (`test/isolation.test.ts`): matriz de ~45 rotas com o dono de A tentando B (todas 404), IDs de B dentro da URL de A, escrita cruzada em A, listagens, página pública.
7. **Verificação de mutação**: removemos o filtro de tenant de uma consulta de propósito e o teste de isolamento falhou, como deve.

## Limites conhecidos
- Um bug de SQL novo pode vazar dados mesmo com a varredura; por isso toda rota nova entra na matriz de isolamento.
- Notificações e `customer_accounts` são escopo de usuário (têm `user_id`), não de organização, por desenho.
