-- 1. Track device last_seen_at for ingest telemetry.
-- 2. Fix manual-import (device_id IS NULL) batch idempotency across all Postgres versions:
--    In standard UNIQUE (device_id, source_name), NULLs are distinct, so manual imports with
--    device_id = NULL could create duplicate batches.
--    - On Postgres >= 15 (Supabase default), use `UNIQUE NULLS NOT DISTINCT (device_id, source_name)`
--       PLUS a partial unique index on `(source_name) WHERE device_id IS NULL`.
--    - On Postgres < 15 (where `NULLS NOT DISTINCT` syntax is not supported), fall back cleanly to
--      `UNIQUE (device_id, source_name)` + `CREATE UNIQUE INDEX batches_manual_source_name_idx ON batches (source_name) WHERE device_id IS NULL`
--      and raise a clear NOTICE (or fail clearly if neither can be created).
-- 3. Ensure batches.row_count / last_data_at / started_at refresh on UPDATE (upsert-on-conflict)
--    as well as INSERT.

alter table devices
  add column if not exists last_seen_at timestamptz;

alter table batches
  drop constraint if exists batches_device_id_source_name_key;

do $$
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute 'alter table batches add constraint batches_device_id_source_name_key unique nulls not distinct (device_id, source_name)';
  else
    raise notice 'Postgres < 15 detected (server_version_num = %): falling back to UNIQUE (device_id, source_name) + partial unique index WHERE device_id IS NULL',
      current_setting('server_version_num');
    execute 'alter table batches add constraint batches_device_id_source_name_key unique (device_id, source_name)';
  end if;
end $$;

-- Works on all Postgres versions and guarantees uniqueness when device_id IS NULL:
create unique index if not exists batches_manual_source_name_idx
  on batches (source_name)
  where device_id is null;

-- 3. Recompute batches.row_count / last_data_at / started_at from inspection_rows for affected
--    batch_ids on both INSERT and UPDATE (upsert-on-conflict). Both triggers bind the transition
--    table name `changed` (`referencing new table as changed`) and `refresh_batch_stats()`
--    recomputes count(*), max(snapshot_time), and min(snapshot_time) rather than incrementing.
create or replace function refresh_batch_stats() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update batches b set
    row_count = s.cnt,
    last_data_at = s.last_at,
    started_at = s.first_at
  from (
    select batch_id, count(*) cnt, max(snapshot_time) last_at, min(snapshot_time) first_at
    from inspection_rows
    where batch_id in (select distinct batch_id from changed)
    group by batch_id
  ) s
  where b.id = s.batch_id;
  return null;
end $$;

drop trigger if exists rows_stats_ins on inspection_rows;
create trigger rows_stats_ins after insert on inspection_rows
  referencing new table as changed for each statement execute function refresh_batch_stats();

drop trigger if exists rows_stats_upd on inspection_rows;
create trigger rows_stats_upd after update on inspection_rows
  referencing new table as changed for each statement execute function refresh_batch_stats();

-- 4. Ensure private storage buckets exist and are private, and seed default app_settings
--    so `supabase db push` against a remote project sets up both without requiring a separate seed step.
insert into storage.buckets (id, name, public) values
  ('snapshots', 'snapshots', false),
  ('reports',   'reports',   false)
on conflict (id) do update set public = false;

insert into app_settings (key, value, description) values
  ('good_seed_weight_g',        0.31, 'Weight of one good seed (g) — ASSUMED, not measured'),
  ('immature_seed_weight_g',    0.20, 'Weight of one immature seed (g) — ASSUMED, not measured'),
  ('sm_seed_weight_g',          0.25, 'Weight of one spoiled/mold seed (g) — ASSUMED, not measured'),
  ('dc_seed_weight_g',          0.30, 'Weight of one discolor seed (g) — ASSUMED, not measured'),
  ('total_sample_weight_g',     500,  'Expected total sample weight (g) — used for ±25% sanity check only'),
  ('defect_warn_threshold_pct', 10.0, 'Alert when weight-based defect % >= this'),
  ('plate_variance_spread_pct', 8.0,  'High variance when defect % spread >= this'),
  ('active_ttl_s',              60,   'Batch is active if last data within this many seconds'),
  ('metrics_window_rows',       0,    'Rows used for metrics/PDF; 0 = all (legacy parity = 200)'),
  ('refresh_sec',               5,    'Dashboard fallback refetch interval'),
  ('expected_plates',           5,    'Expected plates per batch')
on conflict (key) do nothing;
