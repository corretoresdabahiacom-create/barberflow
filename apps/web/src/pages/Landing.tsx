import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { APP_NAME } from "../config/app";
import { PLANS, type PlanDef } from "../config/plans";
import { Button, Card, Logo } from "../components/ui";
import { formatBRL } from "@naregua/shared";
import { useAuth } from "../lib/auth";

interface ApiPlan { id: string; name: string; price_cents: number | null; max_units: number | null; max_professionals: number | null; ai_daily_quota: number; allow_network: number }
const planFeatures = (p: ApiPlan): string[] => [
  p.max_units === null ? "Unidades ilimitadas" : `Até ${p.max_units} unidade(s)`,
  p.max_professionals === null ? "Profissionais ilimitados" : `Até ${p.max_professionals} profissionais`,
  ...(p.ai_daily_quota > 0 ? [`IA assistiva (${p.ai_daily_quota}/dia)`] : []),
  ...(p.allow_network ? ["Rede/franquia com relatório agregado"] : []),
];

export function Landing() {
  const { me } = useAuth();
  const [plans, setPlans] = useState<PlanDef[]>(PLANS);
  // Planos vêm do servidor (editáveis pelo operador); se falhar, mostra a lista estática de reserva.
  useEffect(() => { api<{ plans: ApiPlan[] }>("/public/plans").then((d) => setPlans(d.plans.map((p) => ({ id: p.id, name: p.name, priceCents: p.price_cents, features: planFeatures(p) })))).catch(() => undefined); }, []);
  return (
    <main className="mx-auto max-w-3xl space-y-10 px-4 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between"><Logo /><nav className="flex gap-2">
        {me ? <Link to={me.memberships.length ? "/app" : "/c"}><Button>Abrir</Button></Link> : <Link to="/entrar"><Button variant="ghost">Entrar</Button></Link>}
      </nav></header>
      <section className="space-y-4 pt-6">
        <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">Cabelo na <span className="text-amber">régua</span>.<br />Agenda também.</h1>
        <p className="max-w-xl text-lg text-mute">{APP_NAME} é a agenda online da sua barbearia: o cliente escolhe o barbeiro e o horário pelo celular, sem baixar nada, e você acaba com a dupla reserva.</p>
        <div className="flex flex-wrap gap-3"><Link to="/entrar?novo=1"><Button>Criar minha barbearia</Button></Link><Link to="/descobrir"><Button variant="ghost">Encontrar uma barbearia</Button></Link></div>
      </section>
      <section className="grid gap-3 sm:grid-cols-3">
        {[["Sem dupla reserva", "O banco de dados recusa dois clientes no mesmo horário."], ["QR Code fixo", "Cole no espelho: o link da sua unidade nunca muda."], ["Equipe com permissões", "Barbeiro vê só a própria agenda; dono vê tudo."]].map(([t, d]) => (
          <Card key={t}><h2 className="font-semibold">{t}</h2><p className="mt-1 text-sm text-mute">{d}</p></Card>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-bold">Planos</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.id}><h3 className="font-semibold">{p.name}</h3>
              <p className="text-2xl font-bold text-amber">{p.priceCents === null ? "Em breve" : p.priceCents === 0 ? "Grátis" : formatBRL(p.priceCents)}</p>
              <ul className="mt-2 list-disc pl-5 text-sm text-mute">{p.features.map((f) => <li key={f}>{f}</li>)}</ul></Card>
          ))}
        </div>
      </section>
      <footer className="flex gap-4 text-sm text-mute"><Link to="/termos" className="underline">Termos</Link><Link to="/privacidade" className="underline">Privacidade</Link></footer>
    </main>
  );
}
