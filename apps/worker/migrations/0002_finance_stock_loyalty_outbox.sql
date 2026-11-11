-- Fase 2: financeiro (despesas, comissões, caixa), estoque, fidelidade e fila de e-mails (outbox).
-- Dinheiro em centavos inteiros. Lançamentos são append-only: correção = novo lançamento (estorno).

ALTER TABLE organizations ADD COLUMN loyalty_points_per_real INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_per_real BETWEEN 0 AND 100);
ALTER TABLE organizations ADD COLUMN reminders_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminders_enabled IN (0,1));

-- ---------- Despesas ----------
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (length(category) BETWEEN 2 AND 40),
  description TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_with TEXT NOT NULL CHECK (paid_with IN ('cash','other')),
  reverses_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, reverses_id) REFERENCES expenses(organization_id, id)
);
CREATE UNIQUE INDEX ux_expense_reversal ON expenses(organization_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX idx_expenses_unit ON expenses(organization_id, unit_id, created_at);
CREATE TRIGGER expenses_no_update BEFORE UPDATE ON expenses BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- ---------- Comissões ----------
CREATE TABLE commission_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  service_id TEXT,                       -- NULL = regra padrão do profissional
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),  -- pontos-base: 5000 = 50%
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);
CREATE UNIQUE INDEX ux_rule_service ON commission_rules(organization_id, professional_id, service_id) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX ux_rule_default ON commission_rules(organization_id, professional_id) WHERE service_id IS NULL;

-- Comissão "congelada" no momento da conclusão: mudar a regra depois não reescreve o passado.
CREATE TABLE commission_entries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  base_cents INTEGER NOT NULL CHECK (base_cents >= 0),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, appointment_id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id)
);
CREATE INDEX idx_commission_pro ON commission_entries(organization_id, professional_id, created_at);
CREATE TRIGGER commission_no_update BEFORE UPDATE ON commission_entries BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER commission_no_delete BEFORE DELETE ON commission_entries BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- ---------- Caixa ----------
CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  opening_cents INTEGER NOT NULL CHECK (opening_cents >= 0),
  opened_by_user_id TEXT NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by_user_id TEXT REFERENCES users(id),
  counted_cents INTEGER,
  expected_cents INTEGER,
  difference_cents INTEGER,
  note TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);
-- no máximo um caixa aberto por unidade
CREATE UNIQUE INDEX ux_cash_open ON cash_sessions(organization_id, unit_id) WHERE closed_at IS NULL;
-- depois de fechado, imutável
CREATE TRIGGER cash_closed_no_update BEFORE UPDATE ON cash_sessions WHEN OLD.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER cash_no_delete BEFORE DELETE ON cash_sessions BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- ---------- Estoque ----------
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  sku TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX ux_product_sku ON products(organization_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','adjustment','loss')),
  qty INTEGER NOT NULL CHECK (qty <> 0),
  unit_price_cents INTEGER,
  note TEXT,
  idempotency_key TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'purchase' AND qty > 0) OR (kind IN ('sale','loss') AND qty < 0) OR kind = 'adjustment'),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id)
);
CREATE INDEX idx_stock_level ON stock_movements(organization_id, unit_id, product_id);
CREATE TRIGGER stock_no_update BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER stock_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- ---------- Fidelidade ----------
CREATE TABLE loyalty_ledger (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  appointment_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('earn','redeem','adjust')),
  points INTEGER NOT NULL CHECK (points <> 0),
  note TEXT,
  idempotency_key TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'earn' AND points > 0) OR (kind = 'redeem' AND points < 0) OR kind = 'adjust'),
  UNIQUE (organization_id, appointment_id, kind),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id)
);
CREATE INDEX idx_loyalty_customer ON loyalty_ledger(organization_id, customer_id);
CREATE TRIGGER loyalty_no_update BEFORE UPDATE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER loyalty_no_delete BEFORE DELETE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- ---------- Outbox de e-mails (lembretes) ----------
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT,
  appointment_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reminder')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
