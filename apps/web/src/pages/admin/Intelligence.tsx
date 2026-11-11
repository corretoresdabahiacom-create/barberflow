import { useCallback, useEffect, useState } from "react";
import { formatBRL } from "@naregua/shared";
import { Button, Card, Field, Input, Notice, Select, Spinner, Textarea, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { orgPath, useAdmin } from "./ctx";

interface AiStatus { enabled: boolean; providers: string[]; orgDailyQuota: number; planDailyQuota: number; effectiveDailyQuota: number; usedToday: number; notice: string }
interface Metrics { periodDays: number; appointments: Record<string, number>; completedRevenueCents: number; newCustomers: number; topServices: { name: string; count: number; revenueCents: number }[] }

export function Intelligence() {
  const { orgId, can } = useAdmin();
  const [st, setSt] = useState<AiStatus | null>(null);
  const [quota, setQuota] = useState("20");
  const [days, setDays] = useState("30");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [copy, setCopy] = useState<{ subject: string; body: string } | null>(null);
  const [goal, setGoal] = useState("");
  const [tone, setTone] = useState("amigavel");
  const [svc, setSvc] = useState({ name: "", details: "" });
  const [desc, setDesc] = useState<string | null>(null);
  const { busy, error, setError, run } = useAsync();
  const isOwner = can("org.manage");
  const load = useCallback(() => api<AiStatus>(orgPath(orgId, "/ai"), { auth: true }).then((d) => { setSt(d); setQuota(String(d.orgDailyQuota)); }).catch((e) => setError(errMsg(e))), [orgId, setError]);
  useEffect(() => { void load(); }, [load]);
  if (!st) return error ? <Notice kind="error">{error}</Notice> : <Spinner />;
  const q = Number(quota);
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <Notice kind="warn">{st.notice}</Notice>
      {st.providers.length === 0 && <Notice kind="warn">Nenhum provedor de IA configurado no servidor (veja docs/AI.md). Os recursos abaixo ficam indisponíveis até configurar pelo menos uma chave gratuita.</Notice>}
      <Card className="space-y-2">
        <h2 className="text-lg font-semibold">IA nesta barbearia</h2>
        <p className="text-sm text-mute">Hoje: {st.usedToday} de {st.effectiveDailyQuota} usos (menor valor entre sua cota e a do plano). Provedores ativos: {st.providers.join(", ") || "nenhum"}.</p>
        {isOwner && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Cota diária da barbearia"><Input inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} /></Field>
            <Button disabled={busy || !Number.isInteger(q) || q < 0 || q > 1000} onClick={async () => { if (await run(() => api(orgPath(orgId, "/ai/settings"), { method: "PUT", auth: true, body: { enabled: !st.enabled, dailyQuota: q } }))) await load(); }}>{st.enabled ? "Desligar IA" : "Ligar IA"}</Button>
          </div>)}
        {!isOwner && !st.enabled && <p className="text-sm text-mute">Peça ao proprietário para ligar a IA.</p>}
      </Card>

      {st.enabled && can("marketing.manage") && (
        <Card className="space-y-2">
          <h3 className="font-semibold">Texto de campanha</h3>
          <Field label="Objetivo" hint="Não escreva dados de clientes (nome, telefone, e-mail)."><Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Trazer de volta quem não vem há 2 meses" /></Field>
          <Field label="Tom"><Select value={tone} onChange={(e) => setTone(e.target.value)}><option value="amigavel">Amigável</option><option value="formal">Formal</option><option value="divertido">Divertido</option></Select></Field>
          <Button disabled={busy || goal.trim().length < 5} onClick={async () => { const r = await run(() => api<{ suggestion: { subject: string; body: string } }>(orgPath(orgId, "/ai/campaign-copy"), { method: "POST", auth: true, body: { goal: goal.trim(), tone } })); if (r) { setCopy(r.suggestion); await load(); } }}>Sugerir</Button>
          {copy && <div className="space-y-1 rounded-xl border border-line p-3"><p className="font-medium">{copy.subject}</p><Textarea readOnly rows={6} value={copy.body} /><p className="text-xs text-mute">Revise e copie para Campanhas. Nada é salvo nem enviado automaticamente.</p></div>}
        </Card>)}

      {st.enabled && can("catalog.write") && (
        <Card className="space-y-2">
          <h3 className="font-semibold">Descrição de serviço</h3>
          <Field label="Serviço"><Input value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} placeholder="Corte + barba" /></Field>
          <Field label="Detalhes (opcional)"><Input value={svc.details} onChange={(e) => setSvc({ ...svc, details: e.target.value })} /></Field>
          <Button disabled={busy || svc.name.trim().length < 2} onClick={async () => { const r = await run(() => api<{ description: string }>(orgPath(orgId, "/ai/service-description"), { method: "POST", auth: true, body: { serviceName: svc.name.trim(), ...(svc.details.trim() ? { details: svc.details.trim() } : {}) } })); if (r) { setDesc(r.description); await load(); } }}>Sugerir descrição</Button>
          {desc && <p className="rounded-xl border border-line p-3 text-sm">{desc}</p>}
        </Card>)}

      {isOwner && (
        <Card className="space-y-2">
          <h3 className="font-semibold">Resumo do período</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Dias (7–90)"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
            <Button variant="ghost" disabled={busy} onClick={async () => { const r = await run(() => api<{ metrics: Metrics }>(orgPath(orgId, `/ai/metrics?days=${Number(days) || 30}`), { auth: true })); if (r) setMetrics(r.metrics); }}>Ver números</Button>
            {st.enabled && <Button disabled={busy} onClick={async () => { const r = await run(() => api<{ metrics: Metrics; summary: string }>(orgPath(orgId, "/ai/insights"), { method: "POST", auth: true, body: { days: Number(days) || 30 } })); if (r) { setMetrics(r.metrics); setSummary(r.summary); await load(); } }}>Explicar com IA</Button>}
          </div>
          {metrics && <ul className="text-sm text-mute"><li>Concluídos: {metrics.appointments.completed ?? 0} · faltas: {metrics.appointments.no_show ?? 0} · cancelados: {metrics.appointments.cancelled ?? 0}</li><li>Receita dos concluídos: {formatBRL(metrics.completedRevenueCents)} · clientes novos: {metrics.newCustomers}</li>{metrics.topServices.map((s) => <li key={s.name}>{s.name}: {s.count}</li>)}</ul>}
          {summary && <pre className="whitespace-pre-wrap rounded-xl border border-line p-3 font-sans text-sm">{summary}</pre>}
          <p className="text-xs text-mute">Só números agregados são enviados à IA — nenhum dado de cliente.</p>
        </Card>)}
    </div>
  );
}
