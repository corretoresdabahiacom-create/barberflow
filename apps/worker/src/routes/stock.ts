import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware";
import { requirePerm } from "../auth/rbac";
import { auditStmt } from "../lib/audit";
import { HttpError, notFound, parseBody, parseQuery } from "../lib/http";
import { idempotencyKey, requireUnit, unitScope } from "../lib/scope";
import { isoNow, newId } from "../lib/util";

export const stockRoutes = new Hono<AppEnv>();

const id = z.string().min(10).max(64);

// ---------------------------------------------------------------- Produtos (catálogo da organização; só proprietário altera)
const productBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    sku: z.string().trim().min(1).max(40).nullable().optional(),
    priceCents: z.number().int().min(0).max(100_000_000),
    costCents: z.number().int().min(0).max(100_000_000).default(0),
    minStock: z.number().int().min(0).max(100000).default(0),
  })
  .strict();

stockRoutes.get("/products", async (c) => {
  const org = c.get("org");
  requirePerm(org, "stock.read");
  const { results } = await c.env.DB.prepare("SELECT id, name, sku, price_cents, cost_cents, min_stock, status FROM products WHERE organization_id = ? ORDER BY name").bind(org.id).all();
  return c.json({ products: results });
});

stockRoutes.post("/products", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const b = await parseBody(c, productBody);
  const now = isoNow(c.get("deps").now());
  const pid = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO products (id, organization_id, name, sku, price_cents, cost_cents, min_stock, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
        .bind(pid, org.id, b.name, b.sku ?? null, b.priceCents, b.costCents, b.minStock, now, now),
      auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "product.created", entity: "product", entityId: pid, now }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) throw new HttpError(409, "sku_exists", "SKU já cadastrado");
    throw e;
  }
  return c.json({ id: pid }, 201);
});

stockRoutes.patch("/products/:id", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  requirePerm(org, "org.manage");
  const b = await parseBody(c, productBody.partial().extend({ status: z.enum(["active", "inactive"]).optional() }).strict());
  const now = isoNow(c.get("deps").now());
  let res;
  try {
    res = await c.env.DB.prepare(
      `UPDATE products SET name = COALESCE(?, name), sku = CASE WHEN ? THEN ? ELSE sku END, price_cents = COALESCE(?, price_cents),
              cost_cents = COALESCE(?, cost_cents), min_stock = COALESCE(?, min_stock), status = COALESCE(?, status), updated_at = ?
        WHERE organization_id = ? AND id = ?`,
    ).bind(b.name ?? null, b.sku !== undefined ? 1 : 0, b.sku ?? null, b.priceCents ?? null, b.costCents ?? null, b.minStock ?? null, b.status ?? null, now, org.id, c.req.param("id")).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) throw new HttpError(409, "sku_exists", "SKU já cadastrado");
    throw e;
  }
  if ((res.meta.changes ?? 0) === 0) throw notFound();
  await c.env.DB.batch([auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "product.updated", entity: "product", entityId: c.req.param("id"), details: { fields: Object.keys(b) }, now })]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Movimentações (append-only; saldo = SUM por unidade)
const moveBody = z
  .object({
    unitId: id,
    productId: id,
    kind: z.enum(["purchase", "sale", "adjustment", "loss"]),
    /** purchase/sale/loss: quantidade POSITIVA (o sinal vem do tipo). adjustment: com sinal (+/−). */
    qty: z.number().int().min(-100000).max(100000).refine((n) => n !== 0, "qty não pode ser 0"),
    unitPriceCents: z.number().int().min(0).max(100_000_000).optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

interface MoveRow { unit_id: string; product_id: string; kind: string; qty: number }

stockRoutes.post("/stock/movements", async (c) => {
  const org = c.get("org");
  const user = c.get("user");
  const key = idempotencyKey(c);
  const b = await parseBody(c, moveBody);
  requirePerm(org, "stock.write", b.unitId);
  await requireUnit(c.env.DB, org.id, b.unitId);

  let signed: number;
  if (b.kind === "adjustment") signed = b.qty;
  else {
    if (b.qty < 0) throw new HttpError(400, "validation_error", "Informe a quantidade positiva; o tipo define o sinal");
    signed = b.kind === "purchase" ? b.qty : -b.qty;
  }

  const find = () =>
    c.env.DB.prepare("SELECT id, unit_id, product_id, kind, qty FROM stock_movements WHERE organization_id = ? AND idempotency_key = ?").bind(org.id, key).first<MoveRow & { id: string }>();
  const replay = (m: MoveRow & { id: string }) => {
    if (m.unit_id !== b.unitId || m.product_id !== b.productId || m.kind !== b.kind || m.qty !== signed) {
      throw new HttpError(409, "idempotency_conflict", "Esta chave já foi usada com outros dados");
    }
    return c.json({ id: m.id, replayed: true }, 200);
  };
  const prior = await find();
  if (prior) return replay(prior);

  const now = isoNow(c.get("deps").now());
  const mid = newId();
  let changes = 0;
  try {
    // Insert condicional e atômico: só grava se o saldo da unidade não ficar negativo.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO stock_movements (id, organization_id, unit_id, product_id, kind, qty, unit_price_cents, note, idempotency_key, created_by_user_id, created_at)
         SELECT ?, p.organization_id, ?, p.id, ?, ?, CASE WHEN ? = 'sale' THEN COALESCE(?, p.price_cents) END, ?, ?, ?, ?
           FROM products p
          WHERE p.organization_id = ? AND p.id = ? AND (p.status = 'active' OR ? < 0)
            AND (SELECT COALESCE(SUM(m.qty), 0) FROM stock_movements m WHERE m.organization_id = p.organization_id AND m.unit_id = ? AND m.product_id = p.id) + ? >= 0`,
      ).bind(
        mid, b.unitId, b.kind, signed,
        b.kind, b.unitPriceCents ?? null, // venda sem preço informado congela o preço atual do produto
        b.note ?? null, key, user.id, now,
        org.id, b.productId, signed, b.unitId, signed,
      ),
    ]);
    changes = res[0]?.meta.changes ?? 0;
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: stock_movements")) {
      const again = await find();
      if (again) return replay(again);
    }
    throw e;
  }
  if (changes === 0) {
    const p = await c.env.DB.prepare("SELECT id, status FROM products WHERE organization_id = ? AND id = ?").bind(org.id, b.productId).first<{ id: string; status: string }>();
    if (!p) throw notFound();
    if (p.status !== "active" && signed > 0) throw new HttpError(409, "product_inactive", "Produto inativo");
    throw new HttpError(409, "insufficient_stock", "Estoque insuficiente");
  }
  await c.env.DB.batch([
    auditStmt(c.env.DB, { orgId: org.id, actorUserId: user.id, action: "stock.moved", entity: "stock_movement", entityId: mid, details: { kind: b.kind, qty: signed, productId: b.productId, unitId: b.unitId }, now }),
  ]);
  return c.json({ id: mid, replayed: false }, 201);
});

stockRoutes.get("/stock/levels", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, z.object({ unitId: id }));
  requirePerm(org, "stock.read", q.unitId);
  await requireUnit(c.env.DB, org.id, q.unitId);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id AS product_id, p.name, p.sku, p.min_stock, p.status,
            COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.organization_id = p.organization_id AND m.unit_id = ? AND m.product_id = p.id), 0) AS qty
       FROM products p WHERE p.organization_id = ? ORDER BY p.name`,
  ).bind(q.unitId, org.id).all<{ qty: number; min_stock: number }>();
  return c.json({ levels: results.map((r) => ({ ...r, low: r.qty <= r.min_stock })) });
});

stockRoutes.get("/stock/movements", async (c) => {
  const org = c.get("org");
  const q = parseQuery(c, z.object({ unitId: id.optional(), productId: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const sc = unitScope(org, "stock.read", q.unitId);
  const prod = q.productId ? " AND product_id = ?" : "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, unit_id, product_id, kind, qty, unit_price_cents, note, created_at FROM stock_movements WHERE organization_id = ?${sc.sql}${prod} ORDER BY created_at DESC LIMIT ?`,
  ).bind(org.id, ...sc.binds, ...(q.productId ? [q.productId] : []), q.limit).all();
  return c.json({ movements: results });
});
