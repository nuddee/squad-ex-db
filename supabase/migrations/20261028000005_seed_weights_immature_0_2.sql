-- Seed all four per-class seed weight defaults in `app_settings` (editable via `app_settings`)
-- and update any existing immature seed weight row (0.1 -> 0.2) on already-deployed databases.
-- Note: All four weights are ASSUMED, not measured (WEIGHT_VALUES_MEASURED = false).

insert into app_settings (key, value, description) values
  ('good_seed_weight_g',     0.31, 'Weight of one good seed (g) — ASSUMED, not measured'),
  ('immature_seed_weight_g', 0.20, 'Weight of one immature seed (g) — ASSUMED, not measured'),
  ('sm_seed_weight_g',       0.25, 'Weight of one spoiled/mold seed (g) — ASSUMED, not measured'),
  ('dc_seed_weight_g',       0.30, 'Weight of one discolor seed (g) — ASSUMED, not measured')
on conflict (key) do nothing;

update app_settings
set value = 0.2,
    description = 'Weight of one immature seed (g) — ASSUMED, not measured'
where key in ('immature_seed_weight_g', 'immature_weight_g');
