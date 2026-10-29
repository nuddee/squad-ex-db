-- Phase 5:
-- 1. Allow `app_settings.value` to store string settings (such as `snapshot_filename_tz = 'UTC'`)
--    as well as numeric settings.
-- 2. Seed `snapshot_filename_tz = 'UTC'` (verified against real device CSV + snapshot filenames:
--    snapshot filenames are formatted with `datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')`,
--    yielding a constant 7-hour offset vs Asia/Bangkok wall-clock).
-- 3. Seed `weight_sanity_tol = '0'` to disable the obsolete ±25% check against a fixed 500 g total.
-- 4. Update `snapshot_row_matches` so it filters to valid inspection rows (`last_frame`, `plate_end`)
--    with `snapshot_total > 0` and prioritizes rows on the same plate first (only falling back to
--    other plates when the snapshot has no plate number or that plate has no rows in the batch).

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_settings'
      and column_name = 'value'
      and data_type <> 'text'
  ) then
    alter table public.app_settings
      alter column value type text using value::text;
  end if;
end $$;

insert into public.app_settings (key, value, description) values
  ('snapshot_filename_tz', 'UTC', 'Timezone of YYYYMMDD_HHMMSS timestamps in snapshot filenames (UTC or Asia/Bangkok)'),
  ('weight_sanity_tol',    '0',   'Legacy ±25% 500g sanity check tolerance (0 = disabled under per-class weight model)')
on conflict (key) do update set
  value = excluded.value,
  description = excluded.description;

drop function if exists public.snapshot_row_matches(uuid, int);
create or replace function public.snapshot_row_matches(p_batch uuid, p_window_s int default 15)
returns table (
  snapshot_id uuid,
  row_id bigint,
  row_plate int,
  row_time timestamptz,
  delta_s double precision,
  approximate boolean
)
language sql stable as $$
  select
    s.id,
    m.id,
    m.plate_number,
    m.snapshot_time,
    m.delta,
    (m.id is not null and s.plate_number is not null and m.plate_number <> s.plate_number) as approximate
  from public.snapshots s
  left join lateral (
    select r.id, r.plate_number, r.snapshot_time,
           abs(extract(epoch from (r.snapshot_time - s.captured_at))) as delta
    from public.inspection_rows r
    where r.batch_id = p_batch
      and r.snapshot_type in ('last_frame', 'plate_end')
      and r.snapshot_total > 0
      and s.captured_at is not null
      and (
        s.plate_number is null
        or r.plate_number = s.plate_number
        or not exists (
          select 1
          from public.inspection_rows r2
          where r2.batch_id = p_batch
            and r2.snapshot_type in ('last_frame', 'plate_end')
            and r2.snapshot_total > 0
            and r2.plate_number = s.plate_number
        )
      )
      and abs(extract(epoch from (r.snapshot_time - s.captured_at))) <= p_window_s
    order by delta asc
    limit 1
  ) m on true
  where s.batch_id = p_batch;
$$;
