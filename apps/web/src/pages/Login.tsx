import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Button, Card, Field, Input, Notice, useAsync } from "../components/ui";
import { authErrorMessage, useAuth } from "../lib/auth";
import { Shell } from "./PublicBooking";

export function Login() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"in" | "up">(params.get("novo") ? "up" : "in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, setError, run } = useAsync();
  const next = params.get("next") || "/c";

  if (auth.user && auth.ready) return <Navigate to={auth.me && auth.me.memberships.length > 0 ? "/app" : next} replace />;
  if (!auth.configured) {
    return <Shell title="Entrar"><Notice kind="warn">Login indisponível: a configuração do Firebase ainda não foi feita neste ambiente (variáveis VITE_FIREBASE_*). Veja docs/INFRASTRUCTURE.md.</Notice></Shell>;
  }
  const wrap = (fn: () => Promise<void>) => run(async () => { try { await fn(); } catch (e) { throw new Error(authErrorMessage(e)); } });

  return (
    <Shell title={mode === "in" ? "Entrar" : "Criar conta"}>
      <Card className="space-y-3">
        {mode === "up" && <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
        <Field label="E-mail"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Senha"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "in" ? "current-password" : "new-password"} /></Field>
        {error && <Notice kind="error">{error}</Notice>}
        {msg && <Notice kind="ok">{msg}</Notice>}
        <Button className="w-full" disabled={busy || !email || password.length < 6 || (mode === "up" && name.trim().length < 2)}
          onClick={() => wrap(() => (mode === "in" ? auth.signIn(email, password) : auth.signUp(name.trim(), email, password)))}>
          {mode === "in" ? "Entrar" : "Criar conta"}
        </Button>
        <Button variant="ghost" className="w-full" disabled={busy} onClick={() => wrap(auth.signInGoogle)}>Continuar com Google</Button>
        <div className="flex justify-between text-sm">
          <button className="text-amber underline" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}>{mode === "in" ? "Criar conta" : "Já tenho conta"}</button>
          {mode === "in" && <button className="text-mute underline" disabled={!email} onClick={() => wrap(async () => { await auth.resetPassword(email); setMsg("Se o e-mail existir, enviamos um link para redefinir a senha."); })}>Esqueci a senha</button>}
        </div>
      </Card>
      <p className="text-xs text-mute">Ao continuar você aceita os <Link to="/termos" className="underline">Termos</Link> e a <Link to="/privacidade" className="underline">Política de Privacidade</Link>.</p>
    </Shell>
  );
}
