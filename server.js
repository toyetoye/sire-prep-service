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
  // Drop idle clients BEFORE Railway's proxy does (idle TCP gets killed
  // around 30-60s). 25s gives us margin.
  idleTimeoutMillis: 25000,
  // Cap how long a brand-new connection can take to come up.
  connectionTimeoutMillis: 10000,
  // Tell the OS to send TCP keepalives on idle sockets so dead connections
  // are detected fast instead of being discovered only when the next query runs.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Pool-level error: an IDLE client died (e.g. Railway dropped it). Without
// this handler Node turns the error into an uncaught exception and crashes
// the whole service. Logging + continuing is the right thing — the next
// query just pulls a fresh client from the pool.
pool.on('error', err => {
  console.error('[pg pool] idle client error (non-fatal):', err.message);
});

// Last-resort safety nets so a stray DB error never takes the service down.
// We log and keep serving — Express route handlers already have their own
// try/catch around queries.
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

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

function requireSuper(req, res, next) {
  if (!req.session || req.session.role !== 'superintendent') {
    return res.status(403).json({ error: 'forbidden', detail: 'superintendent only' });
  }
  next();
}

function logActivity(vessel, actor, action, targetType, targetId, details, userId) {
  pool.query(
    `INSERT INTO sire.activity_log (vessel, actor, action, target_type, target_id, details, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [vessel, actor, action, targetType, targetId, details ? JSON.stringify(details) : null, userId || null]
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
  req.session.role = 'crew';
  req.session.userId = null;
  req.session.isCrew = true;
  logActivity(vessel, req.session.user, 'login');
  res.json({ ok: true, vessel, vesselName: rows[0].display_name, user: req.session.user, role: 'crew' });
});

// User-account login (office staff, superintendents, masters with their own credentials)
app.post('/api/auth/user-login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'missing_fields', detail: 'email and password required' });
  }
  const { rows } = await pool.query(
    'SELECT id, email, display_name, password_hash, role, vessel_scope, active FROM sire.users WHERE email = $1',
    [email.toLowerCase()]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'bad_credentials' });
  const u = rows[0];
  if (!u.active) return res.status(403).json({ error: 'account_disabled' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });

  // Determine initial vessel scope
  let vessel;
  if (u.role === 'superintendent') {
    // Default super to AT, but they can switch later
    vessel = 'AT';
  } else {
    if (!u.vessel_scope) return res.status(403).json({ error: 'no_vessel_assigned', detail: 'Ask superintendent to assign vessel.' });
    vessel = u.vessel_scope;
  }

  req.session.vessel = vessel;
  req.session.user = u.display_name;
  req.session.role = u.role;
  req.session.userId = u.id;
  req.session.email = u.email;
  req.session.isCrew = false;

  await pool.query('UPDATE sire.users SET last_login_at = NOW() WHERE id = $1', [u.id]);
  logActivity(vessel, u.display_name, 'user_login', 'user', String(u.id), null, u.id);

  res.json({
    ok: true,
    vessel, user: u.display_name, role: u.role, email: u.email,
    canSwitchVessel: u.role === 'superintendent',
  });
});

// Superintendent: switch the vessel they're viewing
app.post('/api/auth/switch-vessel', requireSuper, async (req, res) => {
  const { vessel } = req.body || {};
  if (!vessel) return res.status(400).json({ error: 'missing_fields' });
  const { rows } = await pool.query('SELECT display_name FROM sire.vessel_auth WHERE vessel = $1', [vessel]);
  if (rows.length === 0) return res.status(404).json({ error: 'unknown_vessel' });
  req.session.vessel = vessel;
  res.json({ ok: true, vessel, vesselName: rows[0].display_name });
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.vessel) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    vessel: req.session.vessel,
    user: req.session.user,
    role: req.session.role || 'crew',
    email: req.session.email || null,
    userId: req.session.userId || null,
    canSwitchVessel: req.session.role === 'superintendent',
    isCrew: !!req.session.isCrew,
  });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'bad_input', detail: 'newPassword must be at least 8 chars' });
  }
  if (req.session.userId) {
    // User-account password change
    const { rows } = await pool.query('SELECT password_hash FROM sire.users WHERE id = $1', [req.session.userId]);
    if (rows.length === 0 || !(await bcrypt.compare(oldPassword, rows[0].password_hash))) {
      return res.status(401).json({ error: 'bad_password' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE sire.users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    logActivity(req.session.vessel, req.session.user, 'user_password_change', 'user', String(req.session.userId), null, req.session.userId);
    return res.json({ ok: true, type: 'user' });
  }
  // Vessel shared-password change (crew session)
  const { rows } = await pool.query('SELECT password_hash FROM sire.vessel_auth WHERE vessel = $1', [req.session.vessel]);
  if (rows.length === 0 || !(await bcrypt.compare(oldPassword, rows[0].password_hash))) {
    return res.status(401).json({ error: 'bad_password' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE sire.vessel_auth SET password_hash = $1 WHERE vessel = $2', [hash, req.session.vessel]);
  logActivity(req.session.vessel, req.session.user, 'vessel_password_change');
  res.json({ ok: true, type: 'vessel' });
});

// =========================================================
// Admin routes (superintendent only)
// =========================================================

// List all users
app.get('/api/admin/users', requireSuper, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, email, display_name, role, vessel_scope, active, created_at, last_login_at
    FROM sire.users ORDER BY role DESC, created_at DESC
  `);
  res.json(rows);
});

// Create user
app.post('/api/admin/users', requireSuper, async (req, res) => {
  const { email, displayName, password, role, vesselScope } = req.body || {};
  if (!email || !displayName || !password || !role) {
    return res.status(400).json({ error: 'missing_fields', detail: 'email, displayName, password, role required' });
  }
  if (!['superintendent','master','crew'].includes(role)) {
    return res.status(400).json({ error: 'bad_role' });
  }
  if (role !== 'superintendent' && !vesselScope) {
    return res.status(400).json({ error: 'vessel_scope_required', detail: 'master and crew accounts must specify a vesselScope' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'weak_password', detail: 'minimum 8 chars' });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(`
      INSERT INTO sire.users (email, display_name, password_hash, role, vessel_scope, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, email, display_name, role, vessel_scope, active, created_at
    `, [email.toLowerCase(), displayName, hash, role, vesselScope || null, req.session.userId]);
    logActivity(req.session.vessel, req.session.user, 'user_create', 'user', String(result.rows[0].id),
      { email: email.toLowerCase(), role, vesselScope }, req.session.userId);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_exists' });
    console.error('user create failed:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// Update user (role, active, vessel_scope, displayName)
app.patch('/api/admin/users/:id', requireSuper, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  if (id === req.session.userId && req.body.role && req.body.role !== 'superintendent') {
    return res.status(400).json({ error: 'cannot_demote_self' });
  }
  const fields = [];
  const values = [];
  let i = 1;
  for (const [col, key] of [['display_name','displayName'],['role','role'],['vessel_scope','vesselScope'],['active','active']]) {
    if (key in req.body) {
      if (col === 'role' && !['superintendent','master','crew'].includes(req.body.role)) {
        return res.status(400).json({ error: 'bad_role' });
      }
      fields.push(`${col} = $${i++}`);
      values.push(req.body[key]);
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: 'no_fields' });
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE sire.users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, email, display_name, role, vessel_scope, active`,
    values
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  logActivity(req.session.vessel, req.session.user, 'user_update', 'user', String(id), req.body, req.session.userId);
  res.json(rows[0]);
});

// Reset another user's password
app.post('/api/admin/users/:id/reset-password', requireSuper, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { newPassword } = req.body || {};
  if (!id || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'bad_input' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  const r = await pool.query('UPDATE sire.users SET password_hash = $1 WHERE id = $2', [hash, id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  logActivity(req.session.vessel, req.session.user, 'user_password_reset', 'user', String(id), null, req.session.userId);
  res.json({ ok: true });
});

// Delete user (cannot delete self)
app.delete('/api/admin/users/:id', requireSuper, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.userId) return res.status(400).json({ error: 'cannot_delete_self' });
  const r = await pool.query('DELETE FROM sire.users WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  logActivity(req.session.vessel, req.session.user, 'user_delete', 'user', String(id), null, req.session.userId);
  res.json({ ok: true });
});

// Reset/change a vessel's shared crew password (super only, from office)
app.post('/api/admin/vessels/:vessel/password', requireSuper, async (req, res) => {
  const { newPassword } = req.body || {};
  const vessel = req.params.vessel;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'bad_input' });
  const hash = await bcrypt.hash(newPassword, 10);
  const r = await pool.query('UPDATE sire.vessel_auth SET password_hash = $1 WHERE vessel = $2', [hash, vessel]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'unknown_vessel' });
  logActivity(vessel, req.session.user, 'vessel_password_admin_reset', null, null, null, req.session.userId);
  res.json({ ok: true });
});

// Fleet-wide overview: aggregate stats per vessel
app.get('/api/admin/fleet-overview', requireSuper, async (req, res) => {
  // For each vessel: count walkdowns + sub-checks done + last activity
  const overview = await pool.query(`
    SELECT
      w.vessel,
      va.display_name AS vessel_name,
      COUNT(DISTINCT w.walkdown_id) AS total_walkdowns,
      COUNT(DISTINCT sc.subcheck_id) AS total_subchecks,
      COUNT(DISTINCT scs.subcheck_id) FILTER (WHERE scs.checked) AS checked_subchecks,
      MAX(scs.updated_at) AS last_activity,
      it.target_date,
      it.inspector_name,
      it.port
    FROM sire.walkdowns w
    JOIN sire.vessel_auth va ON va.vessel = w.vessel
    LEFT JOIN sire.subchecks sc ON sc.vessel = w.vessel AND sc.walkdown_id = w.walkdown_id
    LEFT JOIN sire.subcheck_state scs ON scs.vessel = w.vessel AND scs.walkdown_id = w.walkdown_id AND scs.subcheck_id = sc.subcheck_id
    LEFT JOIN sire.inspection_targets it ON it.vessel = w.vessel
    GROUP BY w.vessel, va.display_name, it.target_date, it.inspector_name, it.port
    ORDER BY w.vessel
  `);
  res.json(overview.rows);
});

// Export full vessel state as JSON snapshot (for archive, audit, handover)
app.get('/api/admin/export/:vessel', requireSuper, async (req, res) => {
  const v = req.params.vessel;
  const [vesselRes, target, walkdowns, subchecks, wdState, scState, activity] = await Promise.all([
    pool.query('SELECT vessel, display_name FROM sire.vessel_auth WHERE vessel = $1', [v]),
    pool.query('SELECT * FROM sire.inspection_targets WHERE vessel = $1', [v]),
    pool.query('SELECT * FROM sire.walkdowns WHERE vessel = $1 ORDER BY chapter::int, section, walkdown_id', [v]),
    pool.query('SELECT * FROM sire.subchecks WHERE vessel = $1 ORDER BY walkdown_id, ordinal', [v]),
    pool.query('SELECT * FROM sire.walkdown_state WHERE vessel = $1', [v]),
    pool.query('SELECT * FROM sire.subcheck_state WHERE vessel = $1', [v]),
    pool.query('SELECT * FROM sire.activity_log WHERE vessel = $1 ORDER BY created_at DESC LIMIT 1000', [v]),
  ]);
  if (vesselRes.rows.length === 0) return res.status(404).json({ error: 'unknown_vessel' });
  const filename = `SIRE_${v}_snapshot_${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({
    exported_at: new Date().toISOString(),
    exported_by: req.session.user,
    vessel: vesselRes.rows[0],
    inspection_target: target.rows[0] || null,
    walkdowns: walkdowns.rows,
    subchecks: subchecks.rows,
    walkdown_state: wdState.rows,
    subcheck_state: scState.rows,
    recent_activity: activity.rows,
  });
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
