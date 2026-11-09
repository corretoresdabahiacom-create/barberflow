import { useCallback, useEffect, useState } from "react";
import { WEEKDAYS_PT, formatBRL, hhmmToMinutes, minutesToHHMM } from "@naregua/shared";
import { Badge, Button, Card, Field, Input, Notice, Select, Spinner, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { orgPath, useAdmin } from "./ctx";

interface Svc { id: string; name: string; description: string | null; price_cents: number; duration_min: number; status: string }
interface Pro { id: string; name: string; bio: string | null; status: string; unitIds: string[] }
interface Day { weekday: number; startMin: number; endMin: number }

export function Services() {
  const { orgId, can } = useAdmin();
  const [list, setList] = useState<Svc[] | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [dur, setDur] = useState("30");
  const { busy, error, run, setError } = useAsync();
  const load = useCallback(() => api<{ services: Svc[] }>(orgPath(orgId, "/services"), { auth: true }).then((r) => setList(r.services)).catch((e) => setError(errMsg(e))), [orgId, setError]);
  useEffect(() => { void load(); }, [load]);
  const cents = Math.round(parseFloat(price.replace(",", ".")) * 100);
  const write = can("org.manage"); // serviços/preços são da organização (só dono)
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      {write && (
        <Card className="space-y-2"><h2 className="font-semibold">Novo serviço</h2>
          <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Corte masculino" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Preço (R$)"><Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></Field>
            <Field label="Duração"><Select value={dur} onChange={(e) => setDur(e.target.value)}>{[15, 20, 30, 40, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}</Select></Field>
          </div>
          <Button disabled={busy || name.trim().length < 2 || !(cents >= 0)} onClick={async () => { const r = await run(() => api(orgPath(orgId, "/services"), { method: "POST", auth: true, body: { name: name.trim(), priceCents: cents, durationMin: Number(dur) } })); if (r) { setName(""); setPrice(""); void load(); } }}>Adicionar</Button>
        </Card>
      )}
      {list === null ? <Spinner /> : list.map((s) => (
        <Card key={s.id} className="flex items-center justify-between gap-2">
          <div><div className="font-medium">{s.name}</div><div className="text-sm text-mute">{formatBRL(s.price_cents)} · {s.duration_min} min</div></div>
          <div className="flex items-center gap-2">{s.status === "inactive" && <Badge status="cancelled" />}
            {write && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await api(orgPath(orgId, `/services/${s.id}`), { method: "PATCH", auth: true, body: { status: s.status === "active" ? "inactive" : "active" } }); await load(); })}>{s.status === "active" ? "Desativar" : "Ativar"}</Button>}</div>
        </Card>
      ))}
    </div>
  );
}

export function Professionals() {
  const { orgId, units, can } = useAdmin();
  const [list, setList] = useState<Pro[] | null>(null);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, run, setError } = useAsync();
  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api<{ professionals: Pro[] }>(orgPath(orgId, "/professionals"), { auth: true }), api<{ services: Svc[] }>(orgPath(orgId, "/services"), { auth: true })]);
      setList(p.professionals); setSvcs(s.services.filter((x) => x.status === "active"));
    } catch (e) { setError(errMsg(e)); }
  }, [orgId, setError]);
  useEffect(() => { void load(); }, [load]);
  const write = can("catalog.write");
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      {write && (
        <Card className="space-y-2"><h2 className="font-semibold">Novo profissional</h2>
          <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Button disabled={busy || name.trim().length < 2 || !units[0]} onClick={async () => { const r = await run(() => api(orgPath(orgId, "/professionals"), { method: "POST", auth: true, body: { name: name.trim(), unitIds: [units[0]!.id] } })); if (r) { setName(""); void load(); } }}>Adicionar na unidade “{units[0]?.name}”</Button>
        </Card>
      )}
      {list === null ? <Spinner /> : list.map((p) => (
        <Card key={p.id} className="space-y-2">
          <div className="flex items-center justify-between"><span className="font-medium">{p.name}</span><Button variant="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Fechar" : "Serviços e horários"}</Button></div>
          {open === p.id && <ProEditor pro={p} svcs={svcs} write={write} />}
        </Card>
      ))}
    </div>
  );
}

function ProEditor({ pro, svcs, write }: { pro: Pro; svcs: Svc[]; write: boolean }) {
  const { orgId, units } = useAdmin();
  const unitId = pro.unitIds[0] ?? units[0]?.id ?? "";
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [days, setDays] = useState<Day[]>([]);
  const [ready, setReady] = useState(false);
  const { busy, error, run } = useAsync();
  const [ok, setOk] = useState("");
  useEffect(() => {
    void Promise.all([
      api<{ services: { service_id: string }[] }>(orgPath(orgId, `/professionals/${pro.id}/services`), { auth: true }),
      api<{ schedules: { unit_id: string; weekday: number; start_min: number; end_min: number }[] }>(orgPath(orgId, `/professionals/${pro.id}/schedules`), { auth: true }),
    ]).then(([s, sc]) => {
      setSel(new Set(s.services.map((x) => x.service_id)));
      setDays(sc.schedules.filter((x) => x.unit_id === unitId).map((x) => ({ weekday: x.weekday, startMin: x.start_min, endMin: x.end_min })));
      setReady(true);
    });
  }, [orgId, pro.id, unitId]);
  if (!ready) return <Spinner />;
  const setDay = (wd: number, on: boolean) => setDays(on ? [...days, { weekday: wd, startMin: 540, endMin: 1080 }] : days.filter((d) => d.weekday !== wd));
  return (
    <div className="space-y-3">
      {error && <Notice kind="error">{error}</Notice>}{ok && <Notice kind="ok">{ok}</Notice>}
      <div><h3 className="mb-1 text-sm font-semibold">Serviços que faz</h3>
        {svcs.length === 0 && <p className="text-sm text-mute">Cadastre serviços primeiro.</p>}
        {svcs.map((s) => <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-amber" disabled={!write} checked={sel.has(s.id)} onChange={() => { const n = new Set(sel); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setSel(n); }} />{s.name}</label>)}
        {write && <Button variant="ghost" disabled={busy} onClick={async () => { const r = await run(() => api(orgPath(orgId, `/professionals/${pro.id}/services`), { method: "PUT", auth: true, body: { services: [...sel].map((serviceId) => ({ serviceId })) } })); if (r !== undefined) setOk("Serviços salvos."); }}>Salvar serviços</Button>}
      </div>
      <div><h3 className="mb-1 text-sm font-semibold">Horário de trabalho</h3>
        {WEEKDAYS_PT.map((label, wd) => {
          const d = days.find((x) => x.weekday === wd);
          return (
            <div key={wd} className="flex min-h-11 items-center gap-2 text-sm">
              <label className="flex w-28 items-center gap-2"><input type="checkbox" className="size-5 accent-amber" disabled={!write} checked={!!d} onChange={(e) => setDay(wd, e.target.checked)} />{label}</label>
              {d && <>
                <Input type="time" step={300} aria-label={`${label} início`} disabled={!write} value={minutesToHHMM(d.startMin)} onChange={(e) => setDays(days.map((x) => x === d ? { ...x, startMin: hhmmToMinutes(e.target.value) ?? x.startMin } : x))} className="max-w-28" />
                <span>às</span>
                <Input type="time" step={300} aria-label={`${label} fim`} disabled={!write} value={minutesToHHMM(d.endMin)} onChange={(e) => setDays(days.map((x) => x === d ? { ...x, endMin: hhmmToMinutes(e.target.value) ?? x.endMin } : x))} className="max-w-28" />
              </>}
            </div>
          );
        })}
        {write && <Button variant="ghost" disabled={busy} onClick={async () => { const r = await run(() => api(orgPath(orgId, `/professionals/${pro.id}/schedules`), { method: "PUT", auth: true, body: { unitId, days } })); if (r !== undefined) setOk("Horários salvos."); }}>Salvar horários</Button>}
      </div>
    </div>
  );
}
