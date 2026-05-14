// migrations/run.js — applies SQL migrations against the configured DB.
// Idempotent: safe to run multiple times (uses CREATE IF NOT EXISTS).
//
// Usage:
//   npm run migrate          # locally with DATABASE_URL set
//   railway run npm run migrate   # from your laptop, executes inside Railway env

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    // Railway internal hosts use plain TCP; public hosts need SSL. Auto-detect.
    ssl: /sslmode=require/.test(url) || /\.railway\.app/.test(url) || /\.proxy\.rlwy\.net/.test(url)
         ? { rejectUnauthorized: false }
         : false,
  });

  const files = fs.readdirSync(__dirname)
    .filter(f => /^\d+_.+\.sql$/.test(f))
    .sort();

  for (const f of files) {
    const sql = fs.readFileSync(path.join(__dirname, f), 'utf8');
    process.stdout.write(`Applying ${f} ... `);
    await pool.query(sql);
    console.log('done');
  }

  await pool.end();
  console.log('Migrations complete.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
