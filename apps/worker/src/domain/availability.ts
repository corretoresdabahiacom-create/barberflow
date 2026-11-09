import { addDays, localToUtcMs, slotOf, SLOT_MS, utcMsToLocalDate, weekdayOf } from "../lib/time";

export interface UnitCfg {
  id: string;
  timezone: string;
  min_notice_min: number;
  max_days_ahead: number;
  slot_step_min: number;
}

export interface DayContext {
  windows: { start_min: number; end_min: number }[];
  blocks: { start: number; end: number }[];
  busy: Set<number>;
}

/** Horários de início possíveis (epoch ms) para uma ocupação de `occupiedMin` minutos. Função pura. */
export function computeSlotStarts(args: {
  unit: UnitCfg;
  date: string;
  occupiedMin: number;
  ctx: DayContext;
  nowMs: number;
}): number[] {
  const { unit, date, occupiedMin, ctx, nowMs } = args;
  const tz = unit.timezone;

  const today = utcMsToLocalDate(nowMs, tz);
  if (date < today || date > addDays(today, unit.max_days_ahead)) return [];

  const earliest = nowMs + unit.min_notice_min * 60_000;
  const step = unit.slot_step_min;
  const out: number[] = [];

  for (const w of ctx.windows) {
    const first = Math.ceil(w.start_min / step) * step;
    for (let m = first; m + occupiedMin <= w.end_min; m += step) {
      const start = localToUtcMs(date, m, tz);
      const end = start + occupiedMin * 60_000;
      if (start < earliest) continue;
      if (ctx.blocks.some((b) => start < b.end && end > b.start)) continue;
      let clash = false;
      for (let s = slotOf(start); s < slotOf(end); s++) {
        if (ctx.busy.has(s)) {
          clash = true;
          break;
        }
      }
      if (!clash) out.push(start);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export async function loadDayContext(
  db: D1Database,
  orgId: string,
  unitId: string,
  tz: string,
  professionalId: string,
  date: string,
  excludeAppointmentId?: string,
): Promise<DayContext> {
  const dayStart = localToUtcMs(date, 0, tz);
  const dayEnd = localToUtcMs(addDays(date, 1), 0, tz);
  const weekday = weekdayOf(date);

  const [win, blk, busy] = await Promise.all([
    db
      .prepare(
        `SELECT start_min, end_min FROM schedules
          WHERE organization_id = ? AND professional_id = ? AND unit_id = ? AND weekday = ?
          ORDER BY start_min`,
      )
      .bind(orgId, professionalId, unitId, weekday)
      .all<{ start_min: number; end_min: number }>(),
    db
      .prepare(
        `SELECT starts_at, ends_at FROM time_blocks
          WHERE organization_id = ? AND professional_id = ? AND starts_at < ? AND ends_at > ?`,
      )
      .bind(orgId, professionalId, new Date(dayEnd).toISOString().replace(/\.\d{3}Z$/, "Z"), new Date(dayStart).toISOString().replace(/\.\d{3}Z$/, "Z"))
      .all<{ starts_at: string; ends_at: string }>(),
    db
      .prepare(
        `SELECT slot, appointment_id FROM appointment_slots
          WHERE organization_id = ? AND professional_id = ? AND slot >= ? AND slot < ?`,
      )
      .bind(orgId, professionalId, slotOf(dayStart) - 60, slotOf(dayEnd) + 60)
      .all<{ slot: number; appointment_id: string }>(),
  ]);

  return {
    windows: win.results,
    blocks: blk.results.map((b) => ({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at) })),
    busy: new Set(busy.results.filter((r) => r.appointment_id !== excludeAppointmentId).map((r) => r.slot)),
  };
}

export { SLOT_MS };
