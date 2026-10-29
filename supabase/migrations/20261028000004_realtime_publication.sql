-- Idempotently ensure inspection_rows and snapshots belong to the supabase_realtime publication.
-- Safe to run even if 20261028000002_rls_storage.sql already added them.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inspection_rows'
  ) then
    alter publication supabase_realtime add table public.inspection_rows;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'snapshots'
  ) then
    alter publication supabase_realtime add table public.snapshots;
  end if;
end $$;
