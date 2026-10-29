insert into app_settings (key, value, description) values
  ('good_seed_weight_g',        '0.31', 'Weight of one good seed (g) — ASSUMED, not measured'),
  ('immature_seed_weight_g',    '0.20', 'Weight of one immature seed (g) — ASSUMED, not measured'),
  ('sm_seed_weight_g',          '0.25', 'Weight of one spoiled/mold seed (g) — ASSUMED, not measured'),
  ('dc_seed_weight_g',          '0.30', 'Weight of one discolor seed (g) — ASSUMED, not measured'),
  ('total_sample_weight_g',     '500',  'Reference sample weight (g)'),
  ('weight_sanity_tol',         '0',    'Legacy ±25% 500g sanity check tolerance (0 = disabled under per-class weight model)'),
  ('defect_warn_threshold_pct', '10.0', 'Alert when weight-based defect % >= this'),
  ('plate_variance_spread_pct', '8.0',  'High variance when defect % spread >= this'),
  ('active_ttl_s',              '60',   'Batch is active if last data within this many seconds'),
  ('metrics_window_rows',       '0',    'Rows used for metrics/PDF; 0 = all (legacy parity = 200)'),
  ('refresh_sec',               '5',    'Dashboard fallback refetch interval'),
  ('expected_plates',           '5',    'Expected plates per batch'),
  ('snapshot_filename_tz',      'UTC',  'Timezone of YYYYMMDD_HHMMSS timestamps in snapshot filenames (UTC or Asia/Bangkok)'),
  ('report_footer_left',        'SQAUD · Grain QC Report', 'Left footer label on generated QC PDF reports'),
  ('report_form_code',          'FM-JJR',                  'Form code shown in the right footer on generated QC PDF reports')
on conflict (key) do nothing;
