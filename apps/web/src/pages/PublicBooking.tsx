import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatBRL } from "@naregua/shared";
import { Turnstile } from "../components/Turnstile";
import { Badge, Button, Card, Field, Input, Logo, Notice, Spinner, useAsync } from "../components/ui";
import { api, errMsg } from "../lib/api";
import { addDaysStr, fmtDateTime, fmtTime, todayIn } from "../lib/dates";
import { useAuth } from "../lib/auth";

interface Service { id: string; name: string; description: string | null; priceCents: number; durationMin: number }
interface Pro { id: string; name: string; bio: string | null; services: Service[] }
interface UnitPage {
  unit: { slug: string; name: string; organizationName: string; address: string | null; phone: string | null; timezone: string; cancelWindowMin: number; maxDaysAhead: number };
  professionals: Pro[];
  turnstileSiteKey: string | null;
}

export function PublicBooking() {
  const { slug = "" } = useParams();
  const auth = useAuth();
  const [page, setPage] = useState<UnitPage | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [proId, setProId] = useState<string>("");
  const [svcIds, setSvcIds] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [mkt, setMkt] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; startsAt: string; status: string; cancelToken: string } | null>(null);
  const { busy, error, setError, run } = useAsync();
  const auto = useRef(0); // avanço automático para o próximo dia com horário (até 14 dias), enquanto o cliente não escolher a data
  const onToken = useCallback((t: string | null) => setToken(t), []);

  useEffect(() => {
    api<UnitPage>(`/public/units/${slug}`).then((p) => { setPage(p); setDate(todayIn(p.unit.timezone)); }).catch((e) => setLoadErr(errMsg(e)));
  }, [slug]);

  const pro = page?.professionals.find((p) => p.id === proId);
  const pickService = (ids: string[]) => { auto.current = 1; setSvcIds(ids); };
  const chosen = useMemo(() => pro?.services.filter((s) => svcIds.includes(s.id)) ?? [], [pro, svcIds]);
  const total = chosen.reduce((a, s) => a + s.priceCents, 0);
  const minutes = chosen.reduce((a, s) => a + s.durationMin, 0);

  useEffect(() => {
    setSlot("");
    if (!page || !proId || svcIds.length === 0 || !date) { setSlots(null); return; }
    setSlots(null);
    api<{ slots: string[] }>(`/public/units/${slug}/availability?professionalId=${proId}&serviceIds=${svcIds.join(",")}&date=${date}`)
      .then((r) => {
        if (r.slots.length === 0 && auto.current > 0 && auto.current <= 14) { auto.current += 1; setDate(addDaysStr(date, 1)); return; }
        auto.current = 0;
        setSlots(r.slots);
      }).catch((e) => { setSlots([]); setError(errMsg(e)); });
  }, [page, proId, svcIds, date, slug, setError]);

  if (loadErr) return <Shell><Notice kind="error">{loadErr === "Recurso não encontrado" ? "Barbearia não encontrada. Confira o link ou o QR Code." : loadErr}</Notice></Shell>;
  if (!page) return <Shell><Spinner /></Shell>;
  const tz = page.unit.timezone;

  if (done) {
    const link = `${location.origin}/agendamento/${done.id}#${done.cancelToken}`;
    return (
      <Shell title={page.unit.name}>
        <Card className="space-y-3">
          <Notice kind="ok">{done.status === "pending" ? "Pedido enviado! A barbearia vai confirmar." : "Agendamento confirmado!"}</Notice>
          <p className="text-lg font-semibold">{fmtDateTime(done.startsAt, tz)}</p>
          <p className="text-sm text-mute">{page.unit.address}</p>
          <p className="text-sm">Guarde este link para ver ou cancelar seu horário (até {Math.round(page.unit.cancelWindowMin / 60)}h antes):</p>
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-xl border border-line bg-coal p-2 text-xs" />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(link)}>Copiar link</Button>
            <Link to={`/agendamento/${done.id}#${done.cancelToken}`}><Button>Ver agendamento</Button></Link>
          </div>
          <p className="text-xs text-mute">Quer acompanhar tudo no app? <Link className="text-amber underline" to="/entrar">Crie sua conta</Link> com o mesmo e-mail.</p>
        </Card>
      </Shell>
    );
  }

  const siteKey = page.turnstileSiteKey;
  const canSubmit = !!slot && name.trim().length >= 2 && phone.replace(/\D/g, "").length >= 10 && !!token;

  async function submit() {
    const r = await run(() => api<{ appointment: { id: string; startsAt: string; status: string }; cancelToken: string }>(`/public/units/${slug}/appointments`, {
      method: "POST",
      body: { turnstileToken: token, customer: { name, phone, email: email || undefined }, professionalId: proId, serviceIds: svcIds, startsAt: slot, marketingConsent: mkt || undefined },
    }));
    if (r) setDone({ ...r.appointment, cancelToken: r.cancelToken });
  }

  return (
    <Shell title={page.unit.name} subtitle={[page.unit.address, page.unit.phone].filter(Boolean).join(" · ")}>
      {page.professionals.length === 0 && <Notice kind="warn">Esta barbearia ainda não publicou horários.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <section aria-labelledby="s1" className="space-y-2">
        <h2 id="s1" className="font-semibold">1. Profissional</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {page.professionals.map((p) => (
            <button key={p.id} onClick={() => { setProId(p.id); setSvcIds([]); }} aria-pressed={proId === p.id}
              className={`min-h-11 rounded-xl border p-3 text-left ${proId === p.id ? "border-amber bg-amber/10" : "border-line bg-panel"}`}>
              <div className="font-medium">{p.name}</div>
              {p.bio && <div className="text-xs text-mute">{p.bio}</div>}
            </button>
          ))}
        </div>
      </section>

      {pro && (
        <section aria-labelledby="s2" className="space-y-2">
          <h2 id="s2" className="font-semibold">2. Serviços</h2>
          {pro.services.map((s) => {
            const on = svcIds.includes(s.id);
            return (
              <label key={s.id} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border p-3 ${on ? "border-amber bg-amber/10" : "border-line bg-panel"}`}>
                <input type="checkbox" checked={on} onChange={() => pickService(on ? svcIds.filter((x) => x !== s.id) : svcIds.length < 5 ? [...svcIds, s.id] : svcIds)} className="size-5 accent-amber" />
                <span className="flex-1"><span className="block font-medium">{s.name}</span><span className="text-xs text-mute">{s.durationMin} min</span></span>
                <span className="font-semibold">{formatBRL(s.priceCents)}</span>
              </label>
            );
          })}
          {chosen.length > 0 && <p className="text-sm text-mute">Total: <b className="text-cream">{formatBRL(total)}</b> · {minutes} min</p>}
        </section>
      )}

      {chosen.length > 0 && (
        <section aria-labelledby="s3" className="space-y-2">
          <h2 id="s3" className="font-semibold">3. Dia e horário</h2>
          <Input type="date" aria-label="Data" value={date} min={todayIn(tz)} max={addDaysStr(todayIn(tz), page.unit.maxDaysAhead)} onChange={(e) => { auto.current = 0; setDate(e.target.value); }} />
          {slots === null ? <Spinner /> : slots.length === 0 ? <Notice>Sem horários neste dia. Tente outra data.</Notice> : (
            <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Horários">
              {slots.map((s) => (
                <button key={s} role="radio" aria-checked={slot === s} onClick={() => setSlot(s)}
                  className={`min-h-11 rounded-lg border text-sm ${slot === s ? "border-amber bg-amber text-ink font-semibold" : "border-line bg-panel"}`}>{fmtTime(s, tz)}</button>
              ))}
            </div>
          )}
        </section>
      )}

      {slot && (
        <section aria-labelledby="s4" className="space-y-3">
          <h2 id="s4" className="font-semibold">4. Seus dados</h2>
          <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          <Field label="WhatsApp / telefone" hint="Com DDD. Usado só para este agendamento."><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" /></Field>
          <Field label="E-mail (opcional)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          <label className="flex items-start gap-2 text-sm text-mute">
            <input type="checkbox" checked={mkt} onChange={(e) => setMkt(e.target.checked)} className="mt-1 size-5 accent-amber" />
            <span>Aceito receber novidades e promoções desta barbearia (opcional; você pode revogar quando quiser).</span>
          </label>
          {siteKey ? <Turnstile siteKey={siteKey} onToken={onToken} /> : <Notice kind="warn">Agendamento online temporariamente indisponível (verificação anti-robô não configurada). Ligue para a barbearia.</Notice>}
          <p className="text-xs text-mute">Ao agendar você concorda com os <Link to="/termos" className="underline">Termos</Link> e a <Link to="/privacidade" className="underline">Política de Privacidade</Link>.</p>
          <Button onClick={submit} disabled={!canSubmit || busy} className="w-full">{busy ? "Agendando…" : `Confirmar ${fmtTime(slot, tz)}`}</Button>
        </section>
      )}

      <p className="pt-4 text-center text-sm text-mute">
        {auth.me ? <Link to="/c" className="underline">Meus agendamentos</Link> : <>Já é cliente? <Link to="/entrar" className="text-amber underline">Entrar</Link></>}
      </p>
    </Shell>
  );
}

export function Shell({ children, title, subtitle }: { children: React.ReactNode; title?: string; subtitle?: string }) {
  return (
    <main className="mx-auto max-w-xl space-y-5 px-4 pb-16 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className="space-y-1">
        <Link to="/"><Logo /></Link>
        {title && <h1 className="text-2xl font-bold">{title}</h1>}
        {subtitle && <p className="text-sm text-mute">{subtitle}</p>}
      </header>
      {children}
    </main>
  );
}

export function ManageAppointment() {
  const id = location.pathname.split("/").pop() ?? "";
  const token = location.hash.slice(1);
  const [data, setData] = useState<{ appointment: { startsAt: string; status: string; totalCents: number }; unit: { name: string; slug: string; cancel_window_min: number }; items: { name: string; price_cents: number }[] } | null>(null);
  const { busy, error, run, setError } = useAsync();
  const load = useCallback(() => api(`/public/appointments/${id}/view`, { method: "POST", body: { token } }).then(setData).catch((e) => setError(errMsg(e))), [id, token, setError]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return <Shell>{error ? <Notice kind="error">{error === "Recurso não encontrado" ? "Link inválido ou expirado." : error}</Notice> : <Spinner />}</Shell>;
  return (
    <Shell title={data.unit.name}>
      <Card className="space-y-2">
        <div className="flex items-center justify-between"><span className="text-lg font-semibold">{fmtDateTime(data.appointment.startsAt)}</span><Badge status={data.appointment.status} /></div>
        <ul className="text-sm text-mute">{data.items.map((i, k) => <li key={k}>{i.name} — {formatBRL(i.price_cents)}</li>)}</ul>
        <p className="font-semibold">Total {formatBRL(data.appointment.totalCents)}</p>
        {error && <Notice kind="error">{error}</Notice>}
        {(data.appointment.status === "pending" || data.appointment.status === "confirmed") && (
          <Button variant="danger" disabled={busy} onClick={() => confirm("Cancelar este agendamento?") && run(async () => { await api(`/public/appointments/${id}/cancel`, { method: "POST", body: { token } }); await load(); })}>Cancelar agendamento</Button>
        )}
        <Link to={`/b/${data.unit.slug}`} className="block text-sm text-amber underline">Novo agendamento</Link>
      </Card>
    </Shell>
  );
}
