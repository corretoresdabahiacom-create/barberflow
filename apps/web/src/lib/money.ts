/** "12,50" / "12.50" / "1.234,56" → centavos inteiros; null se inválido. */
export function parseBRLToCents(input: string): number | null {
  const s = input.trim().replace(/^R\$\s*/, "");
  if (!s) return null;
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
