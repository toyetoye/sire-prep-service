# SIRE Prep Service

Multi-user SIRE 2.0 inspection preparation app for the NSML LPG fleet (LPG Alfred Temile, AT10, future LPG Tazerbo).
Express + PostgreSQL service. Shares the FORCAP/MARIDE database via an isolated `sire` schema.

## What's inside

- **318 OCIMF SIRE 2.0 canonical questions** (Layer 1, extracted from the official January 2022 PDFs).
- **950 vessel-specific walkdowns** linked to the OCIMF questions (Layer 2, per-vessel).
- **4,804 atomic sub-checks** — one checkbox per surveyor-facing detail.
- **6-phase timeline** tied to a vessel-specific inspection date.
- **Per-vessel shared password auth** with a simple "your name" field so we know who ticked what.
- **10-second cross-device sync** via polling on a lightweight stamp endpoint.

The frontend is a single-file SPA in `public/index.html` (62 KB). All data lives in PostgreSQL.

---

## One-time deployment (about 30 minutes)

### Step 1 — push to GitHub

```bash
cd sire-prep-service
git init
git add -A
git commit -m "Initial commit: SIRE Prep Service"

# Create a new repo on github.com under your account or the toyetoye org,
# call it sire-prep-service. Don't initialize with README/license/.gitignore.
# Then:
git remote add origin git@github.com:toyetoye/sire-prep-service.git
git branch -M main
git push -u origin main
```

If you prefer to push via HTTPS with your PAT, the remote URL would be
`https://<PAT>@github.com/toyetoye/sire-prep-service.git`.

### Step 2 — deploy to Railway

1. Open the **`illustrious-ambition`** Railway project (or whichever project hosts the FORCAP/MARIDE Postgres add-on).
2. Click **New → GitHub Repo** and pick `sire-prep-service`.
3. Railway will detect Node.js automatically. Wait for the first build to complete (it will fail at runtime because env vars aren't set yet — that's fine).
4. Open the new service's **Variables** tab and add:
   - `DATABASE_URL` — set this to the **same** value the MARIDE service uses for `DATABASE_URL`. Easiest way: in the Postgres service variables, copy `DATABASE_URL` and paste it here. (If you want a separate Postgres user with restricted permissions, see "Database hardening" below.)
   - `SESSION_SECRET` — generate a long random string. Locally: `openssl rand -hex 32`. Paste the result.
   - `SEED_AT_PASSWORD` — the initial AT vessel password (e.g. `AT-sire-2026-temp`). You'll change this immediately after seeding.
   - `SEED_AT10_PASSWORD` — same for AT10.
   - `NODE_ENV` — set to `production`.
5. Open **Settings → Networking** and click **Generate Domain** to get a public URL (e.g. `sire-prep-service-production.up.railway.app`). Or attach a custom domain.
6. Railway will redeploy automatically when you save variables. Wait for the green build.

### Step 3 — initialize the database

You only do this once. Two options:

**Option A — Railway CLI (recommended):**

```bash
# Install once
npm install -g @railway/cli

# Link the local folder to the Railway service
railway link    # follow prompts, pick the SIRE service

# Run migrations + seed using Railway's environment
railway run npm run init-db
```

**Option B — temporarily run init-db on Railway:**

Edit the service's **Settings → Deploy → Custom Start Command** to:
```
npm run init-db && npm start
```
Deploy. After the first boot logs show "Seed complete", change the start command back to `npm start`. (Less elegant but works without the CLI.)

### Step 4 — verify

Open the Railway URL in a browser. You should see the login screen.

- Pick **LPG Alfred Temile (AT)**.
- Enter your name (e.g. "Master Adeyemi" or "C/O Okafor").
- Enter the temp password you set in `SEED_AT_PASSWORD`.
- You should land on the Home dashboard. Set the inspection date — the phase cards will light up.

Test from a second device (your phone) with the same password but a different name. Tick a sub-check on one device — within 10 seconds the other device should refresh and show it ticked, with "Last edited by …" on the walkdown.

### Step 5 — change the temp passwords

The temp passwords from the env vars are stored as bcrypt hashes in `sire.vessel_auth`. To change them properly:

```bash
# Via the API (curl from your terminal, while logged in via cookies — easier from inside the app)
# Or just connect to the DB and update:
railway connect Postgres   # opens psql
```

```sql
-- Replace 'newpasswordhere' with the real new password (the app will hash it).
-- The cleanest way is to use the change-password endpoint from inside the app after logging in:
-- POST /api/auth/change-password { oldPassword, newPassword }
-- but if you just want to set fresh bcrypt hashes via SQL:
UPDATE sire.vessel_auth SET password_hash = crypt('newpasswordhere', gen_salt('bf', 10)) WHERE vessel = 'AT';
```

(That `crypt()` call requires the `pgcrypto` extension. If it's not enabled: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`. Or just call the `/api/auth/change-password` endpoint from the app — easier.)

---

## Day-to-day usage

- **Master** sets the inspection date once. Phases activate automatically as the countdown moves.
- **Each crew member** logs in with their name + the vessel password. Their name is stamped on every box they tick.
- **Officers** click the "By Officer" tile on Home to see their queue. They tick sub-checks as they verify them.
- **Anyone** can leave a note on a specific sub-check (the `+ Note` button) — useful for capturing defects on individual items.
- **The Master / C/O** uses the walkdown-level Notes field for broader findings and the Severity dropdown to flag critical items.
- **Day of inspection**: open the Home view, hit the OCIMF Reference tab to anticipate questions, click any walkdown to mark it Closed in real time.

---

## File map

```
sire-prep-service/
├── server.js                  Express app, auth, API endpoints
├── package.json
├── railway.json               Railway build/deploy config
├── .env.example               Env var template
├── migrations/
│   ├── 001_init.sql           Schema: 7 tables in `sire` schema
│   ├── run.js                 Applies all .sql files
│   └── seed.js                Loads questions + walkdowns + initial passwords
├── seed-data/
│   ├── questions.json         413 OCIMF questions (3.5 MB)
│   └── walkdowns.json         950 walkdowns + 4804 sub-checks (1.5 MB)
└── public/
    └── index.html             62 KB SPA — login, home, walkdowns, OCIMF reference
```

---

## Database hardening (optional, later)

Right now the service uses MARIDE's `DATABASE_URL` directly, so it has full access to the shared database. For production hardening:

```sql
-- Inside the existing Postgres database
CREATE USER sire_app WITH PASSWORD 'pick-a-strong-one';
GRANT USAGE ON SCHEMA sire TO sire_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sire TO sire_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA sire TO sire_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA sire GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sire_app;

-- Construct the URL: postgres://sire_app:pick-a-strong-one@<host>:<port>/<dbname>
-- Replace DATABASE_URL in Railway env vars with this scoped URL.
```

This keeps the SIRE service from accidentally touching the `eom`, `budget`, `fuel`, `maride`, or `rag` schemas if there's ever a bug.

---

## Adding a third vessel (Tazerbo example)

When LPG Tazerbo comes into the fleet:

```sql
-- Insert vessel record + initial password
INSERT INTO sire.vessel_auth (vessel, display_name, password_hash)
VALUES ('TAZ', 'LPG Tazerbo', crypt('taz-sire-temp', gen_salt('bf', 10)));

INSERT INTO sire.inspection_targets (vessel) VALUES ('TAZ');
```

Then seed walkdowns for that vessel. Run the seed script with `SEED_VESSELS=TAZ` or modify `migrations/seed.js` (the `vessels` array near the top) and re-run it. The script is idempotent — re-running won't duplicate.

The frontend will automatically pick up the new vessel via `/api/auth/vessels` — no code change needed.

---

## Local development

```bash
cp .env.example .env
# Edit .env: put a local Postgres URL, e.g.:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/sire_dev
#   SESSION_SECRET=anything-random-for-local

npm install
npm run init-db    # creates schema + seeds data
npm start          # listens on PORT (default 3000)

# Open http://localhost:3000
```

For testing without a separate local Postgres: use Railway's connection URL directly (start with a fresh DB or be careful):
```bash
railway run npm start
```

---

## Troubleshooting

**"DATABASE_URL is not set" at boot.**
Set the Railway env var. If you set it but still see this, check the **Deployments** tab — variables apply to the next deploy; click "Redeploy" if needed.

**SSL/TLS handshake errors.**
The seed/run scripts auto-detect Railway hosts and enable SSL. If you're using a custom Postgres host that needs SSL, add `?sslmode=require` to the connection string.

**"unknown_vessel" on login.**
Run the seed script — vessel records are inserted then.

**"bad_password" but you know it's right.**
Caps lock. If that's not it, reset the password via the `/api/auth/change-password` endpoint after logging in as anyone (you can't — chicken and egg), or via SQL directly:
```sql
UPDATE sire.vessel_auth SET password_hash = crypt('new-password', gen_salt('bf', 10)) WHERE vessel = 'AT';
```

**Login works, app loads, but sub-checks don't save.**
Check the browser console for fetch errors. The session cookie may have been blocked by `secure: true` if you're accessing over plain HTTP. Make sure Railway gave you an HTTPS URL.

**One user's edits aren't appearing on another user's screen.**
Both should see updates within 10 seconds. If not, check the syncPill in the top-right — if it shows "sync error", the polling endpoint isn't reachable. Usually a session cookie expiry issue; log out and back in.

---

## What this doesn't do (yet)

- **Mobile-native apps.** It works on phones via the browser. Native apps are a separate project.
- **Real-time push.** It polls every 10 seconds. For true real-time, swap polling for Server-Sent Events (small change in `server.js` + frontend) — not urgent for a checklist app.
- **Conflict resolution UI.** Last-write-wins on edits. If two people simultaneously tick the same sub-check different ways, the later edit wins silently. Fine for this domain.
- **Per-user permissions.** Anyone with the vessel password has full read/write. Add row-level guards in `server.js` if you need read-only crew accounts.
- **Attachments / photos.** No file upload yet. For the photo-evidence walkdowns, crew currently just enter the file ref in the notes. Adding S3/Railway-volume-backed uploads is a follow-on.

Roadmap is in the project tracker; speak to FORCAP / Sprocky.

---

## Credits

OCIMF SIRE 2.0 Question Library © OCIMF (Oil Companies International Marine Forum). Used here as reference text for inspection preparation per OCIMF's stated public use.

App © FORCAP Maritime Intelligence Ltd. Built for NSML use.
