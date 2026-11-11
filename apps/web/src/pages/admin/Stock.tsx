import { useCallback, useEffect, useState } from "react";
import { formatBRL } from "@naregua/shared";
import { Button, Card, Field, Input, Notice, Select, Spinner, useAsync } from "../../components/ui";
import { api, errMsg, newIdemKey } from "../../lib/api";
import { parseBRLToCents } from "../../lib/money";
import { orgPath, useAdmin } from "./ctx";

interface Level { product_id: string; name: string; sku: string | null; min_stock: number; status: string; qty: number; low: boolean }
interface Product { id: string; name: string; sku: string | null; price_cents: number; cost_cents: number; min_stock: number; status: string }
const KIND_PT: Record<string, string> = { purchase: "Compra (entrada)", sale: "Venda (saída)", loss: "Perda (saída)", adjustment: "Ajuste (±)" };

export function Stock() {
  const { orgId, units, can } = useAdmin();
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [mv, setMv] = useState({ productId: "", kind: "purchase", qty: "1" });
  const [np, setNp] = useState({ name: "", sku: "", price: "", cost: "", min: "0" });
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(async () => {
    try {
      const [l, p] = await Promise.all([api<{ levels: Level[] }>(orgPath(orgId, `/stock/levels?unitId=${unitId}`), { auth: true }), api<{ products: Product[] }>(orgPath(orgId, "/products"), { auth: true })]);
      setLevels(l.levels); setProducts(p.products); setMv((m) => ({ ...m, productId: m.productId || p.products[0]?.id || "" }));
    } catch (e) { setError(errMsg(e)); }
  }, [orgId, unitId, setError]);
  useEffect(() => { setLevels(null); void load(); }, [load]);
  if (!can("stock.read")) return <Notice>Seu papel não inclui o estoque.</Notice>;
  const qty = Number(mv.qty);
  const price = parseBRLToCents(np.price);
  return (
    <div className="space-y-4">
      {units.length > 1 && <Field label="Unidade"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>}
      {error && <Notice kind="error">{error}</Notice>}
      <Card className="space-y-2">
        <h2 className="text-lg font-semibold">Saldo</h2>
        {!levels ? <Spinner /> : levels.length === 0 ? <Notice>Nenhum produto cadastrado.</Notice> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-mute"><th>Produto</th><th className="text-right">Saldo</th><th className="text-right">Mínimo</th></tr></thead>
            <tbody>{levels.map((l) => <tr key={l.product_id} className={l.status !== "active" ? "opacity-50" : ""}><td>{l.name}{l.sku ? ` (${l.sku})` : ""}{l.low && <span className="ml-2 rounded bg-amber px-1.5 text-xs font-semibold text-ink">baixo</span>}</td><td className="text-right">{l.qty}</td><td className="text-right">{l.min_stock}</td></tr>)}</tbody></table>
        )}
      </Card>
      {can("stock.write") && products.length > 0 && (
        <Card className="space-y-2">
          <h2 className="text-lg font-semibold">Movimentar</h2>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Produto"><Select value={mv.productId} onChange={(e) => setMv({ ...mv, productId: e.target.value })}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Tipo"><Select value={mv.kind} onChange={(e) => setMv({ ...mv, kind: e.target.value })}>{Object.entries(KIND_PT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Quantidade"><Input inputMode="numeric" value={mv.qty} onChange={(e) => setMv({ ...mv, qty: e.target.value })} /></Field>
            <div className="flex items-end"><Button disabled={busy || !mv.productId || !Number.isInteger(qty) || qty === 0 || (mv.kind !== "adjustment" && qty < 0)} onClick={async () => { if (await run(() => api(orgPath(orgId, "/stock/movements"), { method: "POST", auth: true, headers: { "Idempotency-Key": newIdemKey() }, body: { unitId, productId: mv.productId, kind: mv.kind, qty } }))) await load(); }}>Registrar</Button></div>
          </div>
          <p className="text-xs text-mute">O saldo nunca fica negativo. Lançamentos não são editados: corrija com um ajuste.</p>
        </Card>
      )}
      {can("org.manage") && (
        <Card className="space-y-2">
          <h2 className="text-lg font-semibold">Novo produto</h2>
          <div className="grid gap-2 sm:grid-cols-5">
            <Field label="Nome"><Input value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} /></Field>
            <Field label="SKU"><Input value={np.sku} onChange={(e) => setNp({ ...np, sku: e.target.value })} /></Field>
            <Field label="Preço (R$)"><Input inputMode="decimal" value={np.price} onChange={(e) => setNp({ ...np, price: e.target.value })} /></Field>
            <Field label="Custo (R$)"><Input inputMode="decimal" value={np.cost} onChange={(e) => setNp({ ...np, cost: e.target.value })} /></Field>
            <Field label="Estoque mínimo"><Input inputMode="numeric" value={np.min} onChange={(e) => setNp({ ...np, min: e.target.value })} /></Field>
          </div>
          <Button disabled={busy || np.name.trim().length < 2 || price === null || (np.cost !== "" && parseBRLToCents(np.cost) === null)} onClick={async () => { if (price === null) return; if (await run(() => api(orgPath(orgId, "/products"), { method: "POST", auth: true, body: { name: np.name.trim(), sku: np.sku.trim() || null, priceCents: price, costCents: parseBRLToCents(np.cost) ?? 0, minStock: Math.max(0, Math.floor(Number(np.min) || 0)) } }))) { setNp({ name: "", sku: "", price: "", cost: "", min: "0" }); await load(); } }}>Cadastrar</Button>
          {products.length > 0 && <p className="text-xs text-mute">Preços: {products.map((p) => `${p.name} ${formatBRL(p.price_cents)}`).join(" · ")}</p>}
        </Card>
      )}
    </div>
  );
}
