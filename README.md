# AgriVision QC – Web Dashboard (Next.js 16 + Supabase)

Production Next.js 16 (App Router, TypeScript) + Supabase (`emqooadipseotdbzqtbd`) replacement for the legacy Streamlit application (`../x-26-10.py` / `../shf-db-v2-5.py`, **AgriVision QC V5.2 — SQUAD Result Dashboard**).

Source specification: [../convertdb-webapp.md](../convertdb-webapp.md) · Deployment guide: [DEPLOY.md](DEPLOY.md)

---

## 1. Architecture Overview

```text
+-----------------------------------------------------------------------------------+
|                        Jetson Edge Device (Ubuntu / L4T)                          |
|                                                                                   |
|  [shf-core vision pipeline]                                                       |
|         | writes                                                                  |
|         v                                                                         |
|  ~/Desktop/Results/                                                               |
|    ├── grain_<plate>_<YYYYMMDD_HHMMSS>_rolling10s.csv                             |
|    └── snapshots/<YYYYMMDD_HHMMSS>_<plate>_plate<N>.jpg                           |
|         |                                                                         |
|         | tailed by byte offset + SHA-256 first-record replacement detection      |
|         v                                                                         |
|  [edge-sync/sync.py] (systemd: agrivision-sync.service, Python >= 3.8 + Pillow)   |
|    - state persisted atomically in ~/.agrivision-sync/state.json (.bak fallback)  |
|    - generates 480 px JPEG thumbnails in memory                                   |
|    - bounded backoff (max 300 s) on network drops; 15 min cooldown on 401/403     |
+--------------------+-----------------------------------------+--------------------+
                     | HTTPS Bearer agv_<device_key>           | HTTPS PUT (signed URL)
                     v                                         v
+----------------------------------------+   +--------------------------------------+
|      Next.js 16 App (Vercel sin1)      |   |   Supabase Project emqooadipseotdbzqtbd
|                                        |   |                                      |
|  Machine Ingest API:                   |   |  Postgres 15+ (RLS enabled):         |
|   POST /api/ingest/rows                |-->|   - devices (sha256 api_key_hash)    |
|   POST /api/ingest/snapshots/sign      |-->|   - batches (stats triggers)         |
|   POST /api/admin/import               |   |   - inspection_rows (Realtime pub)   |
|   GET  /api/health                     |   |   - snapshots (Realtime pub)         |
|                                        |   |   - reports                          |
|  Authenticated User / Admin API:       |   |   - app_settings + settings_audit_log|
|   GET  /api/batches                    |<->|   - profiles (admin / viewer,        |
|   GET  /api/batches/[id]               |   |               is_active_user() RLS)  |
|   GET  /api/batches/[id]/snapshots     |   |                                      |
|   POST /api/batches/[id]/report (PDF)  |-->|  Private Storage Buckets:            |
|   GET/PUT   /api/admin/settings        |   |   - snapshots (<batch_id>/<file>.jpg |
|   GET/POST/PATCH /api/admin/devices    |   |     & <batch_id>/thumbs/<file>.jpg)  |
|   GET/POST/PATCH /api/admin/users      |   |   - reports (<batch_id>/<ts>.pdf)    |
+--------------------+-------------------+   +------------------+-------------------+
                     ^                                          ^
                     | HTTPS (@supabase/ssr cookies + CSP)      | WSS Realtime +
                     v                                          | 10-min Signed URLs
+---------------------------------------------------------------+-------------------+
|             Browser Client (Operators / Viewers & Administrators)                 |
|  - /login (Supabase Auth email + password; public signup disabled)                |
|  - / (HMI QC Dashboard: Summary, Per-Plate, Snapshots, Details, PDF Report)       |
|  - /batches (Batch Picker: Recently Opened, Today in Asia/Bangkok, Archive)       |
|  - /settings (Admin Console: App Settings & Audit Log, Edge Devices, Users)       |
|  - /admin/import (Admin CSV + Snapshot Web Importer)                              |
+-----------------------------------------------------------------------------------+
```

---

## 2. Environment Variables

| Variable | Where Used | Secret? | Required in Prod? | Description |
| :--- | :--- | :---: | :---: | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + Server | No | **Yes** | Supabase project HTTPS URL (`https://emqooadipseotdbzqtbd.supabase.co`). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser + Server | No | **Yes** | Supabase publishable key (`sb_publishable_...`). Falls back to `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only (`lib/ingest/store-supabase.ts`) | **Yes** | **Yes** | Supabase service-role / secret key (`sb_secret_...`). Never imported by client components. |
| `ADMIN_IMPORT_TOKEN` | Server only (`app/api/admin/import/route.ts`) | **Yes** | **Yes** | `>= 32` character secret token (`pnpm gen-token`) for CLI/machine calls to `/api/admin/import`. |
| `SUPABASE_URL` | Server only (`lib/env.ts`) | No | No | Optional server override for Supabase URL; falls back to `NEXT_PUBLIC_SUPABASE_URL`. |
| `ALLOW_INSECURE_ADMIN_IMPORT` | Dev only (`/api/admin/import`) | No | **Forbidden in prod** | Development-only bypass (`1`) when `ADMIN_IMPORT_TOKEN` is unset. Blocked when `NODE_ENV=production`. |
| `DASHBOARD_BASIC_AUTH_ENABLED` | `proxy.ts`, `lib/auth/basic-auth.ts` | No | No | Default `0`. Set to `1` to add an extra HTTP Basic Auth prompt in front of `/login`. |
| `DASHBOARD_BASIC_AUTH_USER` | `lib/auth/basic-auth.ts` | No | If Basic Auth on | HTTP Basic Auth username when `DASHBOARD_BASIC_AUTH_ENABLED=1`. |
| `DASHBOARD_BASIC_AUTH_PASSWORD` | `lib/auth/basic-auth.ts` | **Yes** | If Basic Auth on | HTTP Basic Auth password when `DASHBOARD_BASIC_AUTH_ENABLED=1` (weak defaults rejected in prod). |
| `BOOTSTRAP_ADMIN_PASSWORD` | CLI (`scripts/bootstrap-admin.ts`) | **Yes** | No | Optional env var to supply the initial admin password (`>= 12` chars) to `pnpm bootstrap-admin <email>`. |
| `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` | CLI (`scripts/smoke.ts`) | **Yes** | No | Optional credentials for the authenticated section of `pnpm smoke [base-url]`. |
| `AGRIVISION_API_URL` | Jetson (`edge-sync/sync.py`) | No | **Yes (Jetson)** | Web app base URL (`https://...`; `http://` is rejected unless host is `localhost`/`127.0.0.1`/`::1`). |
| `AGRIVISION_DEVICE_KEY` | Jetson (`edge-sync/sync.py`) | **Yes** | **Yes (Jetson)** | Device bearer key (`agv_...`) created via `pnpm create-device <name>` or `/settings`. |
| `AGRIVISION_RESULTS_DIR` | Jetson (`edge-sync/sync.py`) | No | No | Overrides CSV/snapshot root directory (falls back to `config.json` `"results_dir"`, then `~/Desktop/Results`). |
| `AGRIVISION_SYNC_STATE` | Jetson (`edge-sync/sync.py`) | No | No | Path to sync state file (default `~/.agrivision-sync/state.json`, with automatic `.bak` backup). |
| `AGRIVISION_SYNC_INTERVAL_S` | Jetson (`edge-sync/sync.py`) | No | No | Poll interval in seconds (default `5`). |
| `AGRIVISION_MAX_AGE_DAYS` | Jetson (`edge-sync/sync.py`) | No | No | Ignore CSVs not modified within `N` days (default `7`; set `0` to sync all historical CSVs). |

---

## 3. Database Migrations (`supabase/migrations/`)

> **Rule:** Never edit a migration that has already been pushed to the remote database. Always add a new migration file.

| Migration File | Summary |
| :--- | :--- |
| `20261028000001_schema.sql` | Core tables (`devices`, `batches`, `inspection_rows`, `snapshots`, `reports`, `app_settings`, `profiles`), indexes, and `refresh_batch_stats` triggers on `inspection_rows` (`INSERT`/`DELETE`). |
| `20261028000002_rls_storage.sql` | Enables RLS on all tables, creates `public.is_admin()`, read policies for `authenticated`, admin write policies, and private Storage buckets (`snapshots`, `reports`) + storage RLS policies. |
| `20261028000003_batches_nulls_not_distinct.sql` | Upgrades `batches (device_id, source_name)` uniqueness to `NULLS NOT DISTINCT` (plus partial unique index when `device_id IS NULL`), adds `devices.last_seen_at`, and adds `AFTER UPDATE` trigger (`rows_stats_upd`) on `inspection_rows`. |
| `20261028000004_realtime_publication.sql` | Idempotently adds `public.inspection_rows` and `public.snapshots` to the `supabase_realtime` publication. |
| `20261028000005_seed_weights_immature_0_2.sql` | Seeds the 4 per-class grain weights (`good=0.31`, `immature=0.2`, `sm=0.25`, `dc=0.3`) into `app_settings` and updates any existing `immature_seed_weight_g` row to `0.2`. |
| `20261028000006_app_settings_value_text.sql` | Alters `public.app_settings.value` from `numeric` to `text` (preserving existing values) and seeds `snapshot_filename_tz = 'UTC'`. |
| `20261028000007_report_footer_settings.sql` | Seeds `report_footer_left = 'SQAUD · Grain QC Report'` and `report_form_code = 'FM-JJR'` into `app_settings`. |
| `20261028000008_phase7_auth_admin_audit.sql` | Adds `app_settings.updated_at` & `updated_by`, creates `public.settings_audit_log` with RLS, adds `profiles.disabled_at`, expands `profiles.role` check constraint to `('admin', 'viewer', 'operator')` (default `'viewer'`), and updates `is_admin()` to check `disabled_at IS NULL`. |
| `20261028000009_repair_migration_003_objects.sql` | Idempotently ensures all objects from `000003` (`devices.last_seen_at`, `batches_null_device_source_uniq`, `rows_stats_upd`) exist on environments where `000003` was marked applied before running. |
| `20261028000010_disabled_users_rls.sql` | Creates `public.is_active_user()` and `public.revoke_user_sessions(uuid)`, and updates all read RLS policies (`batches`, `inspection_rows`, `snapshots`, `reports`, `app_settings`, `profiles`, and `storage.objects`) to require `public.is_active_user()`. |

---

## 4. Onboarding & Operations

### 4.1 First-Admin Bootstrap
Public sign-up is disabled. Create or promote your first administrator account using the CLI script or SQL:

- **CLI (recommended):**
  ```bash
  # Prompts for password interactively with hidden input (minimum 12 characters):
  pnpm bootstrap-admin admin@example.com

  # Or pass via environment variable (never pass passwords as CLI arguments):
  BOOTSTRAP_ADMIN_PASSWORD='<at-least-12-chars>' pnpm bootstrap-admin admin@example.com
  ```
- **SQL alternative (after creating the user in Supabase Dashboard → Authentication → Users):**
  ```sql
  insert into public.profiles (user_id, role, disabled_at)
  values ('<auth-user-uuid>', 'admin', null)
  on conflict (user_id) do update set role = 'admin', disabled_at = null;
  ```

### 4.2 Device Onboarding
Create a device key from the web UI (**Settings → Edge Devices → Create Device**) or via the CLI:
```bash
pnpm create-device jetson-1
# Prints AGRIVISION_DEVICE_KEY=agv_... ONCE. Only its SHA-256 hex digest is stored in public.devices.
```
To revoke a compromised or retired device key:
```bash
pnpm create-device --revoke jetson-1
# Or click "Revoke" in /settings -> Edge Devices.
```

### 4.3 Historical CSV & Snapshot Import Flow
- **CLI Importer (recommended for large backlogs or >100 snapshots):**
  ```bash
  # Dry run (no DB writes; prints parsed metrics, skip report, and weight sanity check):
  pnpm import-csv parity/fixtures/real_multiplate.csv --dry-run

  # Live import into Supabase (automatically imports sibling snapshots/ directory unless --no-snapshots):
  pnpm import-csv /path/to/grain_SAMPLE\ 1_20261019_061517_rolling10s.csv --device jetson-1
  ```
- **Web Importer (`/admin/import` → `POST /api/admin/import`):**
  - Accessible to logged-in `admin` users in the browser, or via CLI/curl with `-H "x-admin-token: $ADMIN_IMPORT_TOKEN"`.
  - Enforces payload limits: **CSV ≤ 10 MB**, **≤ 100 snapshot files per request**, and **≤ 10 MB per snapshot image**.

---

## 5. Domain Rules: Weight Model & Timezones

### 5.1 Per-Class Weight Model (`ASSUMED, not measured`)
The weight conversion model in `lib/qc/metrics.ts` and `lib/qc/config.ts` multiplies each class's estimated grain count by a per-class single-seed weight:
- `good_seed_weight_g`: **`0.31 g`**
- `immature_seed_weight_g`: **`0.2 g`**
- `sm_seed_weight_g` (Spoiled & Mold): **`0.25 g`**
- `dc_seed_weight_g` (Discolor): **`0.3 g`**

> **IMPORTANT:** These four single-seed weights are **ASSUMED, not measured** (`WEIGHT_VALUES_MEASURED = false` in `lib/qc/config.ts`). They are stored in `public.app_settings` and can be updated at any time in `/settings` once laboratory measurements are completed.
>
> On the reference `SAMPLE 1` batch (`grain_SAMPLE 1_20261019_061517_rolling10s.csv`, 55 rows), these weights produce **Good (by weight) = `84.5%`** (`71 g` of `84 g`) and **Total Defect (by weight) = `15.5%`** (`13 g` of `84 g`), matching the legacy `x-26-10.py` screenshot.
>
> The obsolete `±25%` warning against a fixed `500 g` sample weight (`weight_sanity_check_enabled`) is **disabled by default** because total batch weight under the per-class model scales with the actual number of grains inspected (`84 g` on `SAMPLE 1`).

### 5.2 Timezone Rules (`Asia/Bangkok` vs `UTC`)
1. **CSV `snapshot_time` column (`lib/qc/time.ts`):**
   - Offset-aware ISO timestamps (e.g. `2026-10-19T06:15:28.144920+07:00`) are parsed as exact instants.
   - Naive timestamps without an offset (`YYYY-MM-DD HH:MM:SS`) are interpreted as **`Asia/Bangkok` (`UTC+07:00`)** wall-clock time.
   - All timestamps displayed in the UI and PDF report are formatted in **`Asia/Bangkok` (`UTC+7`)**.
2. **Snapshot filenames (`lib/qc/snapshot-meta.ts` & `snapshot_filename_tz`):**
   - Real Jetson snapshot filenames (e.g. `20261019_061528_SAMPLE 1_plate1.jpg`) encode **`UTC`** wall-clock timestamps (`2026-10-19 06:15:28 UTC` = `13:15:28` Bangkok), verified against the real `SAMPLE 1` dataset (`0.1 s` delta from CSV row timestamps when parsed as `UTC` vs `25,200 s` = `7 h` offset if parsed as Bangkok).
   - Controlled by the `app_settings` key `snapshot_filename_tz` (default **`"UTC"`**, configurable to `"Asia/Bangkok"` in `/settings`).
   - When matching a snapshot to an inspection row (`±15 s` window), same-plate matches are preferred; if a snapshot's plate has no rows and falls back to another plate's row, `row_match.approximate` is set to `true` and the UI badges it as **`Row match (other plate)`**.

---

## 6. One-Page Jetson `edge-sync` Install Checklist

1. **Verify Python `>= 3.8` and create a virtual environment on the Jetson:**
   ```bash
   python3 --version   # must be >= 3.8
   sudo mkdir -p /opt/agrivision/edge-sync
   sudo chown -R ps-jetson:ps-jetson /opt/agrivision
   cp edge-sync/sync.py edge-sync/requirements.txt edge-sync/agrivision-sync.service /opt/agrivision/edge-sync/
   cd /opt/agrivision/edge-sync
   python3 -m venv .venv
   .venv/bin/pip install --upgrade pip
   .venv/bin/pip install -r requirements.txt   # installs Pillow>=9.0 for 480 px JPEG thumbnails
   ```
2. **Create a device key (on your workstation or in `/settings → Edge Devices`):**
   ```bash
   pnpm create-device jetson-line-1
   # Copy the printed agv_... key
   ```
3. **Create `/etc/agrivision-sync.env` with mode `0600`:**
   ```bash
   sudo tee /etc/agrivision-sync.env >/dev/null <<'EOF'
   AGRIVISION_API_URL=https://<your-vercel-domain>
   AGRIVISION_DEVICE_KEY=agv_<paste-device-key>
   AGRIVISION_RESULTS_DIR=/home/ps-jetson/Desktop/Results
   AGRIVISION_SYNC_STATE=/home/ps-jetson/.agrivision-sync/state.json
   AGRIVISION_SYNC_INTERVAL_S=5
   AGRIVISION_MAX_AGE_DAYS=7
   EOF
   sudo chown root:root /etc/agrivision-sync.env
   sudo chmod 0600 /etc/agrivision-sync.env
   ```
4. **Dry-run and one-shot test before enabling the service:**
   ```bash
   sudo -u ps-jetson bash -c 'set -a; source /etc/agrivision-sync.env; set +a; /opt/agrivision/edge-sync/.venv/bin/python /opt/agrivision/edge-sync/sync.py --dry-run --once'
   ```
5. **Install and enable the `systemd` unit (`agrivision-sync.service`):**
   ```bash
   sudo cp /opt/agrivision/edge-sync/agrivision-sync.service /etc/systemd/system/agrivision-sync.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now agrivision-sync.service
   ```
6. **Verify service status, `journalctl` logs, and `/api/health`:**
   ```bash
   systemctl status agrivision-sync.service
   journalctl -u agrivision-sync -f -n 50
   curl -fsS https://<your-vercel-domain>/api/health
   ```
   - **Failure behavior summary:**
     - **Disk full (`ENOSPC`):** `save_state()` writes to `state.json.tmp` and preserves `state.json` + `state.json.bak`. If disk is full, it logs `DISK / FS ERROR`, cleans up `.tmp`, and keeps running without corrupting state or local CSV/JPG files.
     - **Network down for hours:** Exponential backoff per file is capped at `300 s` (`5 min` ± jitter). Once connectivity returns, `sync.py` resumes from the exact byte offset in `state.json`.
     - **API returns `401` / `403` (bad or revoked device key):** Logs `AUTH ERROR (HTTP 401/403)` and enters a `900 s` (`15 min`) cooldown (`auth_backoff_until`) so it never retries hot, leaving all local CSV and snapshot files untouched.

---

## 7. Data Hygiene, Query Plans, Backups & Cleanup

### 7.1 Row & Snapshot Sizes per Batch (Measured on Real `SAMPLE 1` Batch)
Measured on batch `6fa6c9cb-706e-4671-8425-090da07cfe1d` (`grain_SAMPLE 1_20261019_061517_rolling10s.csv`, `55` inspection rows, `137` snapshots):

| Resource | Measured on `SAMPLE 1` | Average per Unit | Projected per 1,000 Batches |
| :--- | :--- | :--- | :--- |
| `public.batches` | `1` row (`~320 B`) | `~320 B` / batch | `~0.32 MB` |
| `public.inspection_rows` | `55` rows (`11.2 KB` JSON, `~17 KB` w/ indexes) | `~203 B` JSON (`~310 B` DB) / row | `~17 MB` (at 55 rows/batch) – `~93 MB` (at 300 rows/batch) |
| `public.snapshots` (DB rows) | `137` rows (`~33 KB` w/ indexes) | `~240 B` / snapshot row | `~33 MB` |
| `snapshots` Storage (full JPGs) | `137` files = **`16,090,410 B` (`15.35 MiB`)** | **`114.7 KB`** / full JPG | `~15.0 GB` |
| `snapshots` Storage (`480 px` thumbs) | `137` files = **`3,332,544 B` (`3.18 MiB`)** | **`23.8 KB`** / thumb JPG | `~3.1 GB` |
| **Total per batch (`SAMPLE 1`)** | **`~50 KB` Postgres + `18.52 MiB` Storage** | **`~138.5 KB`** / snapshot pair | **`~50 MB` DB + `~18.1 GB` Storage** |

### 7.2 Index Audit & `EXPLAIN` Plans for the 3 Main Dashboard Queries
All 3 main dashboard queries are covered by existing B-tree indexes in `20261028000001_schema.sql` (no additional indexes are needed). Run these `EXPLAIN (ANALYZE, BUFFERS)` statements in the **Supabase SQL Editor**:

```sql
-- 1. Batch picker / listDashboardBatches (covered by batches_last_data_at_idx)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, mode, device_id, source_name, truck_plate, qc_name,
       started_at, last_data_at, row_count, created_at
FROM public.batches
ORDER BY last_data_at DESC NULLS LAST, created_at DESC
LIMIT 500;
-- Plan: Index Scan using batches_last_data_at_idx on public.batches (0.04..0.12 ms)

-- 2. Batch detail & metrics rows / getDashboardBatchDetail (covered by inspection_rows_batch_id_snapshot_time_idx)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, snapshot_time, plate_number, snapshot_type,
       snapshot_total, estimated_grain_count, mix, mix_raw
FROM public.inspection_rows
WHERE batch_id = '6fa6c9cb-706e-4671-8425-090da07cfe1d'
ORDER BY snapshot_time ASC, id ASC
LIMIT 1000 OFFSET 0;
-- Plan: Index Scan Backward using inspection_rows_batch_id_snapshot_time_idx (55 rows, < 0.25 ms)

-- 3. Snapshot gallery / getDashboardBatchSnapshots (covered by snapshots_batch_id_captured_at_idx)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, batch_id, filename, storage_path, thumb_path, plate_number, captured_at
FROM public.snapshots
WHERE batch_id = '6fa6c9cb-706e-4671-8425-090da07cfe1d'
ORDER BY captured_at DESC NULLS LAST, filename DESC
LIMIT 1000 OFFSET 0;
-- Plan: Index Scan using snapshots_batch_id_captured_at_idx (137 rows, < 0.30 ms)
```

### 7.3 Backups (PITR / Daily Backups) & Restore Procedure
1. **Automated Supabase Backups:**
   - **Pro Plan Daily Backups:** Supabase automatically takes daily physical snapshots retained for 7 days (**Supabase Dashboard → Database → Backups → Scheduled backups**).
   - **Point-in-Time Recovery (PITR):** Enable PITR in **Database → Backups → Point in Time** for 2-minute RPO WAL archiving when production volume warrants it.
2. **On-Demand Logical Backup (CLI):**
   ```bash
   supabase db dump --linked -f backup_schema.sql
   supabase db dump --linked --data-only -f backup_data.sql
   ```
3. **Restore Procedure:**
   - **Dashboard Restore:** Go to **Supabase Dashboard → Database → Backups**, select the target backup or PITR timestamp, and click **Restore**.
   - **Logical Restore (to local or staging DB):**
     ```bash
     psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f backup_schema.sql
     psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f backup_data.sql
     ```
   - **Re-syncing from Jetson:** Because the Jetson retains the raw CSV and snapshot files on disk and all ingest endpoints (`POST /api/ingest/rows` and `pnpm import-csv`) are idempotent, deleting `~/.agrivision-sync/state.json` on the Jetson (with `AGRIVISION_MAX_AGE_DAYS=0`) will re-upload any batches missed since a backup window.

### 7.4 Cleanup Script & SQL for Test Batches, Test Reports, and Revoked Devices
- **CLI Cleanup Script (deletes both Storage objects and DB rows; defaults to `--dry-run`):**
  ```bash
  pnpm cleanup-test-data                          # dry-run: previews test reports, test batches, and revoked devices
  pnpm cleanup-test-data --reports-only --confirm # deletes only test reports (Storage objects + public.reports rows)
  pnpm cleanup-test-data --confirm                # deletes all matched test reports, test batches, and revoked devices
  ```
- **Equivalent SQL Snippet (run in Supabase SQL Editor after removing Storage objects):**
  ```sql
  -- 1. Delete test report rows
  DELETE FROM public.reports
  WHERE batch_id IN (
    SELECT id FROM public.batches
    WHERE source_name ~* '^(grain_(test|nj2|synthetic|smoke)_|test[-_])'
  );

  -- 2. Delete test batches (cascades to inspection_rows, snapshots, and reports)
  DELETE FROM public.batches
  WHERE source_name ~* '^(grain_(test|nj2|synthetic|smoke)_|test[-_])';

  -- 3. Detach and delete revoked devices
  UPDATE public.batches SET device_id = NULL
  WHERE device_id IN (SELECT id FROM public.devices WHERE revoked_at IS NOT NULL);

  DELETE FROM public.devices WHERE revoked_at IS NOT NULL;
  ```

### 7.5 Storage Privacy & Signed URL Verification SQL
Both `snapshots` and `reports` buckets must be private (`public = false`), and all signed URLs generated by the server use a **10-minute (`600 s`) expiry** (`SNAPSHOT_SIGNED_URL_EXPIRY_SEC = 600` in `lib/dashboard/queries.ts` and `REPORT_SIGNED_URL_EXPIRY_SEC = 600` in `lib/report/pdf.ts`). Verify bucket privacy and RLS policies in the **Supabase SQL Editor**:

```sql
-- 1. Verify both buckets exist and are strictly PRIVATE (public = false)
SELECT id, name, public, created_at
FROM storage.buckets
WHERE id IN ('snapshots', 'reports');
-- Expected: 2 rows, both with public = false

-- 2. Verify Storage RLS policies require an active authenticated user (is_active_user())
SELECT policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;
```

---

## 8. Operator & Admin Runbook

### How to Change QC Thresholds & Seed Weights
1. Sign in as an **Admin** user and click **Settings** (`/settings`) in the top bar.
2. Under **Application Settings**, edit:
   - **Thresholds:** `Defect Threshold (wt %)` (`defect_threshold_pct`, default `5.0%`) and `Plate Spread Alert Threshold (%)` (`variance_threshold_pct`, default `10.0%`).
   - **Per-Class Seed Weights (ASSUMED, not measured):** `good_seed_weight_g` (`0.31`), `immature_seed_weight_g` (`0.2`), `sm_seed_weight_g` (`0.25`), `dc_seed_weight_g` (`0.3`).
   - **Display / Timing:** `active_ttl_s` (`300`), `refresh_sec` (`5`), `metrics_window_rows` (`0` = all rows, `200` = legacy window), `snapshot_filename_tz` (`UTC` or `Asia/Bangkok`).
3. Click **Save Settings**. Changes take effect immediately on the next dashboard refresh and PDF report generation, and every modification is recorded with user email, timestamp, old value, and new value in the **Settings Audit Log** table on the same page.

### Troubleshooting Common Errors

| Symptom / Error | Root Cause | Resolution |
| :--- | :--- | :--- |
| `Cannot find project ref. Have you run supabase link?` | Supabase CLI is not linked in `ex-db/supabase/.temp/project-ref`. | Run `cd ex-db && supabase link --project-ref emqooadipseotdbzqtbd`, then `supabase db push --linked`. |
| `edge-sync` logs `AUTH ERROR (HTTP 401/403)` and pauses for `900s` | `AGRIVISION_DEVICE_KEY` in `/etc/agrivision-sync.env` is missing, wrong, or was revoked in `/settings`. | Create a new device key in `/settings → Edge Devices` (or `pnpm create-device <name>`), update `/etc/agrivision-sync.env`, and run `sudo systemctl restart agrivision-sync`. |
| Dashboard badge shows `SUBSCRIBED (0 events)` or `ERROR` when new rows arrive | (a) Migration `20261028000004_realtime_publication.sql` or `000010` not pushed, or (b) user profile is missing/disabled. | Run `supabase db push --linked` and verify the logged-in user has an active row (`disabled_at IS NULL`) in `public.profiles`. Note: the `5 s` server poll continues updating the UI even if WebSockets are blocked by a corporate firewall. |
| `supabase db push` says `Remote migration versions not found in local migrations directory` or out of sync | A migration was recorded in `supabase_migrations.schema_migrations` out of order. | Run `supabase migration list --linked` to inspect applied versions. Use `supabase migration repair --status reverted <version>` (or `applied`) to align history, then `supabase db push --linked`. Never edit already-pushed migration files. |
| `POST /api/admin/import` returns `503 route_disabled` | `ADMIN_IMPORT_TOKEN` is unset or shorter than 32 characters. | Generate a token with `pnpm gen-token` and set `ADMIN_IMPORT_TOKEN` in `.env.local` / Vercel Environment Variables. |
