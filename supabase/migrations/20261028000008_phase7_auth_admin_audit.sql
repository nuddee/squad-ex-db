-- Phase 7: Auth, Settings Audit, Device Telemetry, and Profile Role/Disable Support
-- Verified against real remote schema (20261028000001_schema.sql through 20261028000007):
-- - devices: (id, name, api_key_hash, created_at, revoked_at) -> add last_seen_at if not exists
-- - profiles: (user_id, role, created_at) -> add disabled_at, allow role in ('viewer','operator','admin')
-- - app_settings: (key, value, description) -> add updated_at, updated_by
-- - settings_audit_log: new audit table recording who changed what setting and when

-- 1. Ensure devices.last_seen_at exists on remote DB
alter table public.devices
  add column if not exists last_seen_at timestamptz;

-- 2. Extend profiles with disabled_at and allow 'viewer' alongside 'operator' and 'admin'
alter table public.profiles
  add column if not exists disabled_at timestamptz;

do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'profiles'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('viewer', 'operator', 'admin'));

-- 3. Update is_admin() so disabled accounts are never treated as admin
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles
    where user_id = auth.uid()
      and role = 'admin'
      and disabled_at is null
  );
$$;

drop policy if exists admin_insert_profiles on public.profiles;
create policy admin_insert_profiles on public.profiles
  for insert to authenticated
  with check (public.is_admin());

-- 4. Add audit metadata columns to app_settings (previously only key, value, description existed)
alter table public.app_settings
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid references auth.users(id) on delete set null;

-- 5. Create settings_audit_log table with strict admin-only RLS
create table if not exists public.settings_audit_log (
  id bigint generated always as identity primary key,
  setting_key text not null,
  old_value text,
  new_value text not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_email text,
  changed_at timestamptz not null default now()
);

create index if not exists settings_audit_log_changed_at_idx
  on public.settings_audit_log (changed_at desc);

alter table public.settings_audit_log enable row level security;

drop policy if exists admin_settings_audit on public.settings_audit_log;
create policy admin_settings_audit on public.settings_audit_log
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 6. Ensure all configurable app_settings keys exist (using only key, value, description)
insert into public.app_settings (key, value, description) values
  ('good_seed_weight_g',        '0.31',                    'Weight of one good seed (g) — ASSUMED, not measured'),
  ('immature_seed_weight_g',    '0.20',                    'Weight of one immature seed (g) — ASSUMED, not measured'),
  ('sm_seed_weight_g',          '0.25',                    'Weight of one spoiled/mold seed (g) — ASSUMED, not measured'),
  ('dc_seed_weight_g',          '0.30',                    'Weight of one discolor seed (g) — ASSUMED, not measured'),
  ('total_sample_weight_g',     '500',                     'Reference sample weight (g)'),
  ('weight_sanity_tol',         '0',                       'Legacy ±25% 500g sanity check tolerance (0 = disabled under per-class weight model)'),
  ('defect_warn_threshold_pct', '10.0',                    'Alert when weight-based defect % >= this'),
  ('plate_variance_spread_pct', '8.0',                     'High variance when defect % spread >= this'),
  ('active_ttl_s',              '60',                      'Batch is active if last data within this many seconds'),
  ('metrics_window_rows',       '0',                       'Rows used for metrics/PDF; 0 = all (legacy parity = 200)'),
  ('refresh_sec',               '5',                       'Dashboard fallback refetch interval'),
  ('expected_plates',           '5',                       'Expected plates per batch'),
  ('snapshot_filename_tz',      'UTC',                     'Timezone of YYYYMMDD_HHMMSS timestamps in snapshot filenames (UTC or Asia/Bangkok)'),
  ('report_footer_left',        'SQAUD · Grain QC Report', 'Left footer label on generated QC PDF reports'),
  ('report_form_code',          'FM-JJR',                  'Form code shown in the right footer on generated QC PDF reports')
on conflict (key) do nothing;
