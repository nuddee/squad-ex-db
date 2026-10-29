-- SQL-level trigger verification for batches.row_count / last_data_at / started_at
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/test_batch_stats_trigger.sql
--
-- Runs inside a transaction and rolls back at the end so it leaves no test data behind.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_batch_id      uuid;
  v_row_count     int;
  v_actual_count  int;
  v_last_data_at  timestamptz;
  v_actual_max    timestamptz;
  v_started_at    timestamptz;
  v_actual_min    timestamptz;
begin
  -- 1. Create a manual-import batch (device_id IS NULL)
  insert into batches (mode, device_id, source_name, truck_plate, qc_name)
  values ('grain', null, 'grain_trigger_test_rolling10s.csv', 'TEST-9999', 'SQLTest')
  returning id into v_batch_id;

  -- 2. Insert 3 initial rows (10:00:05, 10:00:10, 10:00:15)
  insert into inspection_rows (
    batch_id, snapshot_time, plate_number, snapshot_type, snapshot_total, estimated_grain_count, mix, mix_raw
  ) values
    (v_batch_id, '2026-10-28T10:00:05+07:00', 1, 'last_frame', 100, 100, '{"good":95,"immature":5}'::jsonb, 'good=95, immature=5'),
    (v_batch_id, '2026-10-28T10:00:10+07:00', 1, 'last_frame', 110, 110, '{"good":100,"immature":10}'::jsonb, 'good=100, immature=10'),
    (v_batch_id, '2026-10-28T10:00:15+07:00', 2, 'last_frame', 120, 120, '{"good":115,"immature":5}'::jsonb, 'good=115, immature=5');

  select row_count, last_data_at, started_at
    into v_row_count, v_last_data_at, v_started_at
    from batches where id = v_batch_id;

  select count(*)::int, max(snapshot_time), min(snapshot_time)
    into v_actual_count, v_actual_max, v_actual_min
    from inspection_rows where batch_id = v_batch_id;

  if v_row_count is distinct from v_actual_count or v_row_count <> 3 then
    raise exception 'Step 2 failed: expected row_count = % (3), got %', v_actual_count, v_row_count;
  end if;
  if v_last_data_at is distinct from v_actual_max then
    raise exception 'Step 2 failed: expected last_data_at = %, got %', v_actual_max, v_last_data_at;
  end if;
  if v_started_at is distinct from v_actual_min then
    raise exception 'Step 2 failed: expected started_at = %, got %', v_actual_min, v_started_at;
  end if;
  raise notice 'PASS Step 2 (initial insert of 3 rows): row_count=%, started_at=%, last_data_at=%',
    v_row_count, v_started_at, v_last_data_at;

  -- 3. Mixed upsert: re-send 2 existing rows (conflict -> DO UPDATE) + 1 new row at 10:00:25
  --    Total distinct rows in inspection_rows must be 4 (NOT 6).
  insert into inspection_rows (
    batch_id, snapshot_time, plate_number, snapshot_type, snapshot_total, estimated_grain_count, mix, mix_raw
  ) values
    (v_batch_id, '2026-10-28T10:00:10+07:00', 1, 'last_frame', 115, 115, '{"good":105,"immature":10}'::jsonb, 'good=105, immature=10'),
    (v_batch_id, '2026-10-28T10:00:15+07:00', 2, 'last_frame', 125, 125, '{"good":120,"immature":5}'::jsonb, 'good=120, immature=5'),
    (v_batch_id, '2026-10-28T10:00:25+07:00', 2, 'last_frame', 130, 130, '{"good":125,"immature":5}'::jsonb, 'good=125, immature=5')
  on conflict (batch_id, snapshot_time, plate_number, snapshot_type) do update set
    snapshot_total = excluded.snapshot_total,
    estimated_grain_count = excluded.estimated_grain_count,
    mix = excluded.mix,
    mix_raw = excluded.mix_raw;

  select row_count, last_data_at, started_at
    into v_row_count, v_last_data_at, v_started_at
    from batches where id = v_batch_id;

  select count(*)::int, max(snapshot_time), min(snapshot_time)
    into v_actual_count, v_actual_max, v_actual_min
    from inspection_rows where batch_id = v_batch_id;

  if v_row_count is distinct from v_actual_count or v_row_count <> 4 then
    raise exception 'Step 3 failed (double count on upsert!): expected row_count = % (4), got %', v_actual_count, v_row_count;
  end if;
  if v_last_data_at is distinct from v_actual_max then
    raise exception 'Step 3 failed: expected last_data_at = %, got %', v_actual_max, v_last_data_at;
  end if;
  if v_started_at is distinct from v_actual_min then
    raise exception 'Step 3 failed: expected started_at = %, got %', v_actual_min, v_started_at;
  end if;
  raise notice 'PASS Step 3 (mixed upsert 2 existing + 1 new): row_count=%, started_at=%, last_data_at=%',
    v_row_count, v_started_at, v_last_data_at;

  -- 4. Pure update via ON CONFLICT (0 new rows, 2 updated rows) + direct UPDATE of snapshot_time
  --    Exercises rows_stats_upd when rows_stats_ins has 0 rows.
  insert into inspection_rows (
    batch_id, snapshot_time, plate_number, snapshot_type, snapshot_total, estimated_grain_count, mix, mix_raw
  ) values
    (v_batch_id, '2026-10-28T10:00:05+07:00', 1, 'last_frame', 101, 101, '{"good":96,"immature":5}'::jsonb, 'good=96, immature=5'),
    (v_batch_id, '2026-10-28T10:00:25+07:00', 2, 'last_frame', 135, 135, '{"good":130,"immature":5}'::jsonb, 'good=130, immature=5')
  on conflict (batch_id, snapshot_time, plate_number, snapshot_type) do update set
    snapshot_total = excluded.snapshot_total,
    estimated_grain_count = excluded.estimated_grain_count,
    mix = excluded.mix,
    mix_raw = excluded.mix_raw;

  -- Also move the latest row's snapshot_time forward via UPDATE to verify rows_stats_upd updates last_data_at
  update inspection_rows
     set snapshot_time = '2026-10-28T10:00:35+07:00'
   where batch_id = v_batch_id
     and snapshot_time = '2026-10-28T10:00:25+07:00';

  select row_count, last_data_at, started_at
    into v_row_count, v_last_data_at, v_started_at
    from batches where id = v_batch_id;

  select count(*)::int, max(snapshot_time), min(snapshot_time)
    into v_actual_count, v_actual_max, v_actual_min
    from inspection_rows where batch_id = v_batch_id;

  if v_row_count is distinct from v_actual_count or v_row_count <> 4 then
    raise exception 'Step 4 failed: expected row_count = % (4), got %', v_actual_count, v_row_count;
  end if;
  if v_last_data_at is distinct from v_actual_max then
    raise exception 'Step 4 failed: expected last_data_at = %, got %', v_actual_max, v_last_data_at;
  end if;
  if v_started_at is distinct from v_actual_min then
    raise exception 'Step 4 failed: expected started_at = %, got %', v_actual_min, v_started_at;
  end if;
  raise notice 'PASS Step 4 (pure conflict update + timestamp update): row_count=%, started_at=%, last_data_at=%',
    v_row_count, v_started_at, v_last_data_at;
end $$;

rollback;
