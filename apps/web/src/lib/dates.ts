export const fmtTime = (iso: string, tz = "America/Sao_Paulo") => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: tz });
export const fmtDate = (iso: string, tz = "America/Sao_Paulo") => new Date(iso).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short", timeZone: tz });
export const fmtDateTime = (iso: string, tz = "America/Sao_Paulo") => `${fmtDate(iso, tz)} · ${fmtTime(iso, tz)}`;

/** Data local "YYYY-MM-DD" de hoje em um fuso. */
export function todayIn(tz = "America/Sao_Paulo"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}
export function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Início do dia local (UTC ISO) — usa o deslocamento do fuso naquele dia. */
export function dayRangeUtc(date: string, tz = "America/Sao_Paulo"): { from: string; to: string } {
  const off = (d: string) => {
    const probe = new Date(`${d}T12:00:00Z`);
    const local = new Date(probe.toLocaleString("en-US", { timeZone: tz }));
    return Math.round((local.getTime() - probe.getTime()) / 60000);
  };
  const start = (d: string) => new Date(`${d}T00:00:00Z`).getTime() - off(d) * 60000;
  return { from: new Date(start(date)).toISOString(), to: new Date(start(addDaysStr(date, 1))).toISOString() };
}
