import { beforeEach, describe, expect, it } from "vitest";
import { addStaff, api, createShop, reset, uniq } from "./helpers";

beforeEach(reset);

describe("vitrine / descoberta", () => {
  const list = (qs = "") => api("GET", `/api/public/discover${qs}`);
  const patch = (S: { orgId: string; unitId: string; ownerToken: string }, body: unknown, token = S.ownerToken) =>
    api("PATCH", `/api/orgs/${S.orgId}/units/${S.unitId}`, { token, body });

  it("unidade nova NÃO aparece (opt-in); só aparece depois de ligar `listed` com cidade e UF", async () => {
    const S = await createShop("vit");
    expect((await list(`?q=${encodeURIComponent("Barbearia vit")}`)).body.units).toHaveLength(0);
    const bad = await patch(S, { listed: true });
    expect(bad.status).toBe(400);
    expect((await patch(S, { listed: true, city: "Salvador", state: "ba", description: "Corte clássico" })).status).toBe(200);
    const r = await list(`?q=${encodeURIComponent("Barbearia vit")}`);
    expect(r.body.units).toHaveLength(1);
    expect(r.body.units[0]).toMatchObject({ slug: S.slug, city: "Salvador", state: "BA", description: "Corte clássico" });
  });

  it("expõe só campos de divulgação (sem telefone, sem IDs internos)", async () => {
    const S = await createShop("vit2");
    await patch(S, { listed: true, city: "Recife", state: "PE", phone: "81999990000" });
    const u = (await list("?state=PE&city=recife")).body.units.find((x: { slug: string }) => x.slug === S.slug);
    expect(u).toBeTruthy();
    expect(Object.keys(u).sort()).toEqual(["address", "city", "description", "organization_name", "slug", "state", "unit_name"]);
  });

  it("filtros por UF, cidade e busca; desligar ou inativar remove da vitrine", async () => {
    const S = await createShop("vit3");
    await patch(S, { listed: true, city: "Natal", state: "RN" });
    const has = async (qs: string) => (await list(qs)).body.units.some((x: { slug: string }) => x.slug === S.slug);
    expect(await has("?state=RN")).toBe(true);
    expect(await has("?state=SP")).toBe(false);
    expect(await has("?city=natal")).toBe(true);
    expect(await has("?city=outra")).toBe(false);
    await patch(S, { listed: false });
    expect(await has("?state=RN")).toBe(false);
    await patch(S, { listed: true });
    await patch(S, { status: "inactive" });
    expect(await has("?state=RN")).toBe(false);
  });

  it("só quem tem unit.manage liga a vitrine; barbeiro/gerente não", async () => {
    const S = await createShop("vit4");
    const barber = await addStaff(S, "barber");
    const manager = await addStaff(S, "manager");
    expect((await patch(S, { listed: true, city: "Lagoa", state: "SP" }, barber.token)).status).toBe(403);
    expect((await patch(S, { listed: true, city: "Lagoa", state: "SP" }, manager.token)).status).toBe(403);
  });

  it("valida parâmetros e UF/descrição; injeção em busca não quebra", async () => {
    const S = await createShop("vit5");
    expect((await patch(S, { state: "BAH" })).status).toBe(400);
    expect((await patch(S, { state: "B1" })).status).toBe(400);
    expect((await patch(S, { description: "x".repeat(301) })).status).toBe(400);
    expect((await list("?limit=999")).status).toBe(400);
    expect((await list("?state=BAH")).status).toBe(400);
    expect((await list(`?q=${encodeURIComponent("%' OR 1=1 --")}`)).status).toBe(200);
  });

  it("limite de requisições por IP", async () => {
    let last = 200;
    for (let i = 0; i < 65; i++) last = (await api("GET", "/api/public/discover", { headers: { "cf-connecting-ip": uniq("ip") === "x" ? "" : "9.9.9.9" } })).status;
    expect(last).toBe(429);
  });
});
