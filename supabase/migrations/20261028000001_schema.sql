-- AgriVision QC: core schema
create extension if not exists pgcrypto;

create table devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_key_hash text not null unique,      -- SHA-256 hex of the device key
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table batches (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'grain',
  device_id uuid references devices(id),
  source_name text not null,              -- original CSV file name
  truck_plate text not null default '',
  qc_name text not null default '',
  started_at timestamptz,
  last_data_at timestamptz,               -- maintained by trigger
  row_count int not null default 0,       -- maintained by trigger
  created_at timestamptz not null default now(),
  unique (device_id, source_name)
);
create index on batches (last_data_at desc);
create index on batches (truck_plate);

create table inspection_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references batches(id) on delete cascade,
  snapshot_time timestamptz not null,
  plate_number int not null default 1,
  snapshot_type text not null default 'last_frame',
  snapshot_total int not null default 0,
  estimated_grain_count int not null default 0,
  mix jsonb not null default '{}',        -- e.g. {"good":120,"immature":30,"sm":5,"dc":2}
  mix_raw text not null default '',       -- original snapshot_mix_summary
  unique (batch_id, snapshot_time, plate_number, snapshot_type)
);
create index on inspection_rows (batch_id, snapshot_time desc);

create table snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references batches(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  thumb_path text,
  plate_number int,
  captured_at timestamptz,
  unique (batch_id, filename)
);
create index on snapshots (batch_id, captured_at desc);

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'operator' check (role in ('operator','admin')),
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references batches(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  params jsonb not null default '{}',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index on reports (batch_id, created_at desc);

create table app_settings (
  key text primary key,
  value numeric not null,
  description text
);

-- Auto-create an operator profile for every new user
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Keep batches.last_data_at / row_count / started_at current (statement-level, handles bulk upserts)
create function refresh_batch_stats() returns trigger
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

create trigger rows_stats_ins after insert on inspection_rows
  referencing new table as changed for each statement execute function refresh_batch_stats();

create trigger rows_stats_upd after update on inspection_rows
  referencing new table as changed for each statement execute function refresh_batch_stats();

-- Cascade deletes can leave nothing to refresh; separate delete trigger
create function refresh_batch_stats_del() returns trigger
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
create trigger rows_stats_del after delete on inspection_rows
  referencing old table as changed for each statement execute function refresh_batch_stats_del();

-- Snapshot -> nearest row match (±15 s, same plate preferred, fallback any plate). One query, no N+1.
create function snapshot_row_matches(p_batch uuid, p_window_s int default 15)
returns table (
  snapshot_id uuid, row_id bigint, row_plate int, row_time timestamptz, delta_s double precision
)
language sql stable as $$
  select s.id, m.id, m.plate_number, m.snapshot_time, m.delta
  from snapshots s
  left join lateral (
    select r.id, r.plate_number, r.snapshot_time,
           abs(extract(epoch from (r.snapshot_time - s.captured_at))) as delta
    from inspection_rows r
    where r.batch_id = p_batch
      and s.captured_at is not null
      and abs(extract(epoch from (r.snapshot_time - s.captured_at))) <= p_window_s
    order by (r.plate_number is not distinct from s.plate_number) desc, delta asc
    limit 1
  ) m on true
  where s.batch_id = p_batch;
$$;
