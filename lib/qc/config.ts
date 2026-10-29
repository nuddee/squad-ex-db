/** Mode/class configuration. Add new modes here; components must read from this, not hard-code classes. */

export interface QcClass {
  key: string;
  label: string;
  color: string;
}

export interface QcMode {
  id: string;
  label: string;
  icon: string;
  imageExts: readonly string[];
  /** Order matters: "good" is the reference class, the rest are defects. */
  classes: readonly QcClass[];
}

export const MODES: Record<string, QcMode> = {
  grain: {
    id: "grain",
    label: "Grain Analysis",
    icon: "🌾",
    imageExts: [".jpg", ".jpeg", ".png", ".bmp", ".webp"],
    classes: [
      { key: "good", label: "Good", color: "#A7F3D0" },
      { key: "immature", label: "Immature", color: "#FB923C" },
      { key: "sm", label: "Spoiled & Mold", color: "#E879F9" },
      { key: "dc", label: "Discolor", color: "#818CF8" },
    ],
  },
};

export const GOOD_KEY = "good";

/**
 * Seed-count -> weight conversion constants.
 * Per-class single-seed weight (grams) - used to convert estimated seed counts to weight.
 * All four defaults are ASSUMED, not measured (`WEIGHT_VALUES_MEASURED = false`), and remain
 * editable via `app_settings`.
 */
export const WEIGHT_VALUES_MEASURED = false;
export const SEED_WEIGHT_G: Readonly<Record<string, number>> = {
  good: 0.31,
  immature: 0.2,
  sm: 0.25,
  dc: 0.3,
};
export const GOOD_SEED_WEIGHT_G = SEED_WEIGHT_G.good!;
export const IMMATURE_SEED_WEIGHT_G = SEED_WEIGHT_G.immature!;
export const SM_SEED_WEIGHT_G = SEED_WEIGHT_G.sm!;
export const DC_SEED_WEIGHT_G = SEED_WEIGHT_G.dc!;
export const TOTAL_SAMPLE_WEIGHT_G = 500.0;
/**
 * Legacy ±25% sanity tolerance against a fixed 500 g total sample weight.
 * Disabled by default (`0` = disabled) because the per-class weight model renders the fixed-500 g check obsolete.
 */
export const WEIGHT_SANITY_TOL = 0;

/** Rows with these snapshot_type values are used for metrics. */
export const VALID_SNAPSHOT_TYPES: readonly string[] = ["last_frame", "plate_end"];

/** Device writes naive CSV wall-clock timestamps in Asia/Bangkok (UTC+7, no DST). */
export const DEVICE_TZ = "Asia/Bangkok";
export const DEVICE_UTC_OFFSET_MIN = 7 * 60;

/**
 * Timezone of wall-clock digits (`YYYYMMDD_HHMMSS` / `YYYY-MM-DD_HH-MM-SS`) in snapshot filenames.
 * Verified against `shf-core-v2-4.py` (`datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')`) and real
 * batch fixtures (`nj2` and `SAMPLE 1`), which show a constant 7-hour offset vs Bangkok CSV timestamps:
 * snapshot filenames are written in `"UTC"` by default.
 */
export type SnapshotFilenameTz = "UTC" | "Asia/Bangkok";
export const DEFAULT_SNAPSHOT_FILENAME_TZ: SnapshotFilenameTz = "UTC";

/** Legacy PDF footer text defaults (editable via `app_settings`). */
export const DEFAULT_REPORT_FOOTER_LEFT = "SQAUD · Grain QC Report";
export const DEFAULT_REPORT_FORM_CODE = "FM-JJR";

export function normalizeSnapshotFilenameTz(raw: unknown): SnapshotFilenameTz | null {
  if (typeof raw === "number") {
    if (raw === 0) return "UTC";
    if (raw === 7 || raw === 420) return "Asia/Bangkok";
    return null;
  }
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "utc" || v === "z" || v === "0" || v === "+00:00" || v === "etc/utc") {
    return "UTC";
  }
  if (
    v === "asia/bangkok" ||
    v === "bangkok" ||
    v === "ict" ||
    v === "utc+7" ||
    v === "+07:00" ||
    v === "7" ||
    v === "420"
  ) {
    return "Asia/Bangkok";
  }
  return null;
}

export interface Settings {
  good_seed_weight_g: number;
  immature_seed_weight_g: number;
  sm_seed_weight_g: number;
  dc_seed_weight_g: number;
  total_sample_weight_g: number;
  defect_warn_threshold_pct: number;
  plate_variance_spread_pct: number;
  active_ttl_s: number;
  /** 0 = all rows. Legacy parity is 200 (df.tail(200)); recommended: 0. */
  metrics_window_rows: number;
  refresh_sec: number;
  expected_plates: number;
  /** Timezone used to interpret wall-clock timestamps in snapshot filenames (`"UTC"` or `"Asia/Bangkok"`). */
  snapshot_filename_tz: SnapshotFilenameTz;
  /** Left footer label in generated PDF reports (default: `"SQAUD · Grain QC Report"`). */
  report_footer_left: string;
  /** Form code in the right footer of generated PDF reports (default: `"FM-JJR"`). */
  report_form_code: string;
  seed_weight_g?: Readonly<Record<string, number>>;
  weight_sanity_tol?: number;
  weight_values_measured?: boolean;
}

/** Matches seed.sql defaults, except metrics_window_rows = 0 per kickoff decision. */
export const DEFAULT_SETTINGS: Settings = {
  good_seed_weight_g: GOOD_SEED_WEIGHT_G,
  immature_seed_weight_g: IMMATURE_SEED_WEIGHT_G,
  sm_seed_weight_g: SM_SEED_WEIGHT_G,
  dc_seed_weight_g: DC_SEED_WEIGHT_G,
  total_sample_weight_g: TOTAL_SAMPLE_WEIGHT_G,
  defect_warn_threshold_pct: 10.0,
  plate_variance_spread_pct: 8.0,
  active_ttl_s: 60,
  metrics_window_rows: 0,
  refresh_sec: 5,
  expected_plates: 5,
  snapshot_filename_tz: DEFAULT_SNAPSHOT_FILENAME_TZ,
  report_footer_left: DEFAULT_REPORT_FOOTER_LEFT,
  report_form_code: DEFAULT_REPORT_FORM_CODE,
  seed_weight_g: SEED_WEIGHT_G,
  weight_sanity_tol: WEIGHT_SANITY_TOL,
  weight_values_measured: WEIGHT_VALUES_MEASURED,
};

const APP_SETTING_KEY_ALIASES: Readonly<Record<string, keyof Settings>> = {
  good_weight_g: "good_seed_weight_g",
  immature_weight_g: "immature_seed_weight_g",
  sm_weight_g: "sm_seed_weight_g",
  spoiled_mold_seed_weight_g: "sm_seed_weight_g",
  dc_weight_g: "dc_seed_weight_g",
  discolor_seed_weight_g: "dc_seed_weight_g",
};

/** Merge key/value rows from `app_settings` into a Settings object and synchronize `seed_weight_g`. */
export function applyAppSettingsRows(
  rows: readonly { key: string; value: number | string }[],
  base: Settings = DEFAULT_SETTINGS,
): Settings {
  const s: Settings = { ...base };
  for (const row of rows) {
    if (row.key === "snapshot_filename_tz") {
      const tz = normalizeSnapshotFilenameTz(row.value);
      if (tz) s.snapshot_filename_tz = tz;
      continue;
    }
    if (row.key === "report_footer_left" || row.key === "report_form_code") {
      const str = String(row.value ?? "").trim();
      if (str.length > 0) {
        s[row.key] = str;
      }
      continue;
    }
    const rawStr = typeof row.value === "string" ? row.value.trim() : row.value;
    if (rawStr === "") continue;
    const num = Number(rawStr);
    if (!Number.isFinite(num)) continue;
    const targetKey = (row.key in s ? row.key : APP_SETTING_KEY_ALIASES[row.key]) as
      | keyof Settings
      | undefined;
    if (targetKey && typeof s[targetKey] === "number") {
      (s as unknown as Record<string, number>)[targetKey] = num;
    }
  }
  s.seed_weight_g = {
    ...(base.seed_weight_g ?? SEED_WEIGHT_G),
    good: s.good_seed_weight_g,
    immature: s.immature_seed_weight_g,
    sm: s.sm_seed_weight_g,
    dc: s.dc_seed_weight_g,
  };
  return s;
}
