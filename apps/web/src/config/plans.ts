/**
 * Planos comerciais — EDITÁVEL. Valores ainda não definidos (decisão do responsável):
 * enquanto priceCents for null o site exibe "Em breve" e nenhuma cobrança existe.
 * Cobrança real (gateway) não está implementada nesta fase.
 */
export interface PlanDef { id: string; name: string; priceCents: number | null; features: string[] }
export const PLANS: PlanDef[] = [
  { id: "inicial", name: "Inicial", priceCents: null, features: ["1 unidade", "Agenda e página de reservas", "QR Code"] },
  { id: "profissional", name: "Profissional", priceCents: null, features: ["Várias unidades", "Equipe e permissões", "Relatórios"] },
];
