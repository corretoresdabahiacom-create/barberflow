import { APP_NAME, OPERATOR } from "../config/app";

/**
 * RASCUNHO de documentos legais conforme a legislação brasileira (LGPD – Lei 13.709/2018,
 * Marco Civil da Internet – Lei 12.965/2014, CDC – Lei 8.078/1990).
 * Redigido por IA como ponto de partida: NÃO substitui revisão por advogado(a) antes da publicação.
 * Texto editável: ajuste aqui e preencha os dados do controlador em src/config/app.ts (variáveis VITE_OPERATOR_*).
 */
export interface Section { title: string; body: string[] }

export const LEGAL_VERSION = "2026-11-rascunho-1";

export const TERMS: Section[] = [
  { title: "1. Quem somos", body: [`${APP_NAME} é uma plataforma de agendamento e gestão para barbearias, operada por ${OPERATOR.name}, inscrita sob o documento ${OPERATOR.document}.`, "Cada barbearia é responsável pelos serviços que presta, preços, horários e atendimento. A plataforma apenas intermedeia o agendamento."] },
  { title: "2. Uso por clientes", body: ["Você pode agendar sem criar conta, informando nome e telefone. Criar conta permite acompanhar seus agendamentos.", "Você se compromete a informar dados verdadeiros e a comparecer ou cancelar dentro do prazo definido pela barbearia. Faltas repetidas podem levar a restrições definidas pela barbearia."] },
  { title: "3. Uso por barbearias", body: ["O titular da conta é responsável pelos acessos concedidos à equipe, pelo cadastro de serviços e preços e pelo tratamento dos dados de seus clientes, atuando como controlador desses dados; a plataforma atua como operadora.", "É proibido usar a plataforma para fins ilícitos, enviar mensagens não solicitadas (spam) ou tentar acessar dados de outras barbearias."] },
  { title: "4. Pagamentos", body: ["Nesta versão, a plataforma não processa pagamentos: o registro de recebimentos é manual e feito pela barbearia. Preços e planos da plataforma, quando existirem, serão informados antes de qualquer cobrança."] },
  { title: "5. Disponibilidade e responsabilidade", body: ["Buscamos manter o serviço disponível, mas não garantimos funcionamento ininterrupto. Não nos responsabilizamos por indisponibilidade de internet, de provedores terceiros ou por conflitos entre cliente e barbearia, sem prejuízo dos direitos garantidos pelo Código de Defesa do Consumidor."] },
  { title: "6. Alterações e contato", body: ["Podemos atualizar estes Termos; mudanças relevantes serão avisadas no aplicativo.", `Dúvidas: ${OPERATOR.contactEmail}. Foro: o do domicílio do consumidor, nos termos do CDC.`] },
];

export const PRIVACY: Section[] = [
  { title: "1. Controlador e contato (LGPD)", body: [`Para os dados de cadastro da conta e de uso da plataforma, o controlador é ${OPERATOR.name} (${OPERATOR.document}). Para os dados de clientes de cada barbearia, a barbearia é a controladora e ${APP_NAME} é operadora.`, `Canal do titular e do encarregado: ${OPERATOR.contactEmail}.`] },
  { title: "2. Dados que coletamos", body: ["Cliente: nome, telefone, e-mail (opcional), histórico de agendamentos, consentimentos de comunicação.", "Equipe/donos: nome, e-mail, papéis e registros de auditoria de ações.", "Técnicos: endereço IP em registros de segurança e limitação de abuso; sem rastreadores de publicidade."] },
  { title: "3. Para quê usamos (bases legais)", body: ["Execução de contrato/procedimentos preliminares (art. 7º, V): realizar e gerenciar o agendamento.", "Legítimo interesse (art. 7º, IX): segurança, prevenção a fraude e abuso.", "Consentimento (art. 7º, I): comunicações de marketing — opcional, separado e revogável a qualquer momento.", "Cumprimento de obrigação legal (art. 7º, II), quando aplicável."] },
  { title: "4. Compartilhamento", body: ["Provedores de infraestrutura que operam o serviço: Cloudflare (hospedagem, banco de dados e verificação anti-robô) e Google/Firebase (autenticação). Alguns operam fora do Brasil; a transferência internacional ocorre com base no art. 33 da LGPD. Não vendemos dados."] },
  { title: "5. Retenção", body: ["Mantemos os dados enquanto a conta da barbearia estiver ativa. Registros de auditoria e financeiros podem ser mantidos pelo prazo necessário a obrigações legais e à defesa de direitos. Após pedido de eliminação, os dados pessoais são anonimizados, preservando registros agregados sem identificar a pessoa."] },
  { title: "6. Seus direitos (art. 18)", body: ["Confirmação de tratamento, acesso, correção, anonimização/eliminação, portabilidade, informação sobre compartilhamento e revogação do consentimento. Peça à barbearia ou pelo canal acima; responderemos em prazo razoável. Você também pode reclamar à ANPD."] },
  { title: "7. Segurança", body: ["Isolamento de dados entre barbearias, controle de acesso por papel, comunicação criptografada (HTTPS), trilha de auditoria e limites contra abuso. Nenhum sistema é 100% seguro; em caso de incidente relevante comunicaremos titulares e a ANPD conforme a lei."] },
  { title: "8. Crianças e adolescentes", body: ["O serviço não é direcionado a menores de 18 anos sem acompanhamento de responsável legal (art. 14)."] },
  { title: "9. Cookies e armazenamento", body: ["Usamos apenas armazenamento essencial (sessão de login e preferências do app). Não usamos cookies de publicidade."] },
];
