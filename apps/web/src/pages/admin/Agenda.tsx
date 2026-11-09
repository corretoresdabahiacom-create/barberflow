import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBRL } from "@naregua/shared";
import { Badge, Button, Card, Field, Input, Notice, Select, Spinner, useAsync } from "../../components/ui";
import { api, errMsg, newIdemKey } from "../../lib/api";
import { addDaysStr, dayRangeUtc, fmtTime, todayIn } from "../../lib/dates";
import { orgPath, useAdmin } from "./ctx";

interface Appt { id: string; unit_id: string; professional_id: string; professional_name: string; customer_name: string; customer_phone: string | null; starts_at: string; ends_at: string; status: string; source: string; total_cents: number; duration_min: number }

export function Agenda() {
  const { orgId, units, can } = useAdmin();
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const unit = units.find((u) => u.id === unitId) ?? units[0];
  const tz = unit?.timezone ?? "America/Sao_Paulo";
  const [date, setDate] = useState(todayIn(tz));
  const [list, setList] = useState<Appt[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [payFor, setPayFor] = useState<Appt | null>(null);
  const { busy, error, run, setError } = useAsync();

  const load = useCallback(async () => {
    if (!unit) return;
    setList(null);
    const { from, to } = dayRangeUtc(date, tz);
    try {
      const r = await api<{ appointments: Appt[] }>(orgPath(orgId, `/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&unitId=${unit.id}`), { auth: true });
      setList(r.appointments);
    } catch (e) { setList([]); setError(errMsg(e)); }
  }, [orgId, unit, date, tz, setError]);
  useEffect(() => { void load(); }, [load]);

  const act = (id: string, action: string, body: unknown = {}) => run(async () => { await api(orgPath(orgId, `/appointments/${id}/${action}`), { method: "POST", body, auth: true }); await load(); });
  const day = useMemo(() => new Date(`${date}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" }), [date]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {units.length > 1 && <Select aria-label="Unidade" value={unit?.id} onChange={(e) => setUnitId(e.target.value)} className="max-w-48">{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}
        <Button variant="ghost" aria-label="Dia anterior" onClick={() => setDate(addDaysStr(date, -1))}>‹</Button>
        <Input type="date" aria-label="Data" value={date} onChange={(e) => setDate(e.target.value)} className="max-w-44" />
        <Button variant="ghost" aria-label="Próximo dia" onClick={() => setDate(addDaysStr(date, 1))}>›</Button>
        <Button variant="ghost" onClick={() => setDate(todayIn(tz))}>Hoje</Button>
        {can("agenda.write") && <Button className="ml-auto" onClick={() => setShowNew(true)}>Novo</Button>}
      </div>
      <h2 className="text-lg font-semibold capitalize">{day}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {list === null ? <Spinner /> : list.length === 0 ? <Notice>Nenhum agendamento neste dia.</Notice> : (
        <ul className="space-y-2">
          {list.map((a) => (
            <li key={a.id}><Card className="space-y-2">
              <div className="flex items-center justify-between gap-2"><span className="text-lg font-semibold">{fmtTime(a.starts_at, tz)}–{fmtTime(a.ends_at, tz)}</span><Badge status={a.status} /></div>
              <p className="text-sm">{a.customer_name}{a.customer_phone ? ` · ${a.customer_phone}` : ""}</p>
              <p className="text-xs text-mute">{a.professional_name} · {formatBRL(a.total_cents)} · {a.source === "public" ? "página pública" : a.source === "portal" ? "app" : "painel"}</p>
              <div className="flex flex-wrap gap-2">
                {a.status === "pending" && <Button disabled={busy} onClick={() => act(a.id, "confirm")}>Confirmar</Button>}
                {a.status === "confirmed" && <Button disabled={busy} onClick={() => act(a.id, "complete")}>Concluir</Button>}
                {a.status === "confirmed" && <Button variant="ghost" disabled={busy} onClick={() => act(a.id, "no-show")}>Faltou</Button>}
                {(a.status === "confirmed" || a.status === "completed") && can("payment.create") && <Button variant="ghost" onClick={() => setPayFor(a)}>Receber</Button>}
                {(a.status === "pending" || a.status === "confirmed") && <Button variant="danger" disabled={busy} onClick={() => confirm("Cancelar este agendamento?") && act(a.id, "cancel", {})}>Cancelar</Button>}
              </div>
            </Card></li>
          ))}
        </ul>
      )}
      {showNew && unit && <NewAppointment unitId={unit.id} tz={tz} date={date} onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); void load(); }} />}
      {payFor && <Pay appt={payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); void load(); }} />}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl border border-line bg-coal p-4">
        <div className="flex items-center justify-between"><h2 className="font-semibold">{title}</h2><button onClick={onClose} aria-label="Fechar" className="min-h-11 min-w-11 text-xl">×</button></div>
        {children}
      </div>
    </div>
  );
}

function Pay({ appt, onClose, onDone }: { appt: Appt; onClose: () => void; onDone: () => void }) {
  const { orgId } = useAdmin();
  const [key] = useState(newIdemKey); // chave estável por abertura: reenvio não duplica o recebimento
  const [method, setMethod] = useState("pix");
  const [paid, setPaid] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const { busy, error, run } = useAsync();
  useEffect(() => {
    api<{ payments: { amount_cents: number }[] }>(orgPath(orgId, `/appointments/${appt.id}/payments`), { auth: true }).then((r) => {
      const p = r.payments.reduce((a, x) => a + x.amount_cents, 0);
      setPaid(p);
      setAmount(((appt.total_cents - p) / 100).toFixed(2).replace(".", ","));
    }).catch(() => setPaid(0));
  }, [orgId, appt]);
  const cents = Math.round(parseFloat(amount.replace(",", ".")) * 100);
  return (
    <Modal title={`Receber — ${appt.customer_name}`} onClose={onClose}>
      {paid === null ? <Spinner /> : <>
        <p className="text-sm text-mute">Total {formatBRL(appt.total_cents)} · já recebido {formatBRL(paid)}</p>
        <Field label="Forma"><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="debit">Débito</option><option value="credit">Crédito</option><option value="other">Outro</option></Select></Field>
        <Field label="Valor (R$)" hint="Registro manual: não confirma o pagamento junto ao banco."><Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
        {error && <Notice kind="error">{error}</Notice>}
        <Button className="w-full" disabled={busy || !(cents > 0)} onClick={async () => { const r = await run(() => api(orgPath(orgId, `/appointments/${appt.id}/payments`), { method: "POST", auth: true, body: { method, amountCents: cents }, headers: { "Idempotency-Key": key } })); if (r) onDone(); }}>Registrar recebimento</Button>
      </>}
    </Modal>
  );
}

interface Pro { id: string; name: string; status: string; unitIds: string[] }
interface Svc { id: string; name: string; price_cents: number; duration_min: number; status: string }

function NewAppointment({ unitId, tz, date, onClose, onDone }: { unitId: string; tz: string; date: string; onClose: () => void; onDone: () => void }) {
  const { orgId, units } = useAdmin();
  const slug = units.find((u) => u.id === unitId)?.slug ?? "";
  const [pros, setPros] = useState<Pro[]>([]);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [proId, setProId] = useState("");
  const [svcId, setSvcId] = useState("");
  const [d, setD] = useState(date);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const { busy, error, run, setError } = useAsync();

  useEffect(() => {
    void Promise.all([
      api<{ professionals: Pro[] }>(orgPath(orgId, "/professionals"), { auth: true }),
      api<{ services: Svc[] }>(orgPath(orgId, "/services"), { auth: true }),
    ]).then(([p, s]) => { setPros(p.professionals.filter((x) => x.status === "active" && x.unitIds.includes(unitId))); setSvcs(s.services.filter((x) => x.status === "active")); }).catch((e) => setError(errMsg(e)));
  }, [orgId, unitId, setError]);

  useEffect(() => {
    setSlot(""); setSlots(null);
    if (!proId || !svcId) return;
    api<{ slots: string[] }>(`/public/units/${slug}/availability?professionalId=${proId}&serviceIds=${svcId}&date=${d}`).then((r) => setSlots(r.slots)).catch(() => setSlots([]));
  }, [proId, svcId, d, slug]);

  return (
    <Modal title="Novo agendamento" onClose={onClose}>
      <Field label="Profissional"><Select value={proId} onChange={(e) => setProId(e.target.value)}><option value="">Escolha…</option>{pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
      <Field label="Serviço"><Select value={svcId} onChange={(e) => setSvcId(e.target.value)}><option value="">Escolha…</option>{svcs.map((s) => <option key={s.id} value={s.id}>{s.name} — {formatBRL(s.price_cents)}</option>)}</Select></Field>
      <Field label="Dia"><Input type="date" value={d} onChange={(e) => setD(e.target.value)} /></Field>
      {proId && svcId && (slots === null ? <Spinner /> : slots.length === 0 ? <Notice>Sem horários livres neste dia.</Notice> : (
        <div className="grid grid-cols-4 gap-2">{slots.map((s) => <button key={s} onClick={() => setSlot(s)} className={`min-h-11 rounded-lg border text-sm ${slot === s ? "border-amber bg-amber font-semibold text-ink" : "border-line bg-panel"}`}>{fmtTime(s, tz)}</button>)}</div>
      ))}
      <Field label="Cliente"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Telefone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
      {error && <Notice kind="error">{error}</Notice>}
      <Button className="w-full" disabled={busy || !slot || name.trim().length < 2 || phone.replace(/\D/g, "").length < 10}
        onClick={async () => { const r = await run(() => api(orgPath(orgId, "/appointments"), { method: "POST", auth: true, body: { unitId, professionalId: proId, serviceIds: [svcId], startsAt: slot, customer: { name, phone } } })); if (r) onDone(); }}>Agendar</Button>
    </Modal>
  );
}
