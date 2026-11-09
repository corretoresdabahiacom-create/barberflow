import { describe, expect, it } from "vitest";
import { can, allowedUnits, type OrgContext } from "../src/auth/rbac";
import { addDays, localToUtcMs, utcMsToLocalDate, weekdayOf, isValidDateStr } from "../src/lib/time";
import { normalizePhone, normalizeEmail } from "@naregua/shared";

describe("fuso horário", () => {
  it("São Paulo é UTC-3 (sem horário de verão)", () => {
    expect(new Date(localToUtcMs("2026-11-10", 600, "America/Sao_Paulo")).toISOString()).toBe("2026-11-10T13:00:00.000Z");
    expect(utcMsToLocalDate(Date.UTC(2026, 10, 10, 2, 0), "America/Sao_Paulo")).toBe("2026-11-09");
  });
  it("outro fuso e virada de horário de verão", () => {
    // Nova York: 2026-03-08 02:00 → 03:00 (DST). 12:00 local já é UTC-4.
    expect(new Date(localToUtcMs("2026-03-08", 720, "America/New_York")).toISOString()).toBe("2026-03-08T16:00:00.000Z");
    expect(new Date(localToUtcMs("2026-03-07", 720, "America/New_York")).toISOString()).toBe("2026-03-07T17:00:00.000Z");
  });
  it("datas", () => {
    expect(weekdayOf("2026-11-10")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isValidDateStr("2026-02-30")).toBe(false);
    expect(isValidDateStr("2026-02-28")).toBe(true);
  });
});

describe("normalização", () => {
  it("telefone brasileiro", () => {
    expect(normalizePhone("(71) 99999-1234")).toBe(normalizePhone("+55 71 99999 1234"));
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("7199999123")).toBeNull(); // celular sem o 9
    expect(normalizePhone("7133334444")).not.toBeNull(); // fixo
  });
  it("e-mail", () => {
    expect(normalizeEmail("  Fulano@Exemplo.COM ")).toBe("fulano@exemplo.com");
    expect(normalizeEmail("sem-arroba")).toBeNull();
  });
});

describe("rbac puro", () => {
  const mk = (...m: [string | null, "owner" | "unit_admin" | "manager" | "barber", number?][]): OrgContext => ({
    id: "o", memberships: m.map(([unit_id, role, pay], i) => ({ id: `m${i}`, unit_id, role, can_receive_payments: pay ?? 0 })),
  });
  it("owner tem tudo; permissões de org exigem vínculo da organização", () => {
    expect(can(mk([null, "owner"]), "user.manage")).toBe(true);
    expect(can(mk(["u1", "unit_admin"]), "user.manage")).toBe(false);
    expect(can(mk(["u1", "unit_admin"]), "org.manage")).toBe(false);
    expect(can(mk(["u1", "unit_admin"]), "unit.manage", "u1")).toBe(true);
    expect(can(mk(["u1", "unit_admin"]), "unit.manage", "u2")).toBe(false);
  });
  it("barbeiro e flag de pagamento", () => {
    expect(can(mk(["u1", "barber"]), "payment.create", "u1")).toBe(false);
    expect(can(mk(["u1", "barber", 1]), "payment.create", "u1")).toBe(true);
    expect(can(mk(["u1", "barber", 1]), "payment.create", "u2")).toBe(false);
    expect(allowedUnits(mk(["u1", "manager"], ["u2", "manager"]), "agenda.read")).toEqual(["u1", "u2"]);
  });
});
