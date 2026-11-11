import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, Link } from "react-router-dom";
import { Button, Card, Field, Input, Logo, Notice, Spinner, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { fmtDateTime } from "../../lib/dates";
import { useAuth } from "../../lib/auth";
import { Agenda } from "./Agenda";
import { Professionals, Services } from "./Catalog";
import { AdminContext, orgPath, type UnitInfo } from "./ctx";
import { Automation } from "./Automation";
import { Chat } from "./Chat";
import { Marketing } from "./Marketing";
import { PushToggle } from "../../components/PushToggle";
import { Finance } from "./Finance";
import { Customers, Team } from "./People";
import { Stock } from "./Stock";
import { Reports, Settings } from "./Settings";

const ORG_KEY = "naregua.org";
const safeGet = () => { try { return localStorage.getItem(ORG_KEY); } catch { return null; } };
const safeSet = (v: string) => { try { localStorage.setItem(ORG_KEY, v); } catch { /* ignora */ } };

export function AdminApp() {
  const auth = useAuth();
  if (!auth.ready) return <div className="p-6"><Spinner /></div>;
  if (!auth.user) return <Navigate to="/entrar?next=/app" replace />;
  if (!auth.me) return <div className="p-6"><Spinner /></div>;
  const orgs = [...new Map(auth.me.memberships.map((m) => [m.organizationId, m.organizationName])).entries()];
  if (orgs.length === 0) return <Onboarding />;
  return <Panel orgs={orgs} />;
}

function Onboarding() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("Matriz");
  const [slug, setSlug] = useState("");
  const { busy, error, run } = useAsync();
  const verified = auth.me?.user.emailVerified;
  const slugOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length >= 3;
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-8">
      <Link to="/"><Logo /></Link>
      <h1 className="text-2xl font-bold">Criar minha barbearia</h1>
      {!verified && <Notice kind="warn">Confirme seu e-mail antes de criar a barbearia (enviamos um link). <button className="underline" onClick={() => auth.resendVerification()}>Reenviar</button> · <button className="underline" onClick={() => auth.reloadUser()}>Já confirmei</button></Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <Card className="space-y-3">
        <Field label="Nome da barbearia"><Input value={name} onChange={(e) => { setName(e.target.value); if (!slug) setSlug(""); }} /></Field>
        <Field label="Nome da unidade"><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
        <Field label="Endereço do seu link" hint={`${location.origin}/b/${slug || "sua-barbearia"} — não poderá ser alterado depois (o QR Code fica fixo).`}>
          <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="barbearia-do-ze" />
        </Field>
        <Button disabled={busy || !verified || name.trim().length < 2 || unit.trim().length < 2 || !slugOk}
          onClick={async () => { const r = await run(() => api("/orgs", { method: "POST", auth: true, body: { name: name.trim(), unit: { name: unit.trim(), slug } } })); if (r) await auth.refreshMe(); }}>Criar</Button>
      </Card>
      <div className="flex gap-3 text-sm"><Link to="/c" className="text-amber underline">Sou cliente</Link><button className="text-mute underline" onClick={() => auth.signOut()}>Sair</button></div>
    </main>
  );
}

function Panel({ orgs }: { orgs: [string, string][] }) {
  const auth = useAuth();
  const [orgId, setOrgId] = useState(() => { const s = safeGet(); return orgs.find(([id]) => id === s)?.[0] ?? orgs[0]![0]; });
  const [units, setUnits] = useState<UnitInfo[] | null>(null);
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const orgName = orgs.find(([id]) => id === orgId)?.[1] ?? "";

  const reloadUnits = useCallback(async () => {
    try {
      const [u, o] = await Promise.all([api<{ units: UnitInfo[] }>(orgPath(orgId, "/units"), { auth: true }), api<{ permissions: string[] }>(orgPath(orgId, ""), { auth: true })]);
      setUnits(u.units); setPerms(new Set(o.permissions));
    } catch (e) { setErr(errMsg(e)); }
  }, [orgId]);
  useEffect(() => { setUnits(null); setPerms(null); void reloadUnits(); }, [reloadUnits]);

  const ctx = useMemo(() => units && perms ? { orgId, orgName, units, perms, can: (p: string) => perms.has(p), reloadUnits } : null, [orgId, orgName, units, perms, reloadUnits]);
  const tabs: [string, string, string?][] = [["agenda", "Agenda"], ["profissionais", "Equipe de trabalho", "catalog.read"], ["servicos", "Serviços", "catalog.read"], ["clientes", "Clientes", "customer.read"], ["acessos", "Acessos", "user.manage"], ["relatorios", "Relatórios", "report.read"], ["financeiro", "Financeiro", "finance.read"], ["estoque", "Estoque", "stock.read"], ["conversas", "Conversas", "chat.read"], ["campanhas", "Campanhas", "marketing.manage"], ["automacao", "Automação", "org.manage"], ["avisos", "Avisos"], ["ajustes", "Ajustes", "agenda.read"]];

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link to="/"><Logo /></Link>
        <div className="flex items-center gap-2 text-sm">
          {orgs.length > 1 ? <select aria-label="Organização" className="min-h-11 rounded-xl border border-line bg-coal px-2" value={orgId} onChange={(e) => { setOrgId(e.target.value); safeSet(e.target.value); }}>{orgs.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select> : <span className="text-mute">{orgName}</span>}
          <Link to="/c" className="text-mute underline">Cliente</Link>
          <button className="min-h-11 text-mute underline" onClick={() => auth.signOut()}>Sair</button>
        </div>
      </header>
      {!auth.me?.user.emailVerified && <div className="mb-3"><Notice kind="warn">Seu e-mail ainda não foi confirmado. <button className="underline" onClick={() => auth.reloadUser()}>Já confirmei</button></Notice></div>}
      {err && <Notice kind="error">{err}</Notice>}
      {!ctx ? <Spinner /> : (
        <AdminContext.Provider value={ctx}>
          <nav aria-label="Seções" className="mb-4 flex gap-1 overflow-x-auto pb-1">
            {tabs.filter(([, , p]) => !p || perms!.has(p) || (p === "agenda.read" && (perms!.has("agenda.read_own") || perms!.has("agenda.read")))).map(([to, label]) => (
              <NavLink key={to} to={to} className={({ isActive }) => `min-h-11 shrink-0 rounded-xl px-3 py-2 text-sm ${isActive ? "bg-amber font-semibold text-ink" : "bg-panel text-cream"}`}>{label}</NavLink>
            ))}
          </nav>
          <Routes>
            <Route index element={<Navigate to="agenda" replace />} />
            <Route path="agenda" element={<Agenda />} />
            <Route path="profissionais" element={<Professionals />} />
            <Route path="servicos" element={<Services />} />
            <Route path="clientes" element={<Customers />} />
            <Route path="acessos" element={<Team />} />
            <Route path="relatorios" element={<Reports />} />
            <Route path="financeiro" element={<Finance />} />
            <Route path="estoque" element={<Stock />} />
            <Route path="conversas" element={<Chat />} />
            <Route path="campanhas" element={<Marketing />} />
            <Route path="automacao" element={<Automation />} />
            <Route path="avisos" element={<Notifications />} />
            <Route path="ajustes" element={<Settings />} />
            <Route path="*" element={<Notice>Página não encontrada.</Notice>} />
          </Routes>
        </AdminContext.Provider>
      )}
    </div>
  );
}

function Notifications() {
  const [d, setD] = useState<{ notifications: { id: string; title: string; body: string | null; read_at: string | null; created_at: string }[]; unread: number } | null>(null);
  const { error, setError } = useAsync();
  const load = useCallback(() => api<typeof d>("/me/notifications", { auth: true }).then(setD).catch((e) => setError(errMsg(e))), [setError]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-3">
      {error && <Notice kind="error">{error}</Notice>}
      {d && d.unread > 0 && <Button variant="ghost" onClick={async () => { await api("/me/notifications/read-all", { method: "POST", auth: true, body: {} }); await load(); }}>Marcar todas como lidas</Button>}
      {!d ? <Spinner /> : d.notifications.length === 0 ? <Notice>Sem avisos.</Notice> : d.notifications.map((n) => (
        <Card key={n.id} className={n.read_at ? "opacity-60" : ""}><div className="font-medium">{n.title}</div><div className="text-sm text-mute">{n.body}</div><div className="text-xs text-mute">{fmtDateTime(n.created_at)}</div></Card>
      ))}
      <PushToggle />
      <p className="text-xs text-mute">Avisos internos do painel. WhatsApp não está disponível; e-mail e push dependem de configuração no servidor.</p>
    </div>
  );
}
