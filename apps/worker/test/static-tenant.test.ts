import { describe, expect, it } from "vitest";

/**
 * Varredura estática: toda SQL que toca tabela de dados de cliente (tenant) deve mencionar
 * organization_id, ou estar marcada com `tenant-ok` e justificativa na mesma linha.
 * É uma rede de proteção contra esquecer o filtro de tenant; NÃO substitui os testes de isolamento.
 */
const files = (import.meta as unknown as { glob: (p: string, o: object) => unknown }).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// tabelas de escopo do usuário/global (não pertencem a uma organização)
const NON_TENANT = new Set(["users", "organizations", "notifications", "customer_accounts"]);
const TENANT = [
  "units", "memberships", "professionals", "professional_units", "services", "professional_services", "schedules", "time_blocks",
  "customers", "customer_consents", "appointments", "appointment_items", "appointment_slots", "appointment_history", "payments", "audit_logs",
  "expenses", "commission_rules", "commission_entries", "cash_sessions", "products", "stock_movements", "loyalty_ledger", "outbox",
  "chat_threads", "chat_messages", "campaigns",
];

interface Stmt { file: string; line: number; sql: string; lineText: string }

function extract(file: string, src: string): Stmt[] {
  const out: Stmt[] = [];
  const re = /`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const sql = (m[1] ?? m[2] ?? "").trim();
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) continue;
    const end = m.index + m[0].length;
    const line = src.slice(0, m.index).split("\n").length;
    const lineEnd = src.indexOf("\n", end);
    out.push({ file, line, sql, lineText: src.slice(end, lineEnd === -1 ? undefined : lineEnd) });
  }
  return out;
}

const statements = Object.entries(files).flatMap(([f, s]) => extract(f, s));

describe("varredura estática de SQL (tenant)", () => {
  it("encontra SQLs para analisar (guarda contra varredura vazia)", () => {
    expect(statements.length).toBeGreaterThan(80);
  });

  it("toda SQL em tabela de tenant filtra/define organization_id ou tem `tenant-ok` justificado", () => {
    const bad: string[] = [];
    for (const s of statements) {
      const tables = [...s.sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)/gi)].map((x) => (x[1] as string).toLowerCase());
      const touchesTenant = tables.some((t) => TENANT.includes(t) && !NON_TENANT.has(t));
      if (!touchesTenant) continue;
      if (/organization_id/i.test(s.sql)) continue;
      if (/tenant-ok:/.test(s.lineText) || /tenant-ok:/.test(s.sql)) continue;
      bad.push(`${s.file.replace("../", "")}:${s.line}  ${s.sql.replace(/\s+/g, " ").slice(0, 110)}`);
    }
    expect(bad, `SQL sem organization_id:\n${bad.join("\n")}`).toEqual([]);
  });

  it("nenhum `tenant-ok` sem justificativa (precisa de texto depois de 'tenant-ok:')", () => {
    const bare: string[] = [];
    for (const [f, src] of Object.entries(files)) {
      src.split("\n").forEach((l, i) => {
        if (/tenant-ok(?!:\s*\S)/.test(l)) bare.push(`${f}:${i + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it("nenhuma SQL concatena variáveis de entrada (somente ${...} de listas de placeholders/colunas fixas)", () => {
    const risky: string[] = [];
    for (const s of statements) {
      for (const m of s.sql.matchAll(/\$\{([^}]*)\}/g)) {
        const expr = (m[1] as string).trim();
        // permitido: placeholders "?" gerados, listas montadas no código a partir de colunas fixas, filtros internos
        if (/\.map\(\(\) => "\?"\)\.join/.test(expr)) continue;
        if (/^(where|set|unitFilter|unitFilter\.replaceAll\(.*\)|scope|entries\.map.*|values|marks)\b/.test(expr)) continue;
        // Fase 2: fragmentos auditados — unitScope() só emite colunas fixas + placeholders; os demais são literais do código.
        if (/^(sc\.sql|sp\.sql|EXPECTED_SQL|EXP_COLS|conflict|prod|COLS|a\.from)$/.test(expr)) continue;
        if (/^(where\.join|scope\.join|entries\.map|ids\.map|readUnits\.map|ownUnits\.map|allowed\.map)/.test(expr)) continue;
        risky.push(`${s.file}:${s.line} \${${expr}}`);
      }
    }
    expect(risky, risky.join("\n")).toEqual([]);
  });
});
