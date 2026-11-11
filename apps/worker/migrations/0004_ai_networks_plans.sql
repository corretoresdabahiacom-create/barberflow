-- Fase 4: IA assistiva (opt-in, com cota), redes/franquias (consentimento explícito) e planos editáveis.

-- ---------- IA: ligada por organização somente pelo proprietário; cota diária própria ----------
CREATE TABLE ai_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  daily_quota INTEGER NOT NULL DEFAULT 20 CHECK (daily_quota BETWEEN 0 AND 1000),
  updated_by_user_id TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Registro de uso: NUNCA guarda o texto enviado nem o recebido, só metadados.
-- `reserved` conta para a cota (reserva atômica antes da chamada); falhas viram `error` e não contam.
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  feature TEXT NOT NULL CHECK (feature IN ('campaign_copy','service_description','insights')),
  provider TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved','ok','error')),
  day TEXT NOT NULL, -- AAAA-MM-DD em UTC
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_usage_day ON ai_usage(organization_id, day, status);

-- ---------- Planos: tudo editável pelo administrador da plataforma (sem preço fixo no código) ----------
CREATE TABLE plans (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9_-]*' AND length(id) BETWEEN 2 AND 30),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0), -- NULL = preço "a definir"
  max_units INTEGER CHECK (max_units IS NULL OR max_units >= 1),                -- NULL = ilimitado
  max_professionals INTEGER CHECK (max_professionals IS NULL OR max_professionals >= 1),
  ai_daily_quota INTEGER NOT NULL DEFAULT 0 CHECK (ai_daily_quota BETWEEN 0 AND 1000),
  allow_network INTEGER NOT NULL DEFAULT 0 CHECK (allow_network IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
-- Valores iniciais são PLACEHOLDERS de produto (não são decisão comercial): ajuste pelo painel da plataforma.
INSERT INTO plans (id, name, price_cents, max_units, max_professionals, ai_daily_quota, allow_network, active, sort, updated_at) VALUES
  ('free', 'Gratuito', 0,    2,    5,    10,  0, 1, 1, '2026-11-01T00:00:00Z'),
  ('pro',  'Profissional', NULL, 5, 20,  50,  0, 1, 2, '2026-11-01T00:00:00Z'),
  ('rede', 'Rede',     NULL, NULL, NULL, 200, 1, 1, 3, '2026-11-01T00:00:00Z');

-- Assinatura manual (sem gateway de pagamento). Sem linha = plano `free`. Vencida/suspensa = limites do `free`.
CREATE TABLE org_subscriptions (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  valid_until TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  updated_by_user_id TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- ---------- Redes / franquias: só números agregados cruzam organizações, e só após consentimento ----------
CREATE TABLE networks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  admin_organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL
);

-- Uma organização participa de no máximo uma rede. `consented_by_user_id`/`consented_at` = registro do aceite.
CREATE TABLE network_members (
  network_id TEXT NOT NULL REFERENCES networks(id),
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  consented_by_user_id TEXT NOT NULL REFERENCES users(id),
  consented_at TEXT NOT NULL,
  PRIMARY KEY (network_id, organization_id)
);

-- Convite de uso único, guardado só como hash; expira.
CREATE TABLE network_invites (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_organization_id TEXT REFERENCES organizations(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_network_invites_network ON network_invites(network_id, created_at);
