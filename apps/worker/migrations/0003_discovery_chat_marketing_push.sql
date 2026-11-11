-- Fase 3: vitrine pública (opt-in), chat cliente↔barbearia, campanhas de marketing e Web Push.

-- ---------- Vitrine: a unidade só aparece na listagem pública se o proprietário/admin ligar `listed` ----------
ALTER TABLE units ADD COLUMN city TEXT;
ALTER TABLE units ADD COLUMN state TEXT CHECK (state IS NULL OR length(state) = 2);
ALTER TABLE units ADD COLUMN description TEXT;
ALTER TABLE units ADD COLUMN listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0,1));
CREATE INDEX idx_units_listed ON units(state, city) WHERE listed = 1;

-- ---------- Chat (uma conversa por cliente × unidade). Mensagens não são editáveis; podem ser apagadas na anonimização LGPD ----------
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked')),
  customer_unread INTEGER NOT NULL DEFAULT 0,
  staff_unread INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, unit_id, customer_id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers(organization_id, id)
);
CREATE INDEX idx_chat_threads_unit ON chat_threads(organization_id, unit_id, last_message_at);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('customer','staff')),
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, thread_id) REFERENCES chat_threads(organization_id, id)
);
CREATE INDEX idx_chat_messages_thread ON chat_messages(organization_id, thread_id, created_at);
CREATE TRIGGER chat_messages_no_update BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(ABORT, 'append_only'); END;

-- ---------- Campanhas (marketing). Só chega a quem deu consentimento de marketing por e-mail e não revogou ----------
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 2 AND 150),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 2 AND 5000),
  segment TEXT NOT NULL CHECK (segment IN ('all_consented','inactive')),
  inactive_days INTEGER CHECK (inactive_days IS NULL OR inactive_days BETWEEN 7 AND 730),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  recipients_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (organization_id, id)
);

-- ---------- Outbox: passa a aceitar campanhas (recriada porque o CHECK de `kind` não pode ser alterado) ----------
CREATE TABLE outbox_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT,
  appointment_id TEXT,
  campaign_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reminder','campaign')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  unsubscribe_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
INSERT INTO outbox_new (id, organization_id, customer_id, appointment_id, kind, to_email, subject, body, status, attempts, next_attempt_at, dedupe_key, last_error, created_at, sent_at)
  SELECT id, organization_id, customer_id, appointment_id, kind, to_email, subject, body, status, attempts, next_attempt_at, dedupe_key, last_error, created_at, sent_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_org ON outbox(organization_id, created_at);

-- ---------- Web Push (assinaturas por usuário/aparelho) ----------
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
