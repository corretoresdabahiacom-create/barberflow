-- NaRégua — migration 0001: núcleo da Fase 1.
-- Isolamento multiempresa: toda tabela tenant-owned tem organization_id e chaves
-- estrangeiras COMPOSTAS (organization_id, id) para impedir referência entre organizações.
-- D1 não tem RLS: o Worker é o único caminho de acesso ao banco (ver docs/ISOLATION.md).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  firebase_uid TEXT NOT NULL UNIQUE,
  email TEXT,
  email_norm TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  sessions_valid_after INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_email_norm ON users(email_norm);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 60),
  address TEXT,
  phone TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  auto_confirm INTEGER NOT NULL DEFAULT 1 CHECK (auto_confirm IN (0,1)),
  min_notice_min INTEGER NOT NULL DEFAULT 60 CHECK (min_notice_min BETWEEN 0 AND 10080),
  max_days_ahead INTEGER NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
  slot_step_min INTEGER NOT NULL DEFAULT 15 CHECK (slot_step_min IN (5,10,15,20,30,60)),
  cancel_window_min INTEGER NOT NULL DEFAULT 120 CHECK (cancel_window_min BETWEEN 0 AND 10080),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_units_org ON units(organization_id);

-- O slug alimenta o QR Code e a página pública: imutável depois de criado.
CREATE TRIGGER units_slug_immutable BEFORE UPDATE OF slug ON units
WHEN OLD.slug <> NEW.slug
BEGIN
  SELECT RAISE(ABORT, 'slug_immutable');
END;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  unit_id TEXT,
  user_id TEXT REFERENCES users(id),
  invited_email TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','unit_admin','manager','barber')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  can_receive_payments INTEGER NOT NULL DEFAULT 0 CHECK (can_receive_payments IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL),
  CHECK ((role = 'owner' AND unit_id IS NULL) OR (role <> 'owner' AND unit_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_membership_user
  ON memberships(organization_id, user_id, IFNULL(unit_id, '')) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_membership_invite
  ON memberships(organization_id, invited_email, IFNULL(unit_id, ''))
  WHERE invited_email IS NOT NULL AND user_id IS NULL;
CREATE INDEX idx_memberships_user ON memberships(user_id, status);
CREATE INDEX idx_memberships_invited ON memberships(invited_email) WHERE user_id IS NULL;

CREATE TABLE professionals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  bio TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_professionals_org ON professionals(organization_id, status);
CREATE INDEX idx_professionals_user ON professionals(user_id);

CREATE TABLE professional_units (
  organization_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  PRIMARY KEY (professional_id, unit_id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description TEXT,
  category TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0 AND price_cents <= 100000000),
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240 AND duration_min % 5 = 0),
  buffer_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 60 AND buffer_min % 5 = 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_services_org ON services(organization_id, status);

CREATE TABLE professional_services (
  organization_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  duration_min INTEGER CHECK (duration_min IS NULL OR (duration_min BETWEEN 5 AND 240 AND duration_min % 5 = 0)),
  PRIMARY KEY (professional_id, service_id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (start_min < end_min),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);
CREATE INDEX idx_schedules_pro ON schedules(professional_id, weekday);

CREATE TABLE time_blocks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'block' CHECK (kind IN ('block','dayoff')),
  reason TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK (starts_at < ends_at),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id)
);
CREATE INDEX idx_blocks_pro ON time_blocks(professional_id, starts_at);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  phone TEXT,
  phone_norm TEXT,
  email TEXT,
  email_norm TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','anonymized')),
  no_show_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_customers_phone ON customers(organization_id, phone_norm);
CREATE INDEX idx_customers_email ON customers(organization_id, email_norm);
CREATE INDEX idx_customers_name ON customers(organization_id, name);

-- Vínculo VERIFICADO entre cliente da barbearia e identidade de login.
-- Nunca criado apenas com telefone digitado.
CREATE TABLE customer_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('verified_email','authenticated_booking')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, customer_id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id)
);
CREATE INDEX idx_customer_accounts_user ON customer_accounts(user_id);

CREATE TABLE customer_consents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('service_notifications','marketing')),
  channel TEXT NOT NULL CHECK (channel IN ('email','push','whatsapp','sms')),
  granted INTEGER NOT NULL CHECK (granted IN (0,1)),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id)
);
CREATE INDEX idx_consents_customer ON customer_consents(organization_id, customer_id, purpose, channel, created_at);
CREATE TRIGGER consents_no_update BEFORE UPDATE ON customer_consents BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER consents_no_delete BEFORE DELETE ON customer_consents BEGIN SELECT RAISE(ABORT, 'append_only'); END;

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  source TEXT NOT NULL CHECK (source IN ('public','portal','admin')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  notes TEXT,
  cancel_token_hash TEXT,
  cancelled_by TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer','staff')),
  cancelled_by_user_id TEXT,
  cancel_reason TEXT,
  cancelled_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at < ends_at),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id)
);
CREATE INDEX idx_appt_org_start ON appointments(organization_id, starts_at);
CREATE INDEX idx_appt_unit_start ON appointments(organization_id, unit_id, starts_at);
CREATE INDEX idx_appt_pro_start ON appointments(professional_id, starts_at);
CREATE INDEX idx_appt_customer ON appointments(organization_id, customer_id, starts_at);

-- Preço e duração são COPIADOS do serviço no momento da reserva (histórico imutável).
CREATE TABLE appointment_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id)
);
CREATE INDEX idx_items_appt ON appointment_items(appointment_id);

-- Anti-conflito de agenda: cada bloco de 5 minutos ocupado vira uma linha.
-- A chave primária (profissional, bloco) faz o banco recusar dupla reserva,
-- e o D1 serializa as escritas. Substitui o EXCLUDE USING gist do PostgreSQL.
CREATE TABLE appointment_slots (
  professional_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  PRIMARY KEY (professional_id, slot),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_slots_appt ON appointment_slots(appointment_id);

CREATE TABLE appointment_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('staff','customer','system')),
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id)
);
CREATE INDEX idx_history_appt ON appointment_history(appointment_id, created_at);
CREATE TRIGGER history_no_update BEFORE UPDATE ON appointment_history BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON appointment_history BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- Pagamento MANUAL registrado pela equipe (Fase 1). Não confirma Pix/cartão automaticamente.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','pix','debit','credit','other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  note TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id)
);
CREATE INDEX idx_payments_org ON payments(organization_id, received_at);
CREATE INDEX idx_payments_appt ON payments(organization_id, appointment_id);
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'append_only'); END;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_org ON audit_logs(organization_id, created_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'append_only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'append_only'); END;
