import { Link } from "react-router-dom";
import { APP_NAME } from "../config/app";
import { PLANS } from "../config/plans";
import { Button, Card, Logo } from "../components/ui";
import { formatBRL } from "@naregua/shared";
import { useAuth } from "../lib/auth";

export function Landing() {
  const { me } = useAuth();
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
        <div className="grid gap-3 sm:grid-cols-2">
          {PLANS.map((p) => (
            <Card key={p.id}><h3 className="font-semibold">{p.name}</h3>
              <p className="text-2xl font-bold text-amber">{p.priceCents === null ? "Em breve" : formatBRL(p.priceCents)}</p>
              <ul className="mt-2 list-disc pl-5 text-sm text-mute">{p.features.map((f) => <li key={f}>{f}</li>)}</ul></Card>
          ))}
        </div>
      </section>
      <footer className="flex gap-4 text-sm text-mute"><Link to="/termos" className="underline">Termos</Link><Link to="/privacidade" className="underline">Privacidade</Link></footer>
    </main>
  );
}
