import { useCallback, useEffect, useState } from "react";
import { formatBRL } from "@naregua/shared";
import { Button, Card, Field, Input, Notice, Select, Spinner, useAsync } from "../../components/ui";
import { api, errMsg, newIdemKey } from "../../lib/api";
import { addDaysStr, fmtDateTime, todayIn } from "../../lib/dates";
import { parseBRLToCents } from "../../lib/money";
import { orgPath, useAdmin } from "./ctx";

interface Session { id: string; unit_id: string; opening_cents: number; opened_at: string; closed_at: string | null; counted_cents: number | null; expected_cents: number | null; difference_cents: number | null; running_expected_cents: number | null }
interface Expense { id: string; unit_id: string; category: string; description: string | null; amount_cents: number; paid_with: string; reverses_id: string | null; created_at: string }
interface Summary { servicesReceivedCents: number; productSalesCents: number; expensesCents: number; commissionsCents: number; resultCents: number }
interface Commission { professional_id: string; name: string; appointments: number; base_cents: number; commission_cents: number }

const range = (from: string, to: string) => `from=${encodeURIComponent(`${from}T03:00:00Z`)}&to=${encodeURIComponent(`${addDaysStr(to, 1)}T03:00:00Z`)}`;

export function Finance() {
  const { orgId, units, can } = useAdmin();
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  if (!can("finance.read")) return <Notice>Seu papel não inclui o financeiro.</Notice>;
  return (
    <div className="space-y-4">
      {units.length > 1 && <Field label="Unidade"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>}
      <CashCard key={`c${unitId}`} orgId={orgId} unitId={unitId} canWrite={can("finance.write")} />
      <ExpensesCard key={`e${unitId}`} orgId={orgId} unitId={unitId} canWrite={can("finance.write")} />
      <SummaryCard key={`s${unitId}`} orgId={orgId} unitId={unitId} />
      {can("org.manage") && <RulesCard orgId={orgId} />}
    </div>
  );
}

function CashCard({ orgId, unitId, canWrite }: { orgId: string; unitId: string; canWrite: boolean }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [opening, setOpening] = useState("");
  const [counted, setCounted] = useState("");
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api<{ sessions: Session[] }>(orgPath(orgId, `/cash?unitId=${unitId}&limit=10`), { auth: true }).then((r) => setSessions(r.sessions)).catch((e) => setError(errMsg(e))), [orgId, unitId, setError]);
  useEffect(() => { void load(); }, [load]);
  const open = sessions?.find((s) => !s.closed_at);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Caixa</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {!sessions ? <Spinner /> : open ? (
        <div className="space-y-2">
          <p className="text-sm">Aberto em {fmtDateTime(open.opened_at)} com {formatBRL(open.opening_cents)}.</p>
          <p className="text-sm">Esperado agora em dinheiro: <b>{formatBRL(open.running_expected_cents ?? 0)}</b> <span className="text-mute">(abertura + recebimentos em dinheiro − despesas em dinheiro)</span></p>
          {canWrite && <div className="flex flex-wrap items-end gap-2"><Field label="Dinheiro contado (R$)"><Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0,00" /></Field>
            <Button disabled={busy || parseBRLToCents(counted) === null} onClick={async () => { const c = parseBRLToCents(counted); if (c === null) return; if (await run(() => api(orgPath(orgId, `/cash/${open.id}/close`), { method: "POST", auth: true, body: { countedCents: c } }))) { setCounted(""); await load(); } }}>Fechar caixa</Button></div>}
        </div>
      ) : canWrite ? (
        <div className="flex flex-wrap items-end gap-2"><Field label="Troco inicial (R$)"><Input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0,00" /></Field>
          <Button disabled={busy || parseBRLToCents(opening) === null} onClick={async () => { const c = parseBRLToCents(opening); if (c === null) return; if (await run(() => api(orgPath(orgId, "/cash/open"), { method: "POST", auth: true, body: { unitId, openingCents: c } }))) { setOpening(""); await load(); } }}>Abrir caixa</Button></div>
      ) : <Notice>Nenhum caixa aberto.</Notice>}
      {sessions && sessions.filter((s) => s.closed_at).length > 0 && (
        <details><summary className="cursor-pointer text-sm text-mute">Fechamentos anteriores</summary>
          <ul className="mt-2 space-y-1 text-sm">{sessions.filter((s) => s.closed_at).map((s) => (
            <li key={s.id}>{fmtDateTime(s.closed_at!)} — esperado {formatBRL(s.expected_cents ?? 0)}, contado {formatBRL(s.counted_cents ?? 0)}, diferença <b className={(s.difference_cents ?? 0) === 0 ? "" : "text-amber"}>{formatBRL(s.difference_cents ?? 0)}</b></li>))}</ul></details>
      )}
      <p className="text-xs text-mute">Vendas de produtos do estoque ainda não entram no caixa.</p>
    </Card>
  );
}

function ExpensesCard({ orgId, unitId, canWrite }: { orgId: string; unitId: string; canWrite: boolean }) {
  const [list, setList] = useState<Expense[] | null>(null);
  const [f, setF] = useState({ category: "", amount: "", paidWith: "cash", description: "" });
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api<{ expenses: Expense[] }>(orgPath(orgId, `/expenses?${range(addDaysStr(todayIn(), -29), todayIn())}&unitId=${unitId}`), { auth: true }).then((r) => setList(r.expenses)).catch((e) => setError(errMsg(e))), [orgId, unitId, setError]);
  useEffect(() => { void load(); }, [load]);
  const reversed = new Set((list ?? []).filter((e) => e.reverses_id).map((e) => e.reverses_id));
  const cents = parseBRLToCents(f.amount);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Despesas (30 dias)</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {canWrite && <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Categoria"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Aluguel" /></Field>
        <Field label="Valor (R$)"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0,00" /></Field>
        <Field label="Pago com"><Select value={f.paidWith} onChange={(e) => setF({ ...f, paidWith: e.target.value })}><option value="cash">Dinheiro do caixa</option><option value="other">Outro meio</option></Select></Field>
        <div className="flex items-end"><Button disabled={busy || f.category.trim().length < 2 || !cents} onClick={async () => { if (!cents) return; if (await run(() => api(orgPath(orgId, "/expenses"), { method: "POST", auth: true, headers: { "Idempotency-Key": newIdemKey() }, body: { unitId, category: f.category.trim(), amountCents: cents, paidWith: f.paidWith, description: f.description || null } }))) { setF({ category: "", amount: "", paidWith: "cash", description: "" }); await load(); } }}>Lançar</Button></div>
      </div>}
      {!list ? <Spinner /> : list.length === 0 ? <Notice>Nenhuma despesa no período.</Notice> : (
        <ul className="divide-y divide-line text-sm">{list.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className={e.reverses_id || reversed.has(e.id) ? "text-mute line-through" : ""}>{fmtDateTime(e.created_at)} · {e.category}{e.reverses_id ? " (estorno)" : ""} · {e.paid_with === "cash" ? "dinheiro" : "outro"}</span>
            <span className="flex items-center gap-2"><b>{e.reverses_id ? "−" : ""}{formatBRL(e.amount_cents)}</b>
              {canWrite && !e.reverses_id && !reversed.has(e.id) && <Button variant="ghost" disabled={busy} onClick={async () => { const reason = window.prompt("Motivo do estorno:"); if (!reason || reason.trim().length < 3) return; if (await run(() => api(orgPath(orgId, `/expenses/${e.id}/reverse`), { method: "POST", auth: true, headers: { "Idempotency-Key": newIdemKey() }, body: { reason: reason.trim() } }))) await load(); }}>Estornar</Button>}</span>
          </li>))}</ul>
      )}
      <p className="text-xs text-mute">Lançamentos não podem ser editados nem apagados: para corrigir, faça um estorno.</p>
    </Card>
  );
}

function SummaryCard({ orgId, unitId }: { orgId: string; unitId: string }) {
  const [from, setFrom] = useState(addDaysStr(todayIn(), -29));
  const [to, setTo] = useState(todayIn());
  const [s, setS] = useState<Summary | null>(null);
  const [c, setC] = useState<Commission[] | null>(null);
  const { error, setError } = useAsync();
  useEffect(() => {
    setS(null); setC(null);
    const q = `${range(from, to)}&unitId=${unitId}`;
    api<Summary>(orgPath(orgId, `/finance/summary?${q}`), { auth: true }).then(setS).catch((e) => setError(errMsg(e)));
    api<{ commissions: Commission[] }>(orgPath(orgId, `/finance/commissions?${q}`), { auth: true }).then((r) => setC(r.commissions)).catch((e) => setError(errMsg(e)));
  }, [orgId, unitId, from, to, setError]);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Resultado do período</h2>
      <div className="flex flex-wrap gap-2"><Field label="De"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Até"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {error && <Notice kind="error">{error}</Notice>}
      {!s ? <Spinner /> : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>Serviços recebidos</dt><dd className="text-right">{formatBRL(s.servicesReceivedCents)}</dd>
          <dt>Produtos vendidos</dt><dd className="text-right">{formatBRL(s.productSalesCents)}</dd>
          <dt>Despesas</dt><dd className="text-right">− {formatBRL(s.expensesCents)}</dd>
          <dt>Comissões</dt><dd className="text-right">− {formatBRL(s.commissionsCents)}</dd>
          <dt className="font-semibold">Resultado</dt><dd className="text-right font-semibold">{formatBRL(s.resultCents)}</dd>
        </dl>)}
      {c && c.length > 0 && <table className="w-full text-sm"><thead><tr className="text-left text-mute"><th>Profissional</th><th className="text-right">Atend.</th><th className="text-right">Comissão</th></tr></thead>
        <tbody>{c.map((r) => <tr key={r.professional_id}><td>{r.name}</td><td className="text-right">{r.appointments}</td><td className="text-right">{formatBRL(r.commission_cents)}</td></tr>)}</tbody></table>}
      <p className="text-xs text-mute">Regime de caixa simplificado: o que foi registrado como recebido, menos despesas e comissões congeladas na conclusão. Não é contabilidade nem apuração de impostos.</p>
    </Card>
  );
}

function RulesCard({ orgId }: { orgId: string }) {
  const [pros, setPros] = useState<{ id: string; name: string }[]>([]);
  const [rules, setRules] = useState<{ id: string; professional_id: string; service_id: string | null; rate_bp: number }[]>([]);
  const [pid, setPid] = useState("");
  const [pct, setPct] = useState("");
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api<{ professionals: { id: string; name: string }[] }>(orgPath(orgId, "/professionals"), { auth: true }), api<{ rules: typeof rules }>(orgPath(orgId, "/commission-rules"), { auth: true })]);
      setPros(p.professionals); setRules(r.rules); setPid((cur) => cur || p.professionals[0]?.id || "");
    } catch (e) { setError(errMsg(e)); }
  }, [orgId, setError]);
  useEffect(() => { void load(); }, [load]);
  const p = Number(pct.replace(",", "."));
  const valid = pct.trim() !== "" && Number.isFinite(p) && p >= 0 && p <= 100;
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">Comissão padrão por profissional</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Profissional"><Select value={pid} onChange={(e) => setPid(e.target.value)}>{pros.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Comissão (%)"><Input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="40" /></Field>
        <Button disabled={busy || !pid || !valid} onClick={async () => { if (await run(() => api(orgPath(orgId, "/commission-rules"), { method: "PUT", auth: true, body: { professionalId: pid, rateBp: Math.round(p * 100) } }))) { setPct(""); await load(); } }}>Salvar</Button>
      </div>
      <ul className="text-sm">{rules.filter((r) => !r.service_id).map((r) => <li key={r.id}>{pros.find((x) => x.id === r.professional_id)?.name ?? "—"}: {(r.rate_bp / 100).toLocaleString("pt-BR")}%</li>)}</ul>
      <p className="text-xs text-mute">Vale para atendimentos concluídos daqui em diante; o que já foi concluído não muda. Regras por serviço estão disponíveis na API.</p>
    </Card>
  );
}
