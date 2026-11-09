import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Notice, Select, Spinner, useAsync } from "../../components/ui";
import { api, errMsg } from "../../lib/api";
import { fmtDateTime } from "../../lib/dates";
import { orgPath, useAdmin } from "./ctx";

interface Cust { id: string; name: string; phone: string | null; email: string | null; status: string; no_show_count: number }
interface Detail { customer: Cust & { notes: string | null }; appointments: { id: string; starts_at: string; status: string }[]; consents: { channel: string; granted: number; created_at: string }[]; totalPaidCents: number }

export function Customers() {
  const { orgId, can } = useAdmin();
  const [q, setQ] = useState("");
  const [list, setList] = useState<Cust[] | null>(null);
  const [sel, setSel] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const { busy, error, run, setError } = useAsync();
  const load = useCallback(() => api<{ customers: Cust[] }>(orgPath(orgId, `/customers?q=${encodeURIComponent(q)}`), { auth: true }).then((r) => setList(r.customers)).catch((e) => setError(errMsg(e))), [orgId, q, setError]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  const open = (id: string) => run(async () => setSel(await api<Detail>(orgPath(orgId, `/customers/${id}`), { auth: true })));
  const isOwner = can("org.manage");
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <Input placeholder="Buscar por nome, telefone ou e-mail" aria-label="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} />
      {can("customer.write") && (
        <Card className="space-y-2"><h2 className="font-semibold">Novo cliente</h2>
          <div className="grid gap-2 sm:grid-cols-2"><Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Telefone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field></div>
          <Button disabled={busy || name.trim().length < 2 || phone.replace(/\D/g, "").length < 10} onClick={async () => { const r = await run(() => api(orgPath(orgId, "/customers"), { method: "POST", auth: true, body: { name: name.trim(), phone } })); if (r) { setName(""); setPhone(""); void load(); } }}>Cadastrar</Button>
        </Card>
      )}
      {list === null ? <Spinner /> : list.length === 0 ? <Notice>Nenhum cliente encontrado.</Notice> : list.map((c) => (
        <button key={c.id} onClick={() => open(c.id)} className="block min-h-11 w-full rounded-xl border border-line bg-panel p-3 text-left">
          <div className="font-medium">{c.name}</div><div className="text-sm text-mute">{c.phone} {c.no_show_count > 0 && `· ${c.no_show_count} falta(s)`}</div>
        </button>
      ))}
      {sel && (
        <Card className="space-y-2"><div className="flex justify-between"><h2 className="font-semibold">{sel.customer.name}</h2><button aria-label="Fechar" onClick={() => setSel(null)}>×</button></div>
          <p className="text-sm text-mute">{sel.customer.phone} · {sel.customer.email ?? "sem e-mail"}</p>
          <p className="text-sm">Consentimento de marketing: {sel.consents.filter((c) => c.channel !== "").map((c) => `${c.channel}: ${c.granted ? "sim" : "não"}`).join(", ") || "nenhum registro"}</p>
          <ul className="text-sm">{sel.appointments.slice(0, 8).map((a) => <li key={a.id} className="flex justify-between"><span>{fmtDateTime(a.starts_at)}</span><Badge status={a.status} /></li>)}</ul>
          {isOwner && (
            <div className="flex gap-2 border-t border-line pt-2">
              <Button variant="ghost" onClick={async () => { const d = await api(orgPath(orgId, `/customers/${sel.customer.id}/export`), { auth: true }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })); a.download = `cliente-${sel.customer.id}.json`; a.click(); }}>Exportar dados (LGPD)</Button>
              <Button variant="danger" onClick={() => confirm("Anonimizar este cliente? Isso é irreversível.") && run(async () => { await api(orgPath(orgId, `/customers/${sel.customer.id}/anonymize`), { method: "POST", auth: true }); setSel(null); await load(); })}>Anonimizar</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

interface Member { id: string; role: string; status: string; email: string | null; invited_email: string | null; display_name: string | null; unit_name: string | null; can_receive_payments: number }
const ROLE_PT: Record<string, string> = { owner: "Dono", unit_admin: "Admin da unidade", manager: "Gerente", barber: "Barbeiro" };

export function Team() {
  const { orgId, units, can } = useAdmin();
  const [list, setList] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("barber");
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [pay, setPay] = useState(false);
  const { busy, error, run, setError } = useAsync();
  const load = useCallback(() => api<{ members: Member[] }>(orgPath(orgId, "/members"), { auth: true }).then((r) => setList(r.members)).catch((e) => setError(errMsg(e))), [orgId, setError]);
  useEffect(() => { if (can("user.manage")) void load(); }, [load, can]);
  if (!can("user.manage")) return <Notice>Somente o dono gerencia a equipe.</Notice>;
  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <Card className="space-y-2"><h2 className="font-semibold">Convidar pessoa</h2>
        <Field label="E-mail" hint="Ela assume o acesso ao entrar com este e-mail já verificado."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Papel"><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="barber">Barbeiro</option><option value="manager">Gerente</option><option value="unit_admin">Admin da unidade</option></Select></Field>
          <Field label="Unidade"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        </div>
        {role === "barber" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-amber" checked={pay} onChange={(e) => setPay(e.target.checked)} />Pode registrar recebimentos dos próprios atendimentos</label>}
        <Button disabled={busy || !email.includes("@")} onClick={async () => { const r = await run(() => api(orgPath(orgId, "/members"), { method: "POST", auth: true, body: { email, role, unitId, canReceivePayments: role === "barber" ? pay : undefined } })); if (r) { setEmail(""); void load(); } }}>Convidar</Button>
      </Card>
      {list === null ? <Spinner /> : list.map((m) => (
        <Card key={m.id} className="flex items-center justify-between gap-2">
          <div><div className="font-medium">{m.display_name ?? m.email ?? m.invited_email}</div><div className="text-sm text-mute">{ROLE_PT[m.role]} · {m.unit_name ?? "toda a organização"} · {m.status === "invited" ? "convite pendente" : m.status === "suspended" ? "suspenso" : "ativo"}</div></div>
          {m.role !== "owner" && <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await api(orgPath(orgId, `/members/${m.id}`), { method: "PATCH", auth: true, body: { status: m.status === "suspended" ? "active" : "suspended" } }); await load(); })}>{m.status === "suspended" ? "Reativar" : "Suspender"}</Button>
            <Button variant="danger" disabled={busy} onClick={() => confirm("Remover esta pessoa?") && run(async () => { await api(orgPath(orgId, `/members/${m.id}`), { method: "DELETE", auth: true }); await load(); })}>Remover</Button>
          </div>}
        </Card>
      ))}
    </div>
  );
}
