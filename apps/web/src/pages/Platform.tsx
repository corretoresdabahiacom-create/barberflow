import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { formatBRL } from "@naregua/shared";
import { Button, Card, Field, Input, Logo, Notice, Select, Spinner, useAsync } from "../components/ui";
import { api, errMsg } from "../lib/api";
import { parseBRLToCents } from "../lib/money";
import { useAuth } from "../lib/auth";

interface Plan { id: string; name: string; price_cents: number | null; max_units: number | null; max_professionals: number | null; ai_daily_quota: number; allow_network: number; active: number; sort: number }
interface OrgRow { id: string; name: string; plan_id: string; subscription_status: string | null; valid_until: string | null }

const numOrNull = (s: string): number | null | undefined => (s.trim() === "" ? null : /^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

/** Painel do operador da plataforma (planos editáveis e assinaturas manuais). A autorização é do servidor (404 para quem não é admin). */
export function Platform() {
  const auth = useAuth();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Record<string, { name: string; price: string; units: string; pros: string; ai: string; net: boolean; active: boolean }>>({});
  const [sub, setSub] = useState({ orgId: "", planId: "free", validUntil: "", status: "active" });
  const { busy, error, setError, run } = useAsync();
  const load = () => api<{ plans: Plan[] }>("/platform/plans", { auth: true }).then((d) => {
    setPlans(d.plans);
    setEdit(Object.fromEntries(d.plans.map((p) => [p.id, { name: p.name, price: p.price_cents === null ? "" : (p.price_cents / 100).toFixed(2).replace(".", ","), units: p.max_units === null ? "" : String(p.max_units), pros: p.max_professionals === null ? "" : String(p.max_professionals), ai: String(p.ai_daily_quota), net: p.allow_network === 1, active: p.active === 1 }])));
  }).catch((e) => setError(errMsg(e)));
  useEffect(() => { if (auth.user) void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [auth.user]);
  if (!auth.ready) return <div className="p-6"><Spinner /></div>;
  if (!auth.user) return <Navigate to="/entrar?next=/plataforma" replace />;
  if (error && !plans) return <main className="mx-auto max-w-xl p-6"><Notice kind="error">Área indisponível para esta conta.</Notice></main>;
  if (!plans) return <div className="p-6"><Spinner /></div>;
  const save = async (p: Plan) => {
    const e = edit[p.id]!;
    const price = e.price.trim() === "" ? null : parseBRLToCents(e.price);
    const u = numOrNull(e.units); const pr = numOrNull(e.pros); const ai = numOrNull(e.ai);
    if (price === undefined || u === undefined || pr === undefined || ai === undefined || ai === null || (e.price.trim() !== "" && price === null)) { setError("Confira os números (vazio = a definir/ilimitado)."); return; }
    if (await run(() => api(`/platform/plans/${p.id}`, { method: "PUT", auth: true, body: { name: e.name.trim(), priceCents: price, maxUnits: u, maxProfessionals: pr, aiDailyQuota: ai, allowNetwork: e.net, active: e.active, sort: p.sort } }))) await load();
  };
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <Link to="/"><Logo /></Link>
      <h1 className="text-2xl font-bold">Plataforma</h1>
      {error && <Notice kind="error">{error}</Notice>}
      <Notice>Os valores iniciais dos planos são provisórios — defina os seus. Não há cobrança automática: a assinatura é registrada manualmente.</Notice>
      {plans.map((p) => { const e = edit[p.id]!; const set = (v: Partial<typeof e>) => setEdit({ ...edit, [p.id]: { ...e, ...v } }); return (
        <Card key={p.id} className="space-y-2">
          <h2 className="font-semibold">{p.id}{p.price_cents !== null ? ` · ${formatBRL(p.price_cents)}` : ""}</h2>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Nome"><Input value={e.name} onChange={(x) => set({ name: x.target.value })} /></Field>
            <Field label="Preço mensal (vazio = a definir)"><Input value={e.price} onChange={(x) => set({ price: x.target.value })} /></Field>
            <Field label="Máx. unidades (vazio = ilimitado)"><Input inputMode="numeric" value={e.units} onChange={(x) => set({ units: x.target.value })} /></Field>
            <Field label="Máx. profissionais (vazio = ilimitado)"><Input inputMode="numeric" value={e.pros} onChange={(x) => set({ pros: x.target.value })} /></Field>
            <Field label="IA por dia"><Input inputMode="numeric" value={e.ai} onChange={(x) => set({ ai: x.target.value })} /></Field>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={e.net} onChange={(x) => set({ net: x.target.checked })} />Permite rede/franquia</label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={e.active} disabled={p.id === "free"} onChange={(x) => set({ active: x.target.checked })} />Ativo (aparece na página de planos)</label>
          <Button disabled={busy} onClick={() => void save(p)}>Salvar plano</Button>
        </Card>); })}
      <Card className="space-y-2">
        <h2 className="font-semibold">Assinatura de uma barbearia</h2>
        <div className="flex gap-2"><Input placeholder="Buscar por nome" value={q} onChange={(e) => setQ(e.target.value)} /><Button variant="ghost" disabled={busy} onClick={async () => { const r = await run(() => api<{ organizations: OrgRow[] }>(`/platform/orgs?q=${encodeURIComponent(q)}`, { auth: true })); if (r) setOrgs(r.organizations); }}>Buscar</Button></div>
        {orgs.map((o) => <button key={o.id} className="block min-h-11 w-full rounded-xl bg-panel px-3 text-left text-sm" onClick={() => setSub({ ...sub, orgId: o.id, planId: o.plan_id })}>{o.name} · {o.plan_id}{o.subscription_status === "suspended" ? " (suspensa)" : ""}{sub.orgId === o.id ? " ✓" : ""}</button>)}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Plano"><Select value={sub.planId} onChange={(e) => setSub({ ...sub, planId: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Situação"><Select value={sub.status} onChange={(e) => setSub({ ...sub, status: e.target.value })}><option value="active">Ativa</option><option value="suspended">Suspensa</option></Select></Field>
          <Field label="Vale até (AAAA-MM-DD, vazio = sem fim)"><Input value={sub.validUntil} onChange={(e) => setSub({ ...sub, validUntil: e.target.value })} /></Field>
        </div>
        <Button disabled={busy || !sub.orgId || (sub.validUntil !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(sub.validUntil))} onClick={async () => { if (await run(() => api(`/platform/orgs/${sub.orgId}/subscription`, { method: "PUT", auth: true, body: { planId: sub.planId, status: sub.status, validUntil: sub.validUntil ? `${sub.validUntil}T23:59:59Z` : null, note: null } }))) setError(null); }}>Salvar assinatura</Button>
      </Card>
    </main>
  );
}
