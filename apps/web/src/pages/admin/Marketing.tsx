import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, Input, Notice, Select, Spinner, Textarea, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { fmtDateTime } from "../../lib/dates";
import { orgPath, useAdmin } from "./ctx";

interface Camp { id: string; name: string; subject: string; segment: string; inactive_days: number | null; status: string; recipients_count: number; sent_at: string | null; created_at: string }

export function Marketing() {
  const { orgId, can } = useAdmin();
  const [d, setD] = useState<{ campaigns: Camp[]; configured: boolean; dailyCap: number } | null>(null);
  const [f, setF] = useState({ name: "", subject: "", body: "Olá, {{nome}}!\n\n", segment: "all_consented", days: "60" });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api<NonNullable<typeof d>>(orgPath(orgId, "/campaigns"), { auth: true }).then(setD).catch((e) => setError(errMsg(e))), [orgId, setError]);
  useEffect(() => { void load(); }, [load]);
  if (!can("marketing.manage")) return <Notice>Somente o proprietário gerencia campanhas.</Notice>;
  const days = Number(f.days);
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      {d && !d.configured && <Notice kind="warn">O envio está desligado: configure o provedor de e-mail e o segredo de descadastro no servidor (veja docs/INFRASTRUCTURE.md). Você já pode criar rascunhos.</Notice>}
      <Notice>Só recebem clientes que autorizaram novidades por e-mail (registre em Clientes → consentimento). Todo e-mail leva link de descadastro. Limite de {d?.dailyCap ?? 200} e-mails por dia.</Notice>
      <Card className="space-y-2">
        <h2 className="text-lg font-semibold">Nova campanha</h2>
        <Field label="Nome (interno)"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Assunto"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Mensagem" hint="Use {{nome}} para o primeiro nome do cliente."><Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-2">
          <Field label="Público"><Select value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })}><option value="all_consented">Todos que autorizaram</option><option value="inactive">Quem não vem há N dias</option></Select></Field>
          {f.segment === "inactive" && <Field label="Dias sem vir"><Input inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>}
        </div>
        <Button disabled={busy || f.name.trim().length < 2 || f.subject.trim().length < 2 || f.body.trim().length < 2 || (f.segment === "inactive" && !(Number.isInteger(days) && days >= 7 && days <= 730))}
          onClick={async () => { if (await run(() => api(orgPath(orgId, "/campaigns"), { method: "POST", auth: true, body: { name: f.name.trim(), subject: f.subject.trim(), body: f.body.trim(), segment: f.segment, inactiveDays: f.segment === "inactive" ? days : null } }))) { setF({ ...f, name: "", subject: "" }); await load(); } }}>Salvar rascunho</Button>
      </Card>
      {!d ? <Spinner /> : d.campaigns.map((c) => (
        <Card key={c.id} className="space-y-1">
          <div className="flex justify-between gap-2"><span className="font-medium">{c.name}</span><span className="text-sm text-mute">{c.status === "sent" ? `enviada · ${c.recipients_count}` : "rascunho"}</span></div>
          <p className="text-sm text-mute">{c.subject} · {c.segment === "inactive" ? `inativos há ${c.inactive_days} dias` : "todos que autorizaram"}{c.sent_at ? ` · ${fmtDateTime(c.sent_at)}` : ""}</p>
          {c.status === "draft" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={async () => { const r = await run(() => api<{ count: number }>(orgPath(orgId, `/campaigns/${c.id}/audience`), { auth: true })); if (r) setCounts({ ...counts, [c.id]: r.count }); }}>{counts[c.id] === undefined ? "Ver tamanho do público" : `${counts[c.id]} destinatário(s)`}</Button>
              <Button disabled={busy || !d.configured} onClick={async () => { if (!window.confirm("Enviar esta campanha agora? Não dá para desfazer.")) return; if (await run(() => api(orgPath(orgId, `/campaigns/${c.id}/send`), { method: "POST", auth: true }))) await load(); }}>Enviar</Button>
              <Button variant="danger" disabled={busy} onClick={async () => { if (await run(() => api(orgPath(orgId, `/campaigns/${c.id}`), { method: "DELETE", auth: true }))) await load(); }}>Apagar</Button>
            </div>)}
        </Card>
      ))}
    </div>
  );
}
