import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Notice } from "../components/ui";
import { api, errMsg } from "../lib/api";
import { Shell } from "./PublicBooking";

export function Unsubscribe() {
  const [sp] = useSearchParams();
  const token = sp.get("t") ?? "";
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="Deixar de receber novidades">
      {done ? <Notice kind="ok">Pronto. Você não receberá mais e-mails de novidades desta barbearia. Lembretes de horários marcados continuam normalmente.</Notice> : (
        <>
          {!token && <Notice kind="error">Link inválido.</Notice>}
          {err && <Notice kind="error">{err}</Notice>}
          <p className="text-sm text-mute">Confirme para parar de receber e-mails de promoções e novidades desta barbearia.</p>
          <Button disabled={busy || !token} onClick={async () => { setBusy(true); try { await api("/public/unsubscribe", { method: "POST", body: { token } }); setDone(true); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>Confirmar descadastro</Button>
        </>
      )}
    </Shell>
  );
}
