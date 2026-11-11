import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, Field, Input, Notice, Spinner } from "../components/ui";
import { api, errMsg } from "../lib/api";
import { Shell } from "./PublicBooking";

interface U { slug: string; unit_name: string; organization_name: string; city: string; state: string; address: string | null; description: string | null }

export function Discover() {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [list, setList] = useState<U[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setList(null);
      const p = new URLSearchParams(); if (q.trim()) p.set("q", q.trim()); if (/^[A-Za-z]{2}$/.test(state)) p.set("state", state);
      api<{ units: U[] }>(`/public/discover?${p}`).then((r) => { setList(r.units); setErr(null); }).catch((e) => setErr(errMsg(e)));
    }, 300);
    return () => clearTimeout(t);
  }, [q, state]);
  return (
    <Shell title="Encontre uma barbearia" subtitle="Barbearias que escolheram aparecer aqui">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="sm:col-span-2"><Field label="Buscar por nome"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome da barbearia" /></Field></div>
        <Field label="UF"><Input maxLength={2} value={state} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="BA" /></Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {list === null ? <Spinner /> : list.length === 0 ? <Notice>Nenhuma barbearia encontrada.</Notice> : list.map((u) => (
        <Card key={u.slug} className="space-y-1">
          <h2 className="font-semibold">{u.organization_name}{u.unit_name !== u.organization_name ? ` — ${u.unit_name}` : ""}</h2>
          <p className="text-sm text-mute">{u.city}/{u.state}{u.address ? ` · ${u.address}` : ""}</p>
          {u.description && <p className="text-sm">{u.description}</p>}
          <Link to={`/b/${u.slug}`} className="inline-block min-h-11 py-2 text-amber underline">Ver horários e agendar</Link>
        </Card>
      ))}
    </Shell>
  );
}
