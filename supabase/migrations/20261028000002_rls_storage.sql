-- RLS on every table. Device writes use the service role (bypasses RLS) inside Route Handlers.
create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin');
$$;

alter table devices         enable row level security;
alter table batches         enable row level security;
alter table inspection_rows enable row level security;
alter table snapshots       enable row level security;
alter table profiles        enable row level security;
alter table reports         enable row level security;
alter table app_settings    enable row level security;

-- Authenticated users can read
create policy read_batches   on batches         for select to authenticated using (true);
create policy read_rows      on inspection_rows for select to authenticated using (true);
create policy read_snapshots on snapshots       for select to authenticated using (true);
create policy read_reports   on reports         for select to authenticated using (true);
create policy read_settings  on app_settings    for select to authenticated using (true);
create policy read_own_profile on profiles      for select to authenticated using (user_id = auth.uid() or is_admin());

-- Operators can record reports they generate
create policy insert_reports on reports for insert to authenticated with check (created_by = auth.uid());

-- Admin only
create policy admin_settings on app_settings for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_devices  on devices      for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_profiles on profiles     for update to authenticated using (is_admin()) with check (is_admin());
create policy admin_delete_reports on reports for delete to authenticated using (is_admin());

-- Realtime for the dashboard
alter publication supabase_realtime add table inspection_rows, snapshots;

-- Private buckets
insert into storage.buckets (id, name, public) values
  ('snapshots', 'snapshots', false),
  ('reports',   'reports',   false)
on conflict (id) do nothing;

create policy read_snapshot_files on storage.objects for select to authenticated
  using (bucket_id = 'snapshots');
create policy read_report_files on storage.objects for select to authenticated
  using (bucket_id = 'reports');
create policy write_report_files on storage.objects for insert to authenticated
  with check (bucket_id = 'reports');
