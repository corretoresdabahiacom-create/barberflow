import { useCallback, useEffect, useState } from "react";
import { Button, Card, Notice, Spinner } from "../../components/ui";
import { ChatBox } from "../../components/ChatBox";
import { api, errMsg } from "../../lib/api";
import { fmtDateTime } from "../../lib/dates";
import { orgPath, useAdmin } from "./ctx";

interface Th { id: string; unit_name: string; status: string; staff_unread: number; last_message_at: string; customer_name: string; last_body: string | null }

export function Chat() {
  const { orgId, can } = useAdmin();
  const [list, setList] = useState<Th[] | null>(null);
  const [sel, setSel] = useState<Th | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadList = useCallback(() => api<{ threads: Th[] }>(orgPath(orgId, "/chat/threads"), { auth: true }).then((r) => setList(r.threads)).catch((e) => setErr(errMsg(e))), [orgId]);
  useEffect(() => { void loadList(); const t = setInterval(() => { if (document.visibilityState === "visible") void loadList(); }, 30000); return () => clearInterval(t); }, [loadList]);
  const load = useCallback(() => api<{ status: string; messages: any[] }>(orgPath(orgId, `/chat/threads/${sel!.id}/messages`), { auth: true }), [orgId, sel]);
  const send = useCallback(async (body: string) => { await api(orgPath(orgId, `/chat/threads/${sel!.id}/messages`), { method: "POST", auth: true, body: { body } }); }, [orgId, sel]);
  if (!can("chat.read")) return <Notice>Seu papel não inclui o chat.</Notice>;
  return (
    <div className="space-y-3">
      {err && <Notice kind="error">{err}</Notice>}
      {sel ? (
        <Card className="space-y-2">
          <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{sel.customer_name}</h2>
            <div className="flex gap-2">
              {can("chat.write") && <Button variant="ghost" onClick={async () => { const next = sel.status === "open" ? "blocked" : "open"; await api(orgPath(orgId, `/chat/threads/${sel.id}`), { method: "PATCH", auth: true, body: { status: next } }); setSel({ ...sel, status: next }); await loadList(); }}>{sel.status === "open" ? "Encerrar conversa" : "Reabrir"}</Button>}
              <Button variant="ghost" onClick={() => { setSel(null); void loadList(); }}>Voltar</Button></div></div>
          <ChatBox key={`${sel.id}${sel.status}`} mine="staff" load={load} send={send} />
        </Card>
      ) : list === null ? <Spinner /> : list.length === 0 ? <Notice>Nenhuma conversa ainda. Clientes que já agendaram podem escrever pelo portal.</Notice> : list.map((t) => (
        <button key={t.id} className="block w-full text-left" onClick={() => setSel(t)}>
          <Card className="space-y-0.5"><div className="flex justify-between"><span className="font-medium">{t.customer_name}</span>{t.staff_unread > 0 && <span className="rounded-full bg-amber px-2 text-xs font-semibold text-ink">{t.staff_unread}</span>}</div>
            <p className="truncate text-sm text-mute">{t.last_body}</p><p className="text-xs text-mute">{t.unit_name} · {fmtDateTime(t.last_message_at)}{t.status === "blocked" ? " · encerrada" : ""}</p></Card>
        </button>
      ))}
    </div>
  );
}
