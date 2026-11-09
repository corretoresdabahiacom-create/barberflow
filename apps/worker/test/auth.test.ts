import { beforeEach, describe, expect, it } from "vitest";
import { E, api, clock, createShop, reset, signToken, uniq } from "./helpers";

beforeEach(reset);

describe("autenticação (Firebase ID token verificado no Worker)", () => {
  it("sem token → 401", async () => {
    expect((await api("GET", "/api/me")).status).toBe(401);
  });
  it("token lixo → 401", async () => {
    expect((await api("GET", "/api/me", { token: "abc.def.ghi" })).status).toBe(401);
  });
  it("assinado por chave desconhecida → 401", async () => {
    const t = await signToken({ uid: uniq("x"), rogue: true });
    expect((await api("GET", "/api/me", { token: t })).status).toBe(401);
  });
  it("audience e issuer errados → 401", async () => {
    expect((await api("GET", "/api/me", { token: await signToken({ uid: uniq("x"), aud: "outro-projeto" }) })).status).toBe(401);
    expect((await api("GET", "/api/me", { token: await signToken({ uid: uniq("x"), iss: "https://securetoken.google.com/outro" }) })).status).toBe(401);
  });
  it("token expirado → 401", async () => {
    const now = Math.floor(clock.ms / 1000);
    expect((await api("GET", "/api/me", { token: await signToken({ uid: uniq("x"), iat: now - 7200, exp: now - 10 }) })).status).toBe(401);
  });
  it("token com payload adulterado → 401", async () => {
    const t = await signToken({ uid: uniq("x") });
    const [h, p, s] = t.split(".") as [string, string, string];
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    payload.sub = "admin";
    const forged = `${h}.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${s}`;
    expect((await api("GET", "/api/me", { token: forged })).status).toBe(401);
  });
  it("token válido cria o usuário local", async () => {
    const uid = uniq("ok");
    const r = await api("GET", "/api/me", { token: await signToken({ uid }) });
    expect(r.status).toBe(200);
    const row = await E.DB.prepare("SELECT firebase_uid FROM users WHERE firebase_uid = ?").bind(uid).first();
    expect(row).toBeTruthy();
  });
  it("usuário suspenso → 403", async () => {
    const uid = uniq("susp");
    const t = await signToken({ uid });
    await api("GET", "/api/me", { token: t });
    await E.DB.prepare("UPDATE users SET status = 'suspended' WHERE firebase_uid = ?").bind(uid).run();
    expect((await api("GET", "/api/me", { token: t })).status).toBe(403);
  });
  it("revogação de sessões invalida tokens emitidos antes", async () => {
    const uid = uniq("rev");
    const old = await signToken({ uid });
    expect((await api("POST", "/api/me/sessions/revoke", { token: old })).status).toBe(200);
    expect((await api("GET", "/api/me", { token: old })).status).toBe(401);
    clock.ms += 5000; // novo login depois da revogação
    expect((await api("GET", "/api/me", { token: await signToken({ uid }) })).status).toBe(200);
  });
  it("e-mail não verificado não cria organização", async () => {
    const t = await signToken({ uid: uniq("nv"), verified: false });
    const r = await api("POST", "/api/orgs", { token: t, body: { name: "Teste Barbearia", unit: { name: "Matriz", slug: uniq("nv-") } } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("email_not_verified");
  });
  it("limite de organizações por conta e slug reservado/duplicado", async () => {
    const s = await createShop("lim");
    const dup = await api("POST", "/api/orgs", { token: s.ownerToken, body: { name: "Outra", unit: { name: "X1", slug: s.slug } } });
    expect(dup.status).toBe(409);
    const reserved = await api("POST", "/api/orgs", { token: s.ownerToken, body: { name: "Outra", unit: { name: "X1", slug: "admin" } } });
    expect(reserved.status).toBe(400);
    for (let i = 0; i < 2; i++) {
      expect((await api("POST", "/api/orgs", { token: s.ownerToken, body: { name: `Org ${i}`, unit: { name: "Un", slug: uniq("lim-") } } })).status).toBe(201);
    }
    const over = await api("POST", "/api/orgs", { token: s.ownerToken, body: { name: "Org 4", unit: { name: "Un", slug: uniq("lim-") } } });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("org_limit");
  });
});
