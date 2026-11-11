# Papéis e permissões

Fonte única: `packages/shared/src/permissions.ts`. O Worker autoriza; o front só esconde botões.

| Permissão | Dono | Admin unidade | Gerente | Barbeiro |
|---|:-:|:-:|:-:|:-:|
| org.manage (dados da org, unidades novas, **LGPD export/anonimizar**) | ✔ | | | |
| user.manage (equipe/convites) | ✔ | | | |
| audit.read | ✔ | | | |
| unit.manage (config da unidade) | ✔ | ✔ própria | | |
| catalog.write — **serviços/preços (org-wide: só dono)**; profissionais e horários da unidade | ✔ | profissionais/horários da unidade | | |
| catalog.read | ✔ | ✔ | ✔ | ✔ |
| agenda.read / write (na unidade) | ✔ | ✔ | ✔ | |
| agenda.read_own / write_own (só o próprio profissional) | ✔ | ✔ | ✔ | ✔ |
| customer.read / write | ✔ | ✔ | ✔ | |
| payment.create | ✔ | ✔ | | só com flag `can_receive_payments`, **apenas nos próprios atendimentos** |
| report.read | ✔ | ✔ | ✔ | |
| finance.read / write (despesas, caixa, relatórios financeiros, na unidade) | ✔ | ✔ | | |
| stock.read / write (saldo e movimentação, na unidade) | ✔ | ✔ | ✔ | |
| chat.read / write (conversas da unidade) | ✔ | ✔ | ✔ | |
| marketing.manage (campanhas; de organização) | ✔ | | | |
| Ligar a vitrine pública da unidade (`unit.manage`) | ✔ | ✔ própria | | |
| Regras de comissão, produtos (catálogo), fidelidade/lembretes (`/automation`), fila de e-mails | ✔ (`org.manage`) | | | |
| Ver as **próprias** comissões (`/finance/commissions/mine`) | ✔ se for profissional | se vinculado | se vinculado | ✔ se vinculado a um profissional |

Regras: permissões de organização exigem vínculo da organização inteira (`unit_id` nulo, só o dono); as demais valem na unidade do vínculo. Barbeiro vê agendamento fora da própria agenda como **404**; escrita não autorizada é 403. Não é possível atribuir `owner` via API, rebaixar/suspender/remover o último dono ativo. Trocar de profissional ou forçar encaixe (`override`) exige permissão plena na unidade.

**Limitação conhecida:** profissional só é vinculado a um login (`memberId`) pelo dono/admin; sem vínculo, o barbeiro não enxerga agenda alguma.
