import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState } from "../lib/push";
import { errMsg } from "../lib/api";
import { Button, Notice } from "./ui";

export function PushToggle() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof pushState>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setSt).catch(() => setSt("unsupported")); }, []);
  if (!st || st === "server_off") return null;
  if (st === "unsupported") return <p className="text-xs text-mute">Este navegador não suporta notificações push (no iPhone, instale o app na tela de início).</p>;
  if (st === "denied") return <p className="text-xs text-mute">As notificações estão bloqueadas neste aparelho. Libere nas configurações do navegador.</p>;
  return (
    <div className="space-y-2">
      {err && <Notice kind="error">{err}</Notice>}
      <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { if (st === "on") await disablePush(); else await enablePush(); setSt(await pushState()); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>
        {st === "on" ? "Desativar notificações neste aparelho" : "Ativar notificações neste aparelho"}
      </Button>
    </div>
  );
}
