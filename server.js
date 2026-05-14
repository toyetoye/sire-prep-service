// server.js — SIRE Prep Service main entry point.
// Express + PostgreSQL. Serves /public as the SPA and /api/* as JSON endpoints.

const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();

// =========================================================
// Database
// =========================================================
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('FATAL: DATABASE_URL not set');
  process.exit(1);
}
const pool = new Pool({
  connectionString: url,
  ssl: /sslmode=require/.test(url) || /\.railway\.app/.test(url) || /\.proxy\.rlwy\.net/.test(url)
       ? { rejectUnauthorized: false }
       : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', err => console.error('Postgres pool error:', err));

// =========================================================
// Middleware
// =========================================================
app.set('trust proxy', 1); // honour x-forwarded-* from Railway proxy
app.use(express.json({ limit: '2mb' }));
app.use(cookieSession({
  name: 'sire_session',
  secret: process.env.SESSION_SECRET || 'change-me-please-change-me',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
}));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.vessel || !req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

function logActivity(vessel, actor, action, targetType, targetId, details) {
  pool.query(
    `INSERT INTO sire.activity_log (vessel, actor, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [vessel, actor, action, targetType, targetId, details ? JSON.stringify(details) : null]
  ).catch(err => console.error('activity_log insert failed:', err.message));
}

// =========================================================
// Auth routes
// =========================================================
app.get('/api/auth/vessels', async (req, res) => {
  const { rows } = await pool.query('SELECT vessel, display_name FROM sire.vessel_auth ORDER BY vessel');
  res.json(rows);
});

app.post('/api/auth/login', async (req, res) => {
  const { vessel, password, displayName } = req.body || {};
  if (!vessel || !password || !displayName) {
    return res.status(400).json({ error: 'missing_fields', detail: 'vessel, password and displayName required' });
  }
  const { rows } = await pool.query(
    'SELECT password_hash, display_name FROM sire.vessel_auth WHERE vessel = $1',
    [vessel]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: 'unknown_vessel' });
  }
  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'bad_password' });
  }
  req.session.vessel = vessel;
  req.session.user = displayName.substring(0, 80);
  logActivity(vessel, req.session.user, 'login');
  res.json({ ok: true, vessel, vesselName: rows[0].display_name, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.vessel) return res.json({ authenticated: false });
  res.json({ authenticated: true, vessel: req.session.vessel, user: req.session.user });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'bad_input', detail: 'newPassword must be at least 8 chars' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM sire.vessel_auth WHERE vessel = $1', [req.session.vessel]);
  if (rows.length === 0 || !(await bcrypt.compare(oldPassword, rows[0].password_hash))) {
    return res.status(401).json({ error: 'bad_password' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE sire.vessel_auth SET password_hash = $1 WHERE vessel = $2', [hash, req.session.vessel]);
  logActivity(req.session.vessel, req.session.user, 'password_change');
  res.json({ ok: true });
});

// =========================================================
// Data routes — questions, walkdowns, state
// =========================================================

// Layer 1: canonical questions (cached server-side)
let questionsCache = null;
let questionsCacheTime = 0;
async function getQuestions() {
  if (questionsCache && (Date.now() - questionsCacheTime) < 60_000) return questionsCache;
  const { rows } = await pool.query('SELECT * FROM sire.questions ORDER BY chapter::int, section, question_id');
  questionsCache = rows.map(r => ({
    qid: r.question_id, ch: r.chapter, sec: r.section,
    short: r.short_question, qtext: r.question_text,
    types: r.vessel_types, roviq: r.roviq_sequence,
    obj: r.objective, guide: r.inspection_guidance,
    actions: r.suggested_inspector_actions,
    evidence: r.expected_evidence,
    negobs: r.negative_observation_grounds,
  }));
  questionsCacheTime = Date.now();
  return questionsCache;
}

app.get('/api/questions', requireAuth, async (req, res) => {
  try {
    res.json(await getQuestions());
  } catch (err) {
    console.error('GET /api/questions failed:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// Layer 2: walkdowns + sub-checks + state, all for the authed vessel.
// Single round-trip — used on initial page load and on periodic resync.
app.get('/api/walkdowns', requireAuth, async (req, res) => {
  const v = req.session.vessel;
  try {
    const [wdsRes, scsRes, wdStateRes, scStateRes] = await Promise.all([
      pool.query('SELECT * FROM sire.walkdowns WHERE vessel = $1 ORDER BY chapter::int, section, walkdown_id', [v]),
      pool.query('SELECT * FROM sire.subchecks WHERE vessel = $1 ORDER BY walkdown_id, ordinal', [v]),
      pool.query('SELECT * FROM sire.walkdown_state WHERE vessel = $1', [v]),
      pool.query('SELECT * FROM sire.subcheck_state WHERE vessel = $1', [v]),
    ]);

    const wdStateBy = {};
    wdStateRes.rows.forEach(r => { wdStateBy[r.walkdown_id] = r; });
    const scStateBy = {};
    scStateRes.rows.forEach(r => { scStateBy[`${r.walkdown_id}|${r.subcheck_id}`] = r; });
    const scByWd = {};
    scsRes.rows.forEach(r => {
      (scByWd[r.walkdown_id] = scByWd[r.walkdown_id] || []).push(r);
    });

    const result = wdsRes.rows.map(w => {
      const ws = wdStateBy[w.walkdown_id] || {};
      return {
        id: w.walkdown_id,
        qid: w.question_id,
        ch: w.chapter, sec: w.section,
        topic: w.topic, evidence: w.evidence_item, criteria: w.detailed_criteria,
        ctype: w.check_type, loc: w.location, roviq: w.roviq_sequence,
        resp: w.responsible_role, backup: w.backup_role,
        flagged: w.needs_manual_upgrade,
        phase: w.phase,
        statusOverride: ws.status_override || '',
        severity: ws.severity || '',
        respOverride: ws.responsible_override || '',
        notes: ws.notes || '',
        updatedBy: ws.updated_by || '',
        updatedAt: ws.updated_at || null,
        subchecks: (scByWd[w.walkdown_id] || []).map(sc => {
          const ss = scStateBy[`${w.walkdown_id}|${sc.subcheck_id}`] || {};
          return {
            id: sc.subcheck_id,
            text: sc.text,
            checked: !!ss.checked,
            note: ss.note || '',
            updatedBy: ss.updated_by || '',
            updatedAt: ss.updated_at || null,
          };
        }),
      };
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/walkdowns failed:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// Inspection target
app.get('/api/inspection-target', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sire.inspection_targets WHERE vessel = $1', [req.session.vessel]);
  res.json(rows[0] || {});
});

app.patch('/api/inspection-target', requireAuth, async (req, res) => {
  const { target_date, inspector_name, port, cargo, notes } = req.body || {};
  const v = req.session.vessel;
  await pool.query(`
    INSERT INTO sire.inspection_targets (vessel, target_date, inspector_name, port, cargo, notes, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (vessel) DO UPDATE SET
      target_date = EXCLUDED.target_date,
      inspector_name = EXCLUDED.inspector_name,
      port = EXCLUDED.port,
      cargo = EXCLUDED.cargo,
      notes = EXCLUDED.notes,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
  `, [v, target_date || null, inspector_name || null, port || null, cargo || null, notes || null, req.session.user]);
  logActivity(v, req.session.user, 'inspection_target_update', 'inspection_target', v, { target_date, inspector_name, port });
  res.json({ ok: true });
});

// PATCH a walkdown's state (severity, override, notes, resp override)
app.patch('/api/walkdown/:id', requireAuth, async (req, res) => {
  const v = req.session.vessel;
  const id = req.params.id;
  const { statusOverride, severity, respOverride, notes } = req.body || {};
  try {
    await pool.query(`
      INSERT INTO sire.walkdown_state (vessel, walkdown_id, status_override, severity, responsible_override, notes, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (vessel, walkdown_id) DO UPDATE SET
        status_override = EXCLUDED.status_override,
        severity = EXCLUDED.severity,
        responsible_override = EXCLUDED.responsible_override,
        notes = EXCLUDED.notes,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `, [v, id, statusOverride || null, severity || null, respOverride || null, notes || null, req.session.user]);
    logActivity(v, req.session.user, 'walkdown_update', 'walkdown', id, { statusOverride, severity, respOverride });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/walkdown failed:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// PATCH a sub-check (toggle + optional note)
app.patch('/api/walkdown/:id/subcheck/:scid', requireAuth, async (req, res) => {
  const v = req.session.vessel;
  const id = req.params.id;
  const scid = req.params.scid;
  const { checked, note } = req.body || {};
  try {
    await pool.query(`
      INSERT INTO sire.subcheck_state (vessel, walkdown_id, subcheck_id, checked, note, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (vessel, walkdown_id, subcheck_id) DO UPDATE SET
        checked = EXCLUDED.checked,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `, [v, id, scid, !!checked, note || null, req.session.user]);
    logActivity(v, req.session.user, 'subcheck_update', 'subcheck', `${id}/${scid}`, { checked, note });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/walkdown/.../subcheck failed:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// Lightweight sync endpoint: returns last-update timestamps so client can decide to refetch.
// Cheaper than fetching the full walkdowns list every 10s.
app.get('/api/sync-stamp', requireAuth, async (req, res) => {
  const v = req.session.vessel;
  const [wd, sc, target] = await Promise.all([
    pool.query('SELECT MAX(updated_at) AS m FROM sire.walkdown_state WHERE vessel = $1', [v]),
    pool.query('SELECT MAX(updated_at) AS m FROM sire.subcheck_state WHERE vessel = $1', [v]),
    pool.query('SELECT updated_at FROM sire.inspection_targets WHERE vessel = $1', [v]),
  ]);
  res.json({
    walkdownStateMax: wd.rows[0].m,
    subcheckStateMax: sc.rows[0].m,
    inspectionTargetMax: target.rows[0]?.updated_at || null,
  });
});

// Recent activity (for "who edited what" feed - optional UI feature)
app.get('/api/activity', requireAuth, async (req, res) => {
  const v = req.session.vessel;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT actor, action, target_type, target_id, details, created_at
     FROM sire.activity_log WHERE vessel = $1 ORDER BY created_at DESC LIMIT $2`,
    [v, limit]
  );
  res.json(rows);
});

// =========================================================
// Static SPA
// =========================================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// =========================================================
// Boot
// =========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SIRE Prep Service listening on :${PORT}`);
});
