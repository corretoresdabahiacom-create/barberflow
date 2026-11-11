import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Badge, Button, Card, Notice, Spinner, useAsync } from "../components/ui";
import { api, errMsg } from "../lib/api";
import { fmtDateTime } from "../lib/dates";
import { useAuth } from "../lib/auth";
import { Shell } from "./PublicBooking";
import { ChatBox } from "../components/ChatBox";
import { PushToggle } from "../components/PushToggle";
import { formatBRL } from "@naregua/shared";

interface Appt { id: string; starts_at: string; status: string; total_cents: number; organization_name: string; unit_name: string; unit_slug: string; professional_name: string; services: string | null }

export function CustomerPortal() {
  const auth = useAuth();
  const [list, setList] = useState<Appt[] | null>(null);
  const { busy, error, run, setError } = useAsync();
  const load = useCallback(() => api<{ appointments: Appt[] }>("/me/appointments", { auth: true }).then((r) => setList(r.appointments)).catch((e) => setError(errMsg(e))), [setError]);
  useEffect(() => { if (auth.user) void load(); }, [auth.user, load]);

  if (!auth.ready) return <Shell><Spinner /></Shell>;
  if (!auth.user) return <Navigate to="/entrar?next=/c" replace />;
  const upcoming = (list ?? []).filter((a) => ["pending", "confirmed"].includes(a.status) && a.starts_at > new Date().toISOString());
  const past = (list ?? []).filter((a) => !upcoming.includes(a));

  return (
    <Shell title="Meus agendamentos" subtitle={auth.user.email ?? undefined}>
      {!auth.me?.user.emailVerified && <Notice kind="warn">Confirme seu e-mail (enviamos um link) para ver seus agendamentos e agendar pelo app. <button className="underline" onClick={() => auth.resendVerification()}>Reenviar</button> · <button className="underline" onClick={() => auth.reloadUser()}>Já confirmei</button></Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {list === null ? <Spinner /> : list.length === 0 ? <Notice>Nenhum agendamento vinculado à sua conta ainda.</Notice> : (
        <>
          <Section title="Próximos" items={upcoming} busy={busy} onCancel={(id) => confirm("Cancelar este agendamento?") && run(async () => { await api(`/me/appointments/${id}/cancel`, { method: "POST", body: {}, auth: true }); await load(); })} />
          <Section title="Histórico" items={past} busy={busy} />
        </>
      )}
      {auth.me?.user.emailVerified && <Chats />}
      <PushToggle />
      <div className="flex gap-3 text-sm">
        {auth.me && auth.me.memberships.length > 0 && <Link to="/app" className="text-amber underline">Painel da barbearia</Link>}
        <button className="text-mute underline" onClick={() => auth.signOut()}>Sair</button>
      </div>
    </Shell>
  );
}

function Section({ title, items, busy, onCancel }: { title: string; items: Appt[]; busy: boolean; onCancel?: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2"><h2 className="font-semibold">{title}</h2>
      {items.map((a) => (
        <Card key={a.id} className="space-y-1">
          <div className="flex items-center justify-between"><span className="font-medium">{fmtDateTime(a.starts_at)}</span><Badge status={a.status} /></div>
          <p className="text-sm text-mute">{a.organization_name} · {a.unit_name} · {a.professional_name}</p>
          <p className="text-sm">{a.services} — {formatBRL(a.total_cents)}</p>
          <div className="flex gap-2">
            <Link to={`/b/${a.unit_slug}`}><Button variant="ghost">Agendar de novo</Button></Link>
            {onCancel && <Button variant="danger" disabled={busy} onClick={() => onCancel(a.id)}>Cancelar</Button>}
          </div>
        </Card>
      ))}
    </section>
  );
}

interface ChatItem { unit_slug: string; unit_name: string; organization_name: string; unread: number }

function Chats() {
  const [chats, setChats] = useState<ChatItem[] | null>(null);
  const [open, setOpen] = useState<ChatItem | null>(null);
  useEffect(() => { api<{ chats: ChatItem[] }>("/me/chat", { auth: true }).then((r) => setChats(r.chats)).catch(() => setChats([])); }, [open]);
  const load = useCallback(() => api<{ status: string; messages: any[] }>(`/me/chat/${open!.unit_slug}/messages`, { auth: true }), [open]);
  const send = useCallback(async (body: string) => { await api(`/me/chat/${open!.unit_slug}/messages`, { method: "POST", auth: true, body: { body } }); }, [open]);
  if (!chats || chats.length === 0) return null;
  return (
    <section className="space-y-2"><h2 className="font-semibold">Conversar com a barbearia</h2>
      {open ? (
        <Card className="space-y-2"><div className="flex items-center justify-between"><span className="font-medium">{open.organization_name} · {open.unit_name}</span><Button variant="ghost" onClick={() => setOpen(null)}>Voltar</Button></div><ChatBox mine="customer" load={load} send={send} /></Card>
      ) : chats.map((c) => (
        <button key={c.unit_slug} className="block w-full text-left" onClick={() => setOpen(c)}><Card className="flex items-center justify-between"><span>{c.organization_name} · {c.unit_name}</span>{c.unread > 0 && <span className="rounded-full bg-amber px-2 text-xs font-semibold text-ink">{c.unread}</span>}</Card></button>
      ))}
    </section>
  );
}
