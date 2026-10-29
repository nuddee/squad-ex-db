-- Phase 6: Expose legacy PDF report footer strings as configurable app_settings keys.
-- Uses only (key, value, description) matching the real public.app_settings schema.

insert into public.app_settings (key, value, description) values
  ('report_footer_left', 'SQAUD · Grain QC Report', 'Left footer label on generated QC PDF reports'),
  ('report_form_code',   'FM-JJR',                  'Form code shown in the right footer on generated QC PDF reports')
on conflict (key) do nothing;
