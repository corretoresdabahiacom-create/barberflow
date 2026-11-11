import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, runScheduled } from "../src/domain/outbox";
import { E, adminBook, api, apptCustomerId, clock, createShop, mailer, reset, signToken, testDeps, tue, type Shop } from "./helpers";

beforeEach(reset);

const run = () => runScheduled(E, testDeps);
const HOUR = 3600_000;

describe("lembretes por e-mail (outbox + cron)", () => {
  let S: Shop;
  let o: string;
  let appt: string;
  beforeEach(async () => {
    // o cron é global: zera o estado deixado por outros testes deste arquivo
    await E.DB.prepare("DELETE FROM outbox").run(); // tenant-ok: limpeza de teste
    await E.DB.prepare("UPDATE organizations SET reminders_enabled = 0").run(); // tenant-ok: limpeza de teste
    S = await createShop("out");
    o = `/api/orgs/${S.orgId}`;
    await api("PUT", `${o}/automation`, { token: S.ownerToken, body: { remindersEnabled: true } });
    appt = (await adminBook(S, tue(10), { customer: { name: "Maria Souza", phone: "71988887777", email: "maria@exemplo.com" } })).body.appointment.id;
    clock.ms = Date.parse(tue(10)) - 20 * HOUR; // faltam 20 h
    S.ownerToken = await signToken({ uid: S.ownerUid });
  });
  const rows = async () => (await E.DB.prepare("SELECT status, attempts, last_error, to_email, subject, body FROM outbox WHERE appointment_id = ?").bind(appt).all<{ status: string; attempts: number; last_error: string | null; to_email: string; subject: string; body: string }>()).results;

  it("enfileira e envia 1 lembrete; segunda execução não repete (dedupe)", async () => {
    expect(await run()).toMatchObject({ enqueued: 1, sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("maria@exemplo.com");
    expect(mailer.sent[0]!.subject).toContain("Barbearia out");
    expect(mailer.sent[0]!.body).toContain("Olá, Maria!");
    expect(mailer.sent[0]!.body).not.toContain("71988887777"); // sem telefone do cliente no corpo
    expect(await run()).toMatchObject({ enqueued: 0, sent: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect((await rows())[0]!.status).toBe("sent");
  });

  it("desligado por padrão: organização sem `remindersEnabled` não envia nada", async () => {
    await api("PUT", `${o}/automation`, { token: S.ownerToken, body: { remindersEnabled: false } });
    expect(await run()).toMatchObject({ enqueued: 0, sent: 0 });
    expect(mailer.sent).toHaveLength(0);
  });

  it("provedor de e-mail não configurado: nada é enfileirado", async () => {
    mailer.enabled = false;
    expect(await run()).toMatchObject({ enqueued: 0, sent: 0 });
    expect(await rows()).toHaveLength(0);
  });

  it("respeita opt-out vigente (service_notifications/email) e volta a enviar se reativado", async () => {
    const cid = await apptCustomerId(appt);
    await api("POST", `${o}/customers/${cid}/consents`, { token: S.ownerToken, body: { email: true, granted: false, purpose: "service_notifications", source: "customer_request" } });
    expect(await run()).toMatchObject({ enqueued: 0 });
    clock.ms += 60_000;
    S.ownerToken = await signToken({ uid: S.ownerUid });
    await api("POST", `${o}/customers/${cid}/consents`, { token: S.ownerToken, body: { email: true, granted: true, purpose: "service_notifications", source: "customer_request" } });
    expect(await run()).toMatchObject({ enqueued: 1, sent: 1 });
  });

  it("só enfileira na janela de +2 h a +24 h e só agendamentos confirmados", async () => {
    clock.ms = Date.parse(tue(10)) - 30 * HOUR; // longe demais
    expect(await run()).toMatchObject({ enqueued: 0 });
    clock.ms = Date.parse(tue(10)) - 1 * HOUR; // perto demais
    expect(await run()).toMatchObject({ enqueued: 0 });
    clock.ms = Date.parse(tue(10)) - 20 * HOUR;
    await E.DB.prepare("UPDATE appointments SET status = 'pending' WHERE id = ?").bind(appt).run();
    expect(await run()).toMatchObject({ enqueued: 0 });
  });

  it("cliente sem e-mail não recebe", async () => {
    const other = (await adminBook(S, tue(11), { customer: { name: "Sem Email", phone: "71977776666" } })).body.appointment.id;
    await run();
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE appointment_id = ?").bind(other).first<{ n: number }>())!.n).toBe(0);
  });

  it("falha do provedor: retry com backoff, até 5 tentativas, depois `failed`", async () => {
    mailer.failWith = "email_provider_500";
    expect(await run()).toMatchObject({ enqueued: 1, sent: 0, retried: 1 });
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "email_provider_500" });
    // antes do backoff nada acontece
    expect(await run()).toMatchObject({ retried: 0, failed: 0, sent: 0 });
    for (let i = 2; i < MAX_ATTEMPTS; i++) {
      clock.ms += 7 * HOUR; // acima do teto de backoff (6 h)
      expect(await run()).toMatchObject({ retried: 1 });
    }
    clock.ms += 7 * HOUR;
    expect(await run()).toMatchObject({ failed: 1 });
    expect((await rows())[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    clock.ms += 7 * HOUR;
    mailer.failWith = null;
    expect(await run()).toMatchObject({ sent: 0 }); // `failed` é terminal
    expect(mailer.sent).toHaveLength(0);
  });

  it("recupera após falha transitória", async () => {
    mailer.failWith = "timeout";
    await run();
    mailer.failWith = null;
    clock.ms += 1 * HOUR;
    expect(await run()).toMatchObject({ sent: 1 });
    expect((await rows())[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("agendamento cancelado depois de enfileirado vira `skipped` sem enviar", async () => {
    mailer.failWith = "timeout";
    await run(); // enfileira, falha, fica pendente
    mailer.failWith = null;
    await api("POST", `${o}/appointments/${appt}/cancel`, { token: S.ownerToken, body: {} }).catch(() => null);
    await E.DB.prepare("UPDATE appointments SET status = 'cancelled', cancelled_by = 'staff', cancelled_at = '2026-11-09T00:00:00Z' WHERE id = ?").bind(appt).run();
    clock.ms += 1 * HOUR;
    expect(await run()).toMatchObject({ skipped: 1, sent: 0 });
    expect(mailer.sent).toHaveLength(0);
    expect((await rows())[0]!.status).toBe("skipped");
  });

  it("isola organizações: só envia para a que ligou; ligando as duas, cada e-mail leva o nome da própria loja", async () => {
    const B = await createShop("outB");
    await adminBook(B, tue(10), { customer: { name: "Carlos Lima", phone: "71966665555", email: "carlos@exemplo.com" } });
    await run(); // B não ligou lembretes
    expect(mailer.sent.map((m) => m.to)).toEqual(["maria@exemplo.com"]);
    clock.ms += 5 * 60_000;
    B.ownerToken = await signToken({ uid: B.ownerUid });
    await api("PUT", `/api/orgs/${B.orgId}/automation`, { token: B.ownerToken, body: { remindersEnabled: true } });
    await run();
    const carlos = mailer.sent.find((m) => m.to === "carlos@exemplo.com")!;
    expect(carlos.subject).toContain("Barbearia outB");
    expect(carlos.body).toContain("Carlos");
    expect(mailer.sent.find((m) => m.to === "maria@exemplo.com")!.subject).not.toContain("outB");
  });

  it("dono vê o estado da fila da própria organização (sem corpo); outra organização não vê", async () => {
    await run();
    const mine = await api("GET", `${o}/outbox`, { token: S.ownerToken });
    expect(mine.status).toBe(200);
    expect(mine.body.outbox).toHaveLength(1);
    expect(mine.body.outbox[0].body).toBeUndefined();
    const B = await createShop("outC");
    expect((await api("GET", `/api/orgs/${B.orgId}/outbox`, { token: B.ownerToken })).body.outbox).toHaveLength(0);
    expect((await api("GET", `${o}/outbox`, { token: B.ownerToken })).status).toBe(404);
  });

  it("concorrência: duas execuções do cron ao mesmo tempo enviam uma única vez", async () => {
    await Promise.all([run(), run()]);
    expect(mailer.sent).toHaveLength(1);
  });
});
