/**
 * Single source of truth for QC calculations. Pure TypeScript, no I/O.
 * Port of compute_qc_metrics (x-26-10.py). Full precision is kept internally;
 * round with round1() for display only.
 */
import {
  GOOD_KEY,
  MODES,
  VALID_SNAPSHOT_TYPES,
  DEFAULT_SETTINGS,
  SEED_WEIGHT_G,
  WEIGHT_SANITY_TOL,
  type QcMode,
  type Settings,
} from "./config";
import type { Mix } from "./parse";

export interface MetricsRow {
  plate_number: number;
  snapshot_type: string;
  snapshot_total: number;
  estimated_grain_count: number;
  mix: Mix;
}

export interface PlateMetrics {
  plate: number;
  /** Median estimated_grain_count (or fallback median snapshot_total), truncated to integer. */
  seeds: number | null;
  /** % per class key, full precision. */
  pct: Record<string, number>;
  defect_pct: number;
  good_seeds_est: number;
}

export interface BatchMetrics {
  empty: false;
  total_plates: number;
  total_detections: number;
  estimated_seeds: number;
  /** Pooled % per class key (count basis). */
  pct: Record<string, number>;
  total_defect_pct: number;
  good_count_est: number;
  good_weight_g: number;
  defect_weight_g: number;
  total_weight_g: number;
  good_pct_wt: number;
  total_defect_pct_wt: number;
  /** % (wt) per defect class key. */
  class_pct_wt: Record<string, number>;
  weight_warning: boolean;
  plates: PlateMetrics[];
  min_defect: number;
  max_defect: number;
  defect_spread: number;
  has_high_variance: boolean;
  is_complete_expected_plates: boolean;
  is_defect_high: boolean;
}

export interface EmptyMetrics {
  empty: true;
}

export type QcMetrics = BatchMetrics | EmptyMetrics;

/** Round half-to-even at 1 dp, like Python round(x, 1). Display only. */
export function round1(x: number): number {
  const s = x * 10;
  const fl = Math.floor(s);
  const diff = s - fl;
  let r: number;
  if (diff === 0.5) r = fl % 2 === 0 ? fl : fl + 1;
  else r = Math.round(s);
  return r / 10;
}

/** Round half-to-even to integer, like Python int(round(x)). */
function roundInt(x: number): number {
  const fl = Math.floor(x);
  const diff = x - fl;
  if (diff === 0.5) return fl % 2 === 0 ? fl : fl + 1;
  return Math.round(x);
}

/** pandas-style median: mean of the two middle values for even length. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Legacy df.tail(rows_to_show) when n > 0; all rows when n <= 0. Rows must be time-ascending. */
export function applyWindow<T>(rows: readonly T[], n: number): T[] {
  return n > 0 ? rows.slice(-n) : [...rows];
}

export function computeQcMetrics(
  inputRows: readonly MetricsRow[],
  settings: Settings = DEFAULT_SETTINGS,
  mode: QcMode = MODES.grain!,
): QcMetrics {
  const windowed = applyWindow(inputRows, settings.metrics_window_rows);
  const scan = windowed.filter((r) => VALID_SNAPSHOT_TYPES.includes(r.snapshot_type) && r.snapshot_total > 0);
  if (scan.length === 0) return { empty: true };

  const classKeys = mode.classes.map((c) => c.key);
  const classCount: Record<string, number> = {};
  for (const k of classKeys) classCount[k] = 0;

  // Group rows by plate (sorted ascending).
  const byPlate = new Map<number, MetricsRow[]>();
  for (const r of scan) {
    const g = byPlate.get(r.plate_number);
    if (g) g.push(r);
    else byPlate.set(r.plate_number, [r]);
  }
  const plateNums = [...byPlate.keys()].sort((a, b) => a - b);

  // 1. Per-plate class fractions (mean of per-snapshot fractions, so snapshot count
  //    or detection volume of a plate cannot bias it), scaled by the plate's seed estimate.
  const plates: PlateMetrics[] = [];
  for (const p of plateNums) {
    const grp = byPlate.get(p)!;
    const frSum: Record<string, number> = {};
    for (const k of classKeys) frSum[k] = 0;
    let nRows = 0;
    for (const r of grp) {
      let tot = 0;
      for (const v of Object.values(r.mix)) tot += v;
      if (tot > 0) {
        nRows += 1;
        for (const k of classKeys) {
          frSum[k] = (frSum[k] ?? 0) + (r.mix[k] ?? 0) / tot;
        }
      }
    }
    if (nRows === 0) continue;

    const fr: Record<string, number> = {};
    for (const k of classKeys) fr[k] = (frSum[k] ?? 0) / nRows;

    const estSum = grp.reduce((a, r) => a + r.estimated_grain_count, 0);
    const pEst =
      estSum > 0
        ? median(grp.map((r) => r.estimated_grain_count))
        : median(grp.map((r) => r.snapshot_total));

    for (const k of classKeys) {
      classCount[k] = (classCount[k] ?? 0) + pEst * (fr[k] ?? 0);
    }

    const ppct: Record<string, number> = {};
    for (const c of mode.classes) {
      ppct[c.key] = (fr[c.key] ?? 0) * 100;
    }
    const pGoodFr = fr[GOOD_KEY] ?? 0;

    plates.push({
      plate: p,
      seeds: Math.trunc(pEst),
      pct: ppct,
      defect_pct: Math.max(0, 100 - pGoodFr * 100),
      good_seeds_est: pEst * pGoodFr,
    });
  }

  const grandTotal = classKeys.reduce((a, k) => a + (classCount[k] ?? 0), 0);
  if (grandTotal <= 0) return { empty: true };

  // 2. Batch count percentages & seed totals
  const pct: Record<string, number> = {};
  for (const c of mode.classes) {
    pct[c.key] = ((classCount[c.key] ?? 0) / grandTotal) * 100;
  }
  const goodPct = pct[GOOD_KEY] ?? 0;
  const totalDefectPct = Math.max(0, 100 - goodPct);
  const estSeedTotal = roundInt(grandTotal);
  const totalPlates = byPlate.size;

  // 3. Plate variance (compares 1-dp rounded per-plate Defect %)
  let minDef = 0,
    maxDef = 0,
    spread = 0,
    highVariance = false;
  if (plates.length > 1) {
    const d = plates.map((p) => round1(p.defect_pct));
    minDef = Math.min(...d);
    maxDef = Math.max(...d);
    spread = maxDef - minDef;
    highVariance = spread >= settings.plate_variance_spread_pct;
  }

  // 4. Count -> weight: same class counts as the count view, times per-class seed weight.
  const perClassFromSettings: Record<string, number | undefined> = {
    good: settings.good_seed_weight_g,
    immature: settings.immature_seed_weight_g,
    sm: settings.sm_seed_weight_g,
    dc: settings.dc_seed_weight_g,
  };
  const classWtG: Record<string, number> = {};
  for (const k of classKeys) {
    const customMapWeight =
      settings.seed_weight_g && settings.seed_weight_g !== SEED_WEIGHT_G
        ? settings.seed_weight_g[k]
        : undefined;
    const settingScalar = perClassFromSettings[k];
    const defaultScalar = (DEFAULT_SETTINGS as unknown as Record<string, number | undefined>)[
      `${k}_seed_weight_g`
    ];
    // Prefer an explicitly mutated scalar field (e.g. from app_settings or caller override),
    // then custom seed_weight_g map, then SEED_WEIGHT_G default.
    const w =
      settingScalar !== undefined && settingScalar !== defaultScalar
        ? settingScalar
        : customMapWeight !== undefined
          ? customMapWeight
          : (settingScalar ?? SEED_WEIGHT_G[k] ?? settings.good_seed_weight_g);
    classWtG[k] = (classCount[k] ?? 0) * w;
  }
  const totalWtG = classKeys.reduce((a, k) => a + (classWtG[k] ?? 0), 0);
  const goodCountEst = classCount[GOOD_KEY] ?? 0;
  const goodWeight = classWtG[GOOD_KEY] ?? 0;
  const defectWeight = totalWtG - goodWeight;
  const goodPctWt = totalWtG > 0 ? (goodWeight / totalWtG) * 100 : 0;
  const defectPctWt = totalWtG > 0 ? Math.max(0, 100 - goodPctWt) : 0;

  const defectKeys = mode.classes.filter((c) => c.key !== GOOD_KEY).map((c) => c.key);
  const classPctWt: Record<string, number> = {};
  for (const k of defectKeys) {
    classPctWt[k] = totalWtG > 0 ? ((classWtG[k] ?? 0) / totalWtG) * 100 : 0;
  }

  // Sanity: estimated total weight vs expected sample weight (disabled by default when sanityTol <= 0)
  const sanityTol = settings.weight_sanity_tol ?? WEIGHT_SANITY_TOL;
  const totalSampleWeight = settings.total_sample_weight_g;
  const weightWarning = Boolean(
    sanityTol > 0 &&
      totalPlates >= settings.expected_plates &&
      totalSampleWeight > 0 &&
      Math.abs(totalWtG - totalSampleWeight) / totalSampleWeight > sanityTol,
  );

  // 5. Alert. Compares the 1-dp rounded weight-based defect % against the threshold.
  const defectWtRounded = round1(defectPctWt);
  const isDefectHigh = defectWtRounded >= settings.defect_warn_threshold_pct && defectWtRounded > 0;

  return {
    empty: false,
    total_plates: totalPlates,
    total_detections: estSeedTotal,
    estimated_seeds: estSeedTotal,
    pct,
    total_defect_pct: totalDefectPct,
    good_count_est: goodCountEst,
    good_weight_g: goodWeight,
    defect_weight_g: defectWeight,
    total_weight_g: totalWtG,
    good_pct_wt: goodPctWt,
    total_defect_pct_wt: defectPctWt,
    class_pct_wt: classPctWt,
    weight_warning: weightWarning,
    plates,
    min_defect: minDef,
    max_defect: maxDef,
    defect_spread: spread,
    has_high_variance: highVariance,
    is_complete_expected_plates: totalPlates >= settings.expected_plates,
    is_defect_high: isDefectHigh,
  };
}
