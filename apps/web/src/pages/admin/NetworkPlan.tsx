import { useCallback, useEffect, useState } from "react";
import { formatBRL } from "@naregua/shared";
import { Button, Card, Field, Input, Notice, Spinner, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { orgPath, useAdmin } from "./ctx";

interface PlanInfo { id: string; name: string; priceCents: number | null; maxUnits: number | null; maxProfessionals: number | null; aiDailyQuota: number; allowNetwork: boolean }

const lim = (n: number | null) => (n === null ? "ilimitado" : String(n));

export function PlanTab() {
  const { orgId } = useAdmin();
  const [d, setD] = useState<{ plan: PlanInfo; usage: { units: number; professionals: number }; subscription: { status: string; valid_until: string | null } | null } | null>(null);
  const { error, setError } = useAsync();
  useEffect(() => { api<NonNullable<typeof d>>(orgPath(orgId, "/plan"), { auth: true }).then(setD).catch((e) => setError(errMsg(e))); }, [orgId, setError]);
  if (!d) return error ? <Notice kind="error">{error}</Notice> : <Spinner />;
  return (
    <Card className="space-y-2">
      <h2 className="text-lg font-semibold">Plano {d.plan.name}</h2>
      <p className="text-sm text-mute">{d.plan.priceCents === null ? "Preço a definir" : d.plan.priceCents === 0 ? "Grátis" : `${formatBRL(d.plan.priceCents)}/mês`}</p>
      <ul className="text-sm">
        <li>Unidades: {d.usage.units} de {lim(d.plan.maxUnits)}</li>
        <li>Profissionais ativos: {d.usage.professionals} de {lim(d.plan.maxProfessionals)}</li>
        <li>IA: até {d.plan.aiDailyQuota} usos por dia</li>
        <li>Rede/franquia: {d.plan.allowNetwork ? "incluída" : "não incluída"}</li>
      </ul>
      {d.subscription?.valid_until && <p className="text-sm text-mute">Vale até {new Date(d.subscription.valid_until).toLocaleDateString("pt-BR")}{d.subscription.status === "suspended" ? " (suspensa)" : ""}.</p>}
      <p className="text-xs text-mute">A cobrança ainda é manual: para mudar de plano, fale com o suporte. Se o plano vencer, nada é apagado — só não dá para criar além do limite do plano gratuito.</p>
    </Card>
  );
}

interface NetData { network: { id: string; name: string; role: "admin" | "member"; memberCount: number } | null; canCreate?: boolean; members?: { organization_id: string; name: string }[]; sharedFields: string[] }
interface Report { memberCount: number; total: { completed: number; revenue_cents: number; new_customers: number; no_shows: number }; organizations: { organization_id: string; name: string; completed: number; revenue_cents: number; new_customers: number; no_shows: number }[] }
const FIELD_LABEL: Record<string, string> = { completed_appointments: "atendimentos concluídos", completed_revenue_cents: "receita dos concluídos", new_customers: "clientes novos (quantidade)", no_shows: "faltas (quantidade)" };

export function NetworkTab() {
  const { orgId } = useAdmin();
  const [d, setD] = useState<NetData | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [accept, setAccept] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [rep, setRep] = useState<Report | null>(null);
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api<NetData>(orgPath(orgId, "/network"), { auth: true }).then(setD).catch((e) => setError(errMsg(e))), [orgId, setError]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return error ? <Notice kind="error">{error}</Notice> : <Spinner />;
  const shared = d.sharedFields.map((f) => FIELD_LABEL[f] ?? f).join(", ");
  const loadReport = () => {
    const to = new Date(); const from = new Date(to.getTime() - 30 * 86400_000);
    return run(() => api<Report>(orgPath(orgId, `/network/report?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`), { auth: true })).then((r) => r && setRep(r));
  };
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <Notice>Em uma rede, só números agregados são compartilhados ({shared}) e só depois do aceite do proprietário de cada barbearia. Nenhum dado de cliente. Você pode sair quando quiser.</Notice>
      {!d.network ? (
        <>
          {d.canCreate && (
            <Card className="space-y-2">
              <h2 className="text-lg font-semibold">Criar rede</h2>
              <Field label="Nome da rede"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Button disabled={busy || name.trim().length < 2} onClick={async () => { if (await run(() => api(orgPath(orgId, "/network"), { method: "POST", auth: true, body: { name: name.trim() } }))) await load(); }}>Criar</Button>
            </Card>)}
          <Card className="space-y-2">
            <h2 className="text-lg font-semibold">Entrar em uma rede</h2>
            <Field label="Código do convite"><Input value={code} onChange={(e) => setCode(e.target.value.trim())} /></Field>
            <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-5" checked={accept} onChange={(e) => setAccept(e.target.checked)} /><span>Autorizo compartilhar com a administradora da rede: {shared}.</span></label>
            <Button disabled={busy || !accept || code.length < 10} onClick={async () => { if (await run(() => api(orgPath(orgId, "/network/join"), { method: "POST", auth: true, body: { code, acceptSharing: true } }))) { setCode(""); setAccept(false); await load(); } }}>Entrar na rede</Button>
          </Card>
        </>
      ) : (
        <Card className="space-y-2">
          <h2 className="text-lg font-semibold">{d.network.name}</h2>
          <p className="text-sm text-mute">{d.network.role === "admin" ? "Você administra esta rede" : "Você é membro"} · {d.network.memberCount} barbearia(s)</p>
          {d.network.role === "admin" && (
            <div className="space-y-2">
              <Button variant="ghost" disabled={busy} onClick={async () => { const r = await run(() => api<{ code: string }>(orgPath(orgId, "/network/invites"), { method: "POST", auth: true })); if (r) setNewCode(r.code); }}>Gerar convite (7 dias, uso único)</Button>
              {newCode && <p className="break-all rounded-xl border border-line p-2 font-mono text-sm">{newCode}<br /><span className="font-sans text-xs text-mute">Aparece só agora. Envie ao proprietário convidado.</span></p>}
              {d.members?.filter((m) => m.organization_id !== orgId).map((m) => (
                <div key={m.organization_id} className="flex items-center justify-between gap-2 text-sm"><span>{m.name}</span><Button variant="danger" disabled={busy} onClick={async () => { if (window.confirm(`Remover ${m.name} da rede?`) && await run(() => api(orgPath(orgId, `/network/members/${m.organization_id}`), { method: "DELETE", auth: true }))) await load(); }}>Remover</Button></div>))}
            </div>)}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => void loadReport()}>Ver relatório (30 dias)</Button>
            <Button variant="danger" disabled={busy} onClick={async () => { if (window.confirm(d.network!.role === "admin" ? "Encerrar a rede?" : "Sair da rede? O compartilhamento termina agora.") && await run(() => api(orgPath(orgId, "/network/leave"), { method: "POST", auth: true }))) { setRep(null); await load(); } }}>{d.network.role === "admin" ? "Encerrar rede" : "Sair da rede"}</Button>
          </div>
          {rep && (
            <div className="space-y-1 text-sm">
              <p className="font-medium">Total da rede: {rep.total.completed} atendimentos · {formatBRL(rep.total.revenue_cents)} · {rep.total.new_customers} clientes novos · {rep.total.no_shows} faltas</p>
              {rep.organizations.map((o) => <p key={o.organization_id} className="text-mute">{o.name}: {o.completed} atend. · {formatBRL(o.revenue_cents)} · {o.new_customers} novos · {o.no_shows} faltas</p>)}
            </div>)}
        </Card>)}
    </div>
  );
}
