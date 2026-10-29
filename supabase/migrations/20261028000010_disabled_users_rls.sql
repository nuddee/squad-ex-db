-- Phase 7 security: disabled users lose ALL access (RLS + Realtime + storage), viewer becomes the default role.
-- Policy names verified against 20261028000002_rls_storage.sql:
--   tables:  read_batches, read_rows, read_snapshots, read_reports, read_settings, read_own_profile, insert_reports
--   storage: read_snapshot_files, read_report_files, write_report_files
-- Requires profiles.disabled_at (added idempotently here as well as in 20261028000008).

alter table public.profiles
  add column if not exists disabled_at timestamptz;

-- Default role for new profiles is 'viewer' (old 'operator' rows stay valid; see README: operator == viewer).
alter table public.profiles
  alter column role set default 'viewer';

-- Active user = has a profile row that is not disabled. A user WITHOUT a profile row is NOT active (fail closed;
-- handle_new_user() creates the row for every new auth user).
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and disabled_at is null
  );
$$;
revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated, service_role;

-- Delete a user's auth sessions (cascades to refresh tokens) so existing tokens stop validating.
-- service_role only; called by the admin "disable user" flow after the Auth ban is set.
create or replace function public.revoke_user_sessions(p_user_id uuid) returns integer
language plpgsql security definer set search_path = public, auth as $$
declare n integer;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- Read policies: authenticated AND active.
drop policy if exists read_batches on public.batches;
create policy read_batches on public.batches
  for select to authenticated using (public.is_active_user());

drop policy if exists read_rows on public.inspection_rows;
create policy read_rows on public.inspection_rows
  for select to authenticated using (public.is_active_user());

drop policy if exists read_snapshots on public.snapshots;
create policy read_snapshots on public.snapshots
  for select to authenticated using (public.is_active_user());

drop policy if exists read_reports on public.reports;
create policy read_reports on public.reports
  for select to authenticated using (public.is_active_user());

drop policy if exists read_settings on public.app_settings;
create policy read_settings on public.app_settings
  for select to authenticated using (public.is_active_user());

-- A disabled user cannot even read their own profile row (admins still can: is_admin() requires active).
drop policy if exists read_own_profile on public.profiles;
create policy read_own_profile on public.profiles
  for select to authenticated
  using ((user_id = auth.uid() and disabled_at is null) or public.is_admin());

-- Write policy for reports: only active users, only as themselves.
drop policy if exists insert_reports on public.reports;
create policy insert_reports on public.reports
  for insert to authenticated
  with check (created_by = auth.uid() and public.is_active_user());

-- Storage objects
drop policy if exists read_snapshot_files on storage.objects;
create policy read_snapshot_files on storage.objects
  for select to authenticated
  using (bucket_id = 'snapshots' and public.is_active_user());

drop policy if exists read_report_files on storage.objects;
create policy read_report_files on storage.objects
  for select to authenticated
  using (bucket_id = 'reports' and public.is_active_user());

drop policy if exists write_report_files on storage.objects;
create policy write_report_files on storage.objects
  for insert to authenticated
  with check (bucket_id = 'reports' and public.is_active_user());
