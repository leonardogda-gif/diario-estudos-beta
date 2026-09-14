-- Diário de Estudos v11.6 — lista de e-mails autorizados
-- Execute uma única vez antes de publicar o Worker 0.44-beta.

CREATE TABLE IF NOT EXISTS allowed_signups (
  email TEXT PRIMARY KEY,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_allowed_signups_created_at
ON allowed_signups(created_at DESC);
