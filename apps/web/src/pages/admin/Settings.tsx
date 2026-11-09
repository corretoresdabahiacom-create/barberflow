import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { formatBRL } from "@naregua/shared";
import { Button, Card, Field, Input, Notice, Select, Spinner, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { addDaysStr, todayIn } from "../../lib/dates";
import { orgPath, useAdmin, type UnitInfo } from "./ctx";

export function Settings() {
  const { units, can } = useAdmin();
  return <div className="space-y-4">{units.map((u) => <UnitCard key={u.id} unit={u} editable={can("unit.manage")} />)}</div>;
}

function UnitCard({ unit, editable }: { unit: UnitInfo; editable: boolean }) {
  const { orgId, reloadUnits } = useAdmin();
  const [f, setF] = useState({ name: unit.name, address: unit.address ?? "", phone: unit.phone ?? "", autoConfirm: unit.auto_confirm === 1, minNoticeMin: unit.min_notice_min, maxDaysAhead: unit.max_days_ahead, slotStepMin: unit.slot_step_min, cancelWindowMin: unit.cancel_window_min });
  const [qr, setQr] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAsync();
  const link = `${location.origin}/b/${unit.slug}`;
  useEffect(() => { void QRCode.toDataURL(link, { margin: 2, width: 512, color: { dark: "#14110f", light: "#ffffff" } }).then(setQr); }, [link]);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-semibold">{unit.name}</h2>
      <div className="flex flex-wrap items-center gap-4">
        {qr && <img src={qr} alt={`QR Code da página de reservas de ${unit.name}`} className="size-40 rounded-lg bg-white p-1" />}
        <div className="space-y-2 text-sm"><p className="text-mute">Link fixo (nunca muda):</p><code className="block break-all">{link}</code>
          <div className="flex gap-2"><Button variant="ghost" onClick={() => navigator.clipboard?.writeText(link)}>Copiar link</Button>{qr && <a href={qr} download={`qrcode-${unit.slug}.png`}><Button variant="ghost">Baixar QR</Button></a>}</div></div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}{saved && <Notice kind="ok">Salvo.</Notice>}
      <Field label="Nome"><Input disabled={!editable} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Endereço"><Input disabled={!editable} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Telefone"><Input disabled={!editable} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Confirmação"><Select disabled={!editable} value={f.autoConfirm ? "auto" : "manual"} onChange={(e) => setF({ ...f, autoConfirm: e.target.value === "auto" })}><option value="auto">Automática</option><option value="manual">Eu confirmo cada pedido</option></Select></Field>
        <Field label="Intervalo da agenda"><Select disabled={!editable} value={f.slotStepMin} onChange={(e) => setF({ ...f, slotStepMin: Number(e.target.value) })}>{[10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}</Select></Field>
        <Field label="Antecedência mínima (min)"><Input type="number" min={0} disabled={!editable} value={f.minNoticeMin} onChange={(e) => setF({ ...f, minNoticeMin: Number(e.target.value) })} /></Field>
        <Field label="Cancelamento até (min antes)"><Input type="number" min={0} disabled={!editable} value={f.cancelWindowMin} onChange={(e) => setF({ ...f, cancelWindowMin: Number(e.target.value) })} /></Field>
        <Field label="Agenda aberta por (dias)"><Input type="number" min={1} max={365} disabled={!editable} value={f.maxDaysAhead} onChange={(e) => setF({ ...f, maxDaysAhead: Number(e.target.value) })} /></Field>
      </div>
      {editable && <Button disabled={busy} onClick={async () => { setSaved(false); const r = await run(() => api(orgPath(orgId, `/units/${unit.id}`), { method: "PATCH", auth: true, body: { name: f.name, address: f.address || null, phone: f.phone || null, autoConfirm: f.autoConfirm, minNoticeMin: f.minNoticeMin, maxDaysAhead: f.maxDaysAhead, slotStepMin: f.slotStepMin, cancelWindowMin: f.cancelWindowMin } })); if (r) { setSaved(true); await reloadUnits(); } }}>Salvar</Button>}
    </Card>
  );
}

interface Summary { byStatus: { status: string; count: number; total_cents: number }[]; byMethod: { method: string; count: number; amount_cents: number }[]; byProfessional: { name: string; completed: number; total_cents: number }[] }
const METHOD_PT: Record<string, string> = { cash: "Dinheiro", pix: "Pix", debit: "Débito", credit: "Crédito", other: "Outro" };

export function Reports() {
  const { orgId, can } = useAdmin();
  const [from, setFrom] = useState(addDaysStr(todayIn(), -29));
  const [to, setTo] = useState(todayIn());
  const [s, setS] = useState<Summary | null>(null);
  const { error, setError } = useAsync();
  useEffect(() => {
    if (!can("report.read")) return;
    setS(null);
    api<Summary>(orgPath(orgId, `/reports/summary?from=${encodeURIComponent(`${from}T03:00:00Z`)}&to=${encodeURIComponent(`${addDaysStr(to, 1)}T03:00:00Z`)}`), { auth: true }).then(setS).catch((e) => setError(errMsg(e)));
  }, [orgId, from, to, can, setError]);
  if (!can("report.read")) return <Notice>Seu papel não inclui relatórios.</Notice>;
  return (
    <div className="space-y-4">
      <div className="flex gap-2"><Input type="date" aria-label="De" value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" aria-label="Até" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      {error && <Notice kind="error">{error}</Notice>}
      {!s ? <Spinner /> : <>
        <Card><h2 className="mb-2 font-semibold">Recebido (registro manual)</h2>{s.byMethod.length === 0 ? <p className="text-sm text-mute">Nada no período.</p> : s.byMethod.map((m) => <div key={m.method} className="flex justify-between text-sm"><span>{METHOD_PT[m.method] ?? m.method} ({m.count})</span><b>{formatBRL(m.amount_cents)}</b></div>)}
          <div className="mt-2 flex justify-between border-t border-line pt-2 font-semibold"><span>Total</span><span>{formatBRL(s.byMethod.reduce((a, m) => a + m.amount_cents, 0))}</span></div></Card>
        <Card><h2 className="mb-2 font-semibold">Atendimentos</h2>{s.byStatus.map((x) => <div key={x.status} className="flex justify-between text-sm"><span>{x.status}</span><span>{x.count} · {formatBRL(x.total_cents)}</span></div>)}</Card>
        <Card><h2 className="mb-2 font-semibold">Por profissional (concluídos)</h2>{s.byProfessional.map((p) => <div key={p.name} className="flex justify-between text-sm"><span>{p.name}</span><span>{p.completed} · {formatBRL(p.total_cents)}</span></div>)}</Card>
      </>}
    </div>
  );
}
