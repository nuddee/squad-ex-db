-- Repair migration for 20261028000003_batches_nulls_not_distinct.sql.
-- A dry check showed devices.last_seen_at missing on the remote DB although 003 was marked applied,
-- so every object 003 creates is re-asserted here, idempotently. 003 itself is NOT edited.
--
-- Objects created by 003 (checked below):
--   1. column  public.devices.last_seen_at
--   2. constraint batches_device_id_source_name_key  UNIQUE NULLS NOT DISTINCT (device_id, source_name)  [PG >= 15]
--   3. unique index batches_manual_source_name_idx   ON batches (source_name) WHERE device_id IS NULL
--   4. function refresh_batch_stats()                 (recompute count / max / min per batch)
--   5. triggers rows_stats_ins, rows_stats_upd        on inspection_rows (statement level, transition table `changed`)
--   6. private storage buckets snapshots, reports
--   7. app_settings seed keys (values are text since 20261028000006)
-- Also re-asserted from 001 because it is part of the same stats machinery:
--   8. function refresh_batch_stats_del() + trigger rows_stats_del
--
-- NOTE: if duplicate batches with device_id IS NULL and the same source_name already exist, creating
-- constraint (2) / index (3) fails by design; dedupe them first.

-- 1. devices.last_seen_at
alter table public.devices
  add column if not exists last_seen_at timestamptz;

-- 2. batches unique constraint with NULLS NOT DISTINCT (re-created only when missing or not NULLS NOT DISTINCT)
do $$
declare
  has_con boolean;
  nnd boolean := false;
begin
  select exists (
    select 1 from pg_constraint
    where conname = 'batches_device_id_source_name_key'
      and conrelid = 'public.batches'::regclass
      and contype = 'u'
  ) into has_con;

  if current_setting('server_version_num')::int >= 150000 then
    if has_con then
      execute $q$
        select coalesce(bool_or(i.indnullsnotdistinct), false)
        from pg_constraint c
        join pg_index i on i.indexrelid = c.conindid
        where c.conname = 'batches_device_id_source_name_key'
          and c.conrelid = 'public.batches'::regclass
      $q$ into nnd;
    end if;

    if not has_con or not nnd then
      execute 'alter table public.batches drop constraint if exists batches_device_id_source_name_key';
      execute 'alter table public.batches add constraint batches_device_id_source_name_key unique nulls not distinct (device_id, source_name)';
    end if;
  elsif not has_con then
    raise notice 'Postgres < 15: using plain UNIQUE (device_id, source_name) + partial index for NULL device_id';
    execute 'alter table public.batches add constraint batches_device_id_source_name_key unique (device_id, source_name)';
  end if;
end $$;

-- 3. partial unique index for manual imports (device_id IS NULL)
create unique index if not exists batches_manual_source_name_idx
  on public.batches (source_name)
  where device_id is null;

-- 4. refresh_batch_stats()
create or replace function public.refresh_batch_stats() returns trigger
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

-- 5. insert / update triggers
drop trigger if exists rows_stats_ins on public.inspection_rows;
create trigger rows_stats_ins after insert on public.inspection_rows
  referencing new table as changed for each statement execute function public.refresh_batch_stats();

drop trigger if exists rows_stats_upd on public.inspection_rows;
create trigger rows_stats_upd after update on public.inspection_rows
  referencing new table as changed for each statement execute function public.refresh_batch_stats();

-- 8. delete trigger (from 001)
create or replace function public.refresh_batch_stats_del() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update batches b set
    row_count = coalesce(s.cnt, 0),
    last_data_at = s.last_at
  from (select id from batches where id in (select distinct batch_id from changed)) t
  left join (
    select batch_id, count(*) cnt, max(snapshot_time) last_at
    from inspection_rows group by batch_id
  ) s on s.batch_id = t.id
  where b.id = t.id;
  return null;
end $$;

drop trigger if exists rows_stats_del on public.inspection_rows;
create trigger rows_stats_del after delete on public.inspection_rows
  referencing old table as changed for each statement execute function public.refresh_batch_stats_del();

-- 6. private buckets
insert into storage.buckets (id, name, public) values
  ('snapshots', 'snapshots', false),
  ('reports',   'reports',   false)
on conflict (id) do update set public = false;

-- 7. app_settings seeds (never overwrite existing values)
insert into public.app_settings (key, value, description) values
  ('good_seed_weight_g',        '0.31', 'Weight of one good seed (g) — ASSUMED, not measured'),
  ('immature_seed_weight_g',    '0.20', 'Weight of one immature seed (g) — ASSUMED, not measured'),
  ('sm_seed_weight_g',          '0.25', 'Weight of one spoiled/mold seed (g) — ASSUMED, not measured'),
  ('dc_seed_weight_g',          '0.30', 'Weight of one discolor seed (g) — ASSUMED, not measured'),
  ('total_sample_weight_g',     '500',  'Reference sample weight (g)'),
  ('defect_warn_threshold_pct', '10.0', 'Alert when weight-based defect % >= this'),
  ('plate_variance_spread_pct', '8.0',  'High variance when defect % spread >= this'),
  ('active_ttl_s',              '60',   'Batch is active if last data within this many seconds'),
  ('metrics_window_rows',       '0',    'Rows used for metrics/PDF; 0 = all (legacy parity = 200)'),
  ('refresh_sec',               '5',    'Dashboard fallback refetch interval'),
  ('expected_plates',           '5',    'Expected plates per batch')
on conflict (key) do nothing;
