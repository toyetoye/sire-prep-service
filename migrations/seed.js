// migrations/seed.js — populates the DB with canonical OCIMF questions,
// the AT/AT10 walkdown library, sub-check definitions, and initial vessel
// passwords. Safe to re-run: uses INSERT ... ON CONFLICT DO UPDATE so existing
// rows are refreshed and not duplicated.
//
// Usage:
//   npm run seed
//   or:  npm run init-db   (runs migrate then seed)

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const SEED_DIR = path.join(__dirname, '..', 'seed-data');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    ssl: /sslmode=require/.test(url) || /\.railway\.app/.test(url) || /\.proxy\.rlwy\.net/.test(url)
         ? { rejectUnauthorized: false }
         : false,
  });

  // ============ Layer 1: canonical questions ============
  const questionsRaw = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'questions.json'), 'utf8'));
  const questions = Array.isArray(questionsRaw) ? questionsRaw : questionsRaw.questions;
  console.log(`Seeding ${questions.length} OCIMF questions...`);

  const qClient = await pool.connect();
  try {
    await qClient.query('BEGIN');
    for (const q of questions) {
      await qClient.query(`
        INSERT INTO sire.questions (
          question_id, chapter, section, short_question, question_text,
          vessel_types, roviq_sequence, objective, inspection_guidance,
          suggested_inspector_actions, expected_evidence,
          negative_observation_grounds, source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (question_id) DO UPDATE SET
          chapter = EXCLUDED.chapter,
          section = EXCLUDED.section,
          short_question = EXCLUDED.short_question,
          question_text = EXCLUDED.question_text,
          vessel_types = EXCLUDED.vessel_types,
          roviq_sequence = EXCLUDED.roviq_sequence,
          objective = EXCLUDED.objective,
          inspection_guidance = EXCLUDED.inspection_guidance,
          suggested_inspector_actions = EXCLUDED.suggested_inspector_actions,
          expected_evidence = EXCLUDED.expected_evidence,
          negative_observation_grounds = EXCLUDED.negative_observation_grounds,
          source = EXCLUDED.source
      `, [
        q.question_id || q.qid, q.chapter || q.ch, q.section || q.sec,
        q.short_question_text || q.short || null,
        q.question_text || q.qtext || null,
        q.vessel_types || q.types || null,
        q.roviq_sequence || q.roviq || null,
        q.objective || q.obj || null,
        q.inspection_guidance || q.guide || null,
        q.suggested_inspector_actions || q.actions || null,
        q.expected_evidence || q.evidence || null,
        q.potential_grounds_for_negative_observation || q.negobs || null,
        q.source || 'OCIMF SIRE 2.0 Question Library (Jan 2022)',
      ]);
    }
    await qClient.query('COMMIT');
  } catch (e) {
    await qClient.query('ROLLBACK');
    throw e;
  } finally {
    qClient.release();
  }

  // ============ Layer 2: walkdowns + sub-checks (per vessel) ============
  const wdRaw = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'walkdowns.json'), 'utf8'));
  const walkdowns = Array.isArray(wdRaw) ? wdRaw : wdRaw.layer_2_walkdowns;
  const vessels = ['AT', 'AT10'];

  console.log(`Seeding ${walkdowns.length} walkdowns × ${vessels.length} vessels = ${walkdowns.length * vessels.length} rows...`);

  const wClient = await pool.connect();
  try {
    await wClient.query('BEGIN');
    let scCount = 0;
    for (const vessel of vessels) {
      for (const w of walkdowns) {
        const walkdownId = w.walkdown_id || w.id;
        const qid = w.linked_question_id || w.qid;
        // Compute phase (same logic as the frontend)
        const ch = w.chapter || w.ch;
        const sec = w.section || w.sec;
        const roviq = (w.roviq_sequence || w.roviq || '').toLowerCase();
        let phase = 'walkdown';
        if (ch === '11') phase = 'photo';
        else if (sec === '5.1') phase = 'drills';
        else if (ch === '3') phase = 'briefings';
        else if (roviq.includes('documentation') || roviq.includes('pre-board') || roviq.includes('pre board')
                 || ['1','2','6','7'].includes(ch)) phase = 'documentation';

        await wClient.query(`
          INSERT INTO sire.walkdowns (
            walkdown_id, vessel, question_id, chapter, section, topic,
            evidence_item, detailed_criteria, check_type, location,
            roviq_sequence, responsible_role, backup_role,
            needs_manual_upgrade, phase
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (vessel, walkdown_id) DO UPDATE SET
            question_id = EXCLUDED.question_id,
            chapter = EXCLUDED.chapter,
            section = EXCLUDED.section,
            topic = EXCLUDED.topic,
            evidence_item = EXCLUDED.evidence_item,
            detailed_criteria = EXCLUDED.detailed_criteria,
            check_type = EXCLUDED.check_type,
            location = EXCLUDED.location,
            roviq_sequence = EXCLUDED.roviq_sequence,
            responsible_role = EXCLUDED.responsible_role,
            backup_role = EXCLUDED.backup_role,
            needs_manual_upgrade = EXCLUDED.needs_manual_upgrade,
            phase = EXCLUDED.phase
        `, [
          walkdownId, vessel, qid, ch, sec,
          w.topic || w.short_question_text || null,
          w.evidence_item || w.evidence || null,
          w.detailed_criteria || w.criteria || null,
          w.check_type || w.ctype || null,
          w.location || w.loc || null,
          w.roviq_sequence || w.roviq || null,
          w.responsible_role || w.resp || null,
          w.backup_role || w.backup || null,
          !!(w.needs_manual_upgrade ?? w.flagged),
          phase,
        ]);

        // Sub-checks
        const subchecks = w.subchecks || [];
        for (let i = 0; i < subchecks.length; i++) {
          const sc = subchecks[i];
          await wClient.query(`
            INSERT INTO sire.subchecks (vessel, walkdown_id, subcheck_id, ordinal, text)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (vessel, walkdown_id, subcheck_id) DO UPDATE SET
              ordinal = EXCLUDED.ordinal,
              text = EXCLUDED.text
          `, [vessel, walkdownId, sc.id, i, sc.text]);
          scCount++;
        }
      }
    }
    await wClient.query('COMMIT');
    console.log(`  Sub-check rows inserted: ${scCount}`);
  } catch (e) {
    await wClient.query('ROLLBACK');
    throw e;
  } finally {
    wClient.release();
  }

  // ============ Vessel auth: set initial passwords ============
  const atPw = process.env.SEED_AT_PASSWORD || 'at-sire-change-me';
  const at10Pw = process.env.SEED_AT10_PASSWORD || 'at10-sire-change-me';

  console.log('Setting initial vessel passwords (change these later via password change endpoint or DB)...');
  const atHash = await bcrypt.hash(atPw, 10);
  const at10Hash = await bcrypt.hash(at10Pw, 10);

  await pool.query(`
    INSERT INTO sire.vessel_auth (vessel, display_name, password_hash)
    VALUES ('AT', 'LPG Alfred Temile', $1), ('AT10', 'LPG AT10', $2)
    ON CONFLICT (vessel) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      password_hash = EXCLUDED.password_hash
  `, [atHash, at10Hash]);

  // ============ Initial inspection targets (empty) ============
  await pool.query(`
    INSERT INTO sire.inspection_targets (vessel)
    VALUES ('AT'), ('AT10')
    ON CONFLICT (vessel) DO NOTHING
  `);

  await pool.end();
  console.log('\nSeed complete.');
  console.log('Initial passwords:');
  console.log(`  AT   : ${atPw}`);
  console.log(`  AT10 : ${at10Pw}`);
  console.log('\nIMPORTANT: change these immediately via the /api/auth/change-password endpoint, or directly in the DB.');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
