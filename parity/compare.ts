/**
 * Parity check: legacy Python compute_qc_metrics (exported JSON) vs lib/qc computeQcMetrics.
 * Usage: pnpm parity   (runs legacy_export.py first, then this script)
 * Legacy values are rounded to 1 dp, so TS values are compared after round1() (display rounding).
 * Exit code 1 if any difference is found.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseInspectionCsv, formatSkipSummary } from "../lib/qc/parse";
import { computeQcMetrics, round1, type BatchMetrics } from "../lib/qc/metrics";
import { DEFAULT_SETTINGS } from "../lib/qc/config";

const dir = __dirname;
const legacy = JSON.parse(readFileSync(path.join(dir, "legacy-output.json"), "utf8"));

type Json = Record<string, any>;
const diffs: string[] = [];
let checks = 0;

function cmp(where: string, field: string, legacyVal: unknown, tsVal: unknown, tol = 1e-9) {
  checks++;
  const ok =
    typeof legacyVal === "number" && typeof tsVal === "number"
      ? Math.abs(legacyVal - tsVal) <= tol
      : legacyVal === tsVal;
  if (!ok) diffs.push(`${where} :: ${field}: legacy=${JSON.stringify(legacyVal)} ts=${JSON.stringify(tsVal)}`);
}

function isoNoMs(d: Date, offsetMin: number): string {
  return new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 19);
}

const classes = [
  ["good", "Good"],
  ["immature", "Immature"],
  ["sm", "Spoiled & Mold"],
  ["dc", "Discolor"],
] as const;

for (const [file, fx] of Object.entries<Json>(legacy.fixtures)) {
  const text = readFileSync(path.join(dir, "fixtures", file), "utf8");
  const parsed = parseInspectionCsv(text);
  console.log(`\n== ${file}: ${parsed.rows.length} rows, ${formatSkipSummary(parsed)}`);
  cmp(file, "row_count", fx.row_count, parsed.rows.length);
  cmp(file, "skipped", 0, parsed.skipped);

  // Time parity. Legacy: offset-aware -> UTC-naive (tz_convert(None)); naive -> wall-clock as written.
  // TS: real instants, naive = Asia/Bangkok. Expected legacy string = instant in UTC (aware) or UTC+7 (naive).
  const off = fx.tz_aware ? 0 : 7 * 60;
  if (parsed.rows.length) {
    cmp(file, "first_time (legacy tz handling)", fx.first_time?.slice(0, 19), isoNoMs(parsed.rows[0]!.snapshot_time, off));
    cmp(file, "last_time (legacy tz handling)", fx.last_time?.slice(0, 19), isoNoMs(parsed.rows.at(-1)!.snapshot_time, off));
  }

  for (const [win, w] of Object.entries<Json>(fx.windows)) {
    const where = `${file}[window=${win}]`;
    const m = computeQcMetrics(parsed.rows, { ...DEFAULT_SETTINGS, metrics_window_rows: Number(win) });
    const lsum: Json = w.summary ?? {};
    if (Object.keys(lsum).length === 0 || m.empty) {
      cmp(where, "empty", Object.keys(lsum).length === 0, m.empty);
      continue;
    }
    const b: BatchMetrics = m;
    cmp(where, "total_plates", lsum.total_plates, b.total_plates);
    cmp(where, "total_detections", lsum.total_detections, b.total_detections);
    cmp(where, "estimated_seeds", lsum.estimated_seeds, b.estimated_seeds);
    for (const [k, label] of classes) {
      cmp(where, `${label} %`, lsum[`${label} %`], round1(b.pct[k]!));
      cmp(where, `classes.${label} %`, lsum.classes[`${label} %`], round1(b.pct[k]!));
    }
    cmp(where, "Total Defect %", lsum["Total Defect %"], round1(b.total_defect_pct));
    cmp(where, "good_count_est", lsum.good_count_est, round1(b.good_count_est));
    cmp(where, "good_weight_g", lsum.good_weight_g, round1(b.good_weight_g));
    cmp(where, "defect_weight_g", lsum.defect_weight_g, round1(b.defect_weight_g));
    cmp(where, "total_weight_g", lsum.total_weight_g, round1(b.total_weight_g));
    cmp(where, "Good % (wt)", lsum["Good % (wt)"], round1(b.good_pct_wt));
    cmp(where, "Total Defect % (wt)", lsum["Total Defect % (wt)"], round1(b.total_defect_pct_wt));
    cmp(where, "Immature % (wt)", lsum["Immature % (wt)"], round1(b.class_pct_wt.immature!));
    cmp(where, "Spoiled & Mold % (wt)", lsum["Spoiled & Mold % (wt)"], round1(b.class_pct_wt.sm!));
    cmp(where, "Discolor % (wt)", lsum["Discolor % (wt)"], round1(b.class_pct_wt.dc!));
    cmp(where, "weight_warning", lsum.weight_warning, b.weight_warning);
    cmp(where, "is_complete_5plate", lsum.is_complete_5plate, b.is_complete_expected_plates);
    cmp(where, "min_defect", lsum.min_defect, b.min_defect);
    cmp(where, "max_defect", lsum.max_defect, b.max_defect);
    cmp(where, "defect_spread", lsum.defect_spread, round1(b.defect_spread));
    cmp(where, "has_high_variance", lsum.has_high_variance, b.has_high_variance);
    cmp(where, "is_defect_high", lsum.is_defect_high, b.is_defect_high);

    const lplates: Json[] = w.plates;
    cmp(where, "plates.length", lplates.length, b.plates.length);
    lplates.forEach((lp, i) => {
      const p = b.plates[i];
      if (!p) return;
      const pw = `${where} plate#${lp.Plate}`;
      cmp(pw, "Plate", lp.Plate, p.plate);
      cmp(pw, "Seeds", lp.Seeds ?? null, p.seeds);
      for (const [k, label] of classes) cmp(pw, `${label} %`, lp[`${label} %`], round1(p.pct[k]!));
      cmp(pw, "Defect %", lp["Defect %"], round1(p.defect_pct));
      cmp(pw, "Good seeds (est.)", lp["Good seeds (est.)"], round1(p.good_seeds_est));
    });
    console.log(
      `   window=${win}: plates=${b.total_plates} good=${round1(b.pct.good!)}% defect(wt)=${round1(b.total_defect_pct_wt)}% ` +
        `seeds=${b.estimated_seeds} variance=${b.has_high_variance} alert=${b.is_defect_high}`,
    );
  }
}

console.log(`\n${checks} comparisons, ${diffs.length} difference(s)`);
for (const d of diffs) console.log("  DIFF " + d);
process.exit(diffs.length ? 1 : 0);
