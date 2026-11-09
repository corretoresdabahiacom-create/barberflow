import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const v = {
    primary: "bg-amber text-ink hover:bg-amber-dark font-semibold",
    ghost: "bg-panel text-cream hover:bg-line border border-line",
    danger: "bg-bad/90 text-ink hover:bg-bad font-semibold",
  }[variant];
  return <button {...p} className={`min-h-11 rounded-xl px-4 py-2 text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${v} ${className}`} />;
}

const field = "w-full min-h-11 rounded-xl border border-line bg-coal px-3 py-2 text-cream placeholder:text-mute/70";
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-mute">{label}</span>
      {children}
      {hint && <span className="block text-xs text-mute/80">{hint}</span>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${field} ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`${field} ${p.className ?? ""}`} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${field} ${p.className ?? ""}`} />;

export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>{children}</div>
);

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  const c = { info: "border-line text-cream", error: "border-bad/60 text-bad", ok: "border-ok/60 text-ok", warn: "border-amber/60 text-amber" }[kind];
  return <div role={kind === "error" ? "alert" : "status"} className={`rounded-xl border bg-coal px-3 py-2 text-sm ${c}`}>{children}</div>;
}

export const Spinner = () => <div role="status" aria-label="Carregando" className="mx-auto my-8 size-8 animate-spin rounded-full border-4 border-line border-t-amber" />;

export function Badge({ status }: { status: string }) {
  const m: Record<string, [string, string]> = {
    pending: ["Pendente", "bg-amber/20 text-amber"], confirmed: ["Confirmado", "bg-ok/20 text-ok"],
    completed: ["Concluído", "bg-cream/10 text-cream"], cancelled: ["Cancelado", "bg-bad/20 text-bad"], no_show: ["Faltou", "bg-bad/20 text-bad"],
  };
  const [t, c] = m[status] ?? [status, "bg-line text-cream"];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{t}</span>;
}

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`font-extrabold tracking-tight ${size === "lg" ? "text-4xl" : "text-xl"}`}>
      Na<span className="text-amber">Régua</span>
    </span>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try { return await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Algo deu errado."); return undefined; } finally { setBusy(false); }
  }
  return { busy, error, setError, run };
}
