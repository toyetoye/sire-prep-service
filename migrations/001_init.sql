-- SIRE Prep Service — schema init
-- Creates an isolated `sire` schema in the shared FORCAP/MARIDE database.
-- Does not touch any existing schemas (eom, budget, fuel, maride, rag).
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS sire;

-- =====================================================================
-- Layer 1: canonical OCIMF question library (413 questions, immutable)
-- Vessel-agnostic. One copy shared across all vessels in the fleet.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.questions (
  question_id     TEXT PRIMARY KEY,
  chapter         TEXT NOT NULL,
  section         TEXT NOT NULL,
  short_question  TEXT,
  question_text   TEXT,
  vessel_types    TEXT,
  roviq_sequence  TEXT,
  objective       TEXT,
  inspection_guidance TEXT,
  suggested_inspector_actions TEXT,
  expected_evidence TEXT,
  negative_observation_grounds TEXT,
  source          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_q_chapter ON sire.questions(chapter);
CREATE INDEX IF NOT EXISTS idx_q_section ON sire.questions(section);

-- =====================================================================
-- Layer 2: vessel walkdowns (per-vessel, mutable)
-- Each vessel gets its own copy so refinements don't leak across vessels.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.walkdowns (
  walkdown_id     TEXT NOT NULL,
  vessel          TEXT NOT NULL,
  question_id     TEXT NOT NULL REFERENCES sire.questions(question_id),
  chapter         TEXT,
  section         TEXT,
  topic           TEXT,
  evidence_item   TEXT,
  detailed_criteria TEXT,
  check_type      TEXT,
  location        TEXT,
  roviq_sequence  TEXT,
  responsible_role TEXT,
  backup_role     TEXT,
  needs_manual_upgrade BOOLEAN DEFAULT FALSE,
  phase           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vessel, walkdown_id)
);

CREATE INDEX IF NOT EXISTS idx_w_vessel ON sire.walkdowns(vessel);
CREATE INDEX IF NOT EXISTS idx_w_chapter ON sire.walkdowns(vessel, chapter);
CREATE INDEX IF NOT EXISTS idx_w_section ON sire.walkdowns(vessel, section);
CREATE INDEX IF NOT EXISTS idx_w_phase ON sire.walkdowns(vessel, phase);
CREATE INDEX IF NOT EXISTS idx_w_qid ON sire.walkdowns(question_id);

-- =====================================================================
-- Sub-check definitions (the atomic checkbox items inside each walkdown)
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.subchecks (
  vessel          TEXT NOT NULL,
  walkdown_id     TEXT NOT NULL,
  subcheck_id     TEXT NOT NULL,
  ordinal         INT  NOT NULL,
  text            TEXT NOT NULL,
  PRIMARY KEY (vessel, walkdown_id, subcheck_id),
  FOREIGN KEY (vessel, walkdown_id) REFERENCES sire.walkdowns(vessel, walkdown_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sc_walkdown ON sire.subchecks(vessel, walkdown_id);

-- =====================================================================
-- State: walkdown-level overrides (severity, statusOverride, notes, resp)
-- One row per (vessel, walkdown_id). Mutable; tracks last editor.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.walkdown_state (
  vessel              TEXT NOT NULL,
  walkdown_id         TEXT NOT NULL,
  status_override     TEXT,   -- NULL means auto-derive from sub-checks; 'BLOCKED' or 'N/A' to override
  severity            TEXT,   -- 'CRITICAL' | 'MAJOR' | 'MINOR' | NULL
  responsible_override TEXT,
  notes               TEXT,
  updated_by          TEXT,
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vessel, walkdown_id),
  FOREIGN KEY (vessel, walkdown_id) REFERENCES sire.walkdowns(vessel, walkdown_id) ON DELETE CASCADE
);

-- =====================================================================
-- State: per sub-check checkbox state + per-check note
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.subcheck_state (
  vessel       TEXT NOT NULL,
  walkdown_id  TEXT NOT NULL,
  subcheck_id  TEXT NOT NULL,
  checked      BOOLEAN DEFAULT FALSE,
  note         TEXT,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (vessel, walkdown_id, subcheck_id),
  FOREIGN KEY (vessel, walkdown_id, subcheck_id) REFERENCES sire.subchecks(vessel, walkdown_id, subcheck_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scs_walkdown ON sire.subcheck_state(vessel, walkdown_id);
CREATE INDEX IF NOT EXISTS idx_scs_updated ON sire.subcheck_state(vessel, updated_at DESC);

-- =====================================================================
-- Inspection targets per vessel (date, port, inspector)
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.inspection_targets (
  vessel          TEXT PRIMARY KEY,
  target_date     DATE,
  inspector_name  TEXT,
  port            TEXT,
  cargo           TEXT,
  notes           TEXT,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================================
-- Vessel auth: shared password per vessel (bcrypt hashed)
-- Master sets this. Crew uses it to log in alongside their name.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.vessel_auth (
  vessel        TEXT PRIMARY KEY,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================================
-- Activity log (lightweight audit trail)
-- =====================================================================
CREATE TABLE IF NOT EXISTS sire.activity_log (
  id          BIGSERIAL PRIMARY KEY,
  vessel      TEXT NOT NULL,
  actor       TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,  -- 'walkdown' | 'subcheck' | 'inspection_target'
  target_id   TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_log_vessel_time ON sire.activity_log(vessel, created_at DESC);
