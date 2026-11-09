/** Normaliza telefone brasileiro para DDD + número (10 ou 11 dígitos). Retorna null se inválido. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = input.replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (d.startsWith("0")) return null;
  if (d.length === 11 && d[2] !== "9") return null; // celular com 9 dígitos
  if (d.length === 10 && !/[2-5]/.test(d[2] ?? "")) return null; // fixo começa com 2–5; celular sem o 9 é inválido
  return d;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return e.length > 0 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export const WEEKDAYS_PT = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;

export function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60).toString().padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function hhmmToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}
