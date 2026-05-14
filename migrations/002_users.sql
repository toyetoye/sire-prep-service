-- 002_users.sql — adds individual user accounts on top of the existing
-- per-vessel shared password auth. Crew on board can still log in with the
-- vessel password (frictionless). Office staff and superintendents log in
-- with their own email + password.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS sire.users (
  id              SERIAL PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'crew' CHECK (role IN ('superintendent','master','crew')),
  vessel_scope    TEXT,           -- NULL = all vessels (for super); else specific vessel
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by_user_id INT REFERENCES sire.users(id) ON DELETE SET NULL,
  last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON sire.users(email);
CREATE INDEX IF NOT EXISTS idx_users_role  ON sire.users(role);

-- Add user_id column to activity_log so we can trace edits back to a real
-- account (vs just a typed display name). Backward compatible: NULL means the
-- edit came from a crew shared-password session.
ALTER TABLE sire.activity_log
  ADD COLUMN IF NOT EXISTS user_id INT REFERENCES sire.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_log_user ON sire.activity_log(user_id, created_at DESC);
