import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "../lib/api";
import { fmtDateTime } from "../lib/dates";
import { Button, Input, Notice, Spinner } from "./ui";

export interface ChatMsg { id: string; sender_kind: "customer" | "staff"; body: string; created_at: string }

/** Conversa por polling (15 s, só com a aba visível). `mine` = lado de quem está usando a tela. */
export function ChatBox({ mine, load, send }: { mine: "customer" | "staff"; load: () => Promise<{ status: string; messages: ChatMsg[] }>; send: (body: string) => Promise<void> }) {
  const [data, setData] = useState<{ status: string; messages: ChatMsg[] } | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const refresh = useCallback(() => load().then(setData).catch((e) => setErr(errMsg(e))), [load]);
  useEffect(() => {
    setData(null); void refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [data?.messages.length]);
  const blocked = data?.status === "blocked";
  return (
    <div className="space-y-2">
      {err && <Notice kind="error">{err}</Notice>}
      <div className="max-h-96 min-h-40 space-y-2 overflow-y-auto rounded-xl border border-line p-2" aria-live="polite">
        {!data ? <Spinner /> : data.messages.length === 0 ? <p className="p-2 text-sm text-mute">Nenhuma mensagem ainda.</p> : data.messages.map((m) => (
          <div key={m.id} className={`flex ${m.sender_kind === mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.sender_kind === mine ? "bg-amber text-ink" : "bg-panel"}`}>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className="mt-1 text-[10px] opacity-70">{fmtDateTime(m.created_at)}</p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {blocked ? <Notice>Esta conversa foi encerrada.</Notice> : (
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); const b = text.trim(); if (!b) return; setBusy(true); setErr(null); try { await send(b); setText(""); await refresh(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); } }}>
          <Input aria-label="Mensagem" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva uma mensagem" />
          <Button disabled={busy || !text.trim()}>Enviar</Button>
        </form>
      )}
      <p className="text-xs text-mute">Não envie senhas nem dados de cartão. Não é um canal de emergência.</p>
    </div>
  );
}
