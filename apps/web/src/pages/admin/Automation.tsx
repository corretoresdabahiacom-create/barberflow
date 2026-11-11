import { useEffect, useState } from "react";
import { Button, Card, Field, Input, Notice, Spinner, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { fmtDateTime } from "../../lib/dates";
import { orgPath, useAdmin } from "./ctx";

interface Outbox { id: string; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null }

export function Automation() {
  const { orgId, can } = useAdmin();
  const [pts, setPts] = useState("0");
  const [rem, setRem] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [box, setBox] = useState<Outbox[]>([]);
  const { busy, error, setError, run } = useAsync();
  useEffect(() => {
    if (!can("org.manage")) return;
    Promise.all([api<{ loyaltyPointsPerReal: number; remindersEnabled: boolean }>(orgPath(orgId, "/automation"), { auth: true }), api<{ outbox: Outbox[] }>(orgPath(orgId, "/outbox"), { auth: true })])
      .then(([a, o]) => { setPts(String(a.loyaltyPointsPerReal)); setRem(a.remindersEnabled); setBox(o.outbox); setLoaded(true); })
      .catch((e) => setError(errMsg(e)));
  }, [orgId, can, setError]);
  if (!can("org.manage")) return <Notice>Somente o proprietário altera estas configurações.</Notice>;
  if (!loaded && !error) return <Spinner />;
  const n = Number(pts);
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}{saved && <Notice kind="ok">Salvo.</Notice>}
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Fidelidade</h2>
        <Field label="Pontos por R$ 1,00 de atendimento concluído" hint="0 desliga a fidelidade. Os pontos entram quando o atendimento é marcado como concluído."><Input inputMode="numeric" value={pts} onChange={(e) => setPts(e.target.value)} /></Field>
      </Card>
      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Lembretes por e-mail</h2>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5" checked={rem} onChange={(e) => setRem(e.target.checked)} /> Enviar lembrete ao cliente cerca de 24 h antes (só para quem informou e-mail)</label>
        <Notice kind="warn">Só funciona depois que o provedor de e-mail for configurado no servidor (EMAIL_API_KEY e EMAIL_FROM). Sem isso, nada é enviado.</Notice>
        <Button disabled={busy || !Number.isInteger(n) || n < 0 || n > 100} onClick={async () => { setSaved(false); if (await run(() => api(orgPath(orgId, "/automation"), { method: "PUT", auth: true, body: { loyaltyPointsPerReal: n, remindersEnabled: rem } }))) setSaved(true); }}>Salvar</Button>
      </Card>
      {box.length > 0 && <Card className="space-y-1"><h2 className="text-lg font-semibold">Últimos e-mails</h2>
        <ul className="divide-y divide-line text-sm">{box.slice(0, 15).map((m) => <li key={m.id} className="flex justify-between gap-2 py-1.5"><span>{fmtDateTime(m.created_at)}</span><span>{m.status}{m.attempts > 1 ? ` (${m.attempts} tentativas)` : ""}{m.last_error ? ` · ${m.last_error}` : ""}</span></li>)}</ul></Card>}
    </div>
  );
}
