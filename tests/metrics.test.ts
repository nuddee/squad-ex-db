import { describe, expect, it } from "vitest";
import { computeQcMetrics, applyWindow, median, round1, type BatchMetrics, type MetricsRow } from "@/lib/qc/metrics";
import { applyAppSettingsRows, DEFAULT_SETTINGS, type Settings } from "@/lib/qc/config";

const row = (
  plate: number,
  mix: Record<string, number>,
  est: number,
  total = 100,
  type = "last_frame",
): MetricsRow => ({
  plate_number: plate,
  snapshot_type: type,
  snapshot_total: total,
  estimated_grain_count: est,
  mix,
});

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(0.05);
const batch = (m: ReturnType<typeof computeQcMetrics>): BatchMetrics => {
  if (m.empty) throw new Error("expected non-empty metrics");
  return m;
};

describe("golden case (default settings)", () => {
  const rows = [
    row(1, { good: 90, immature: 6, sm: 2, dc: 2 }, 800),
    row(2, { good: 80, immature: 10, sm: 5, dc: 5 }, 800),
  ];
  const m = batch(computeQcMetrics(rows, DEFAULT_SETTINGS));

  it("pooled percentages", () => {
    near(m.pct.good!, 85.0);
    near(m.pct.immature!, 8.0);
    near(m.pct.sm!, 3.5);
    near(m.pct.dc!, 3.5);
    near(m.total_defect_pct, 15.0);
    expect(m.estimated_seeds).toBe(1600);
    expect(m.total_plates).toBe(2);
  });

  it("plates and variance", () => {
    near(m.plates[0]!.defect_pct, 10.0);
    near(m.plates[1]!.defect_pct, 20.0);
    near(m.defect_spread, 10.0);
    expect(m.has_high_variance).toBe(true);
    near(m.plates[0]!.good_seeds_est, 720);
    near(m.plates[1]!.good_seeds_est, 640);
    near(m.good_count_est, 1360);
  });

  it("weights", () => {
    // good: 1360 * 0.31 = 421.6 g
    // immature: 128 * 0.20 = 25.6 g
    // sm: 56 * 0.25 = 14.0 g
    // dc: 56 * 0.30 = 16.8 g
    // defect_weight_g = 25.6 + 14.0 + 16.8 = 56.4 g; total_weight_g = 478.0 g
    near(m.good_weight_g, 421.6);
    near(m.defect_weight_g, 56.4);
    near(m.total_weight_g, 478.0);
    near(m.good_pct_wt, 88.2);
    near(m.total_defect_pct_wt, 11.8);
    near(m.class_pct_wt.immature!, 5.4);
    near(m.class_pct_wt.sm!, 2.9);
    near(m.class_pct_wt.dc!, 3.5);
    expect(m.is_defect_high).toBe(true);
    expect(m.weight_warning).toBe(false);
  });

  it("allows overriding all four per-class seed weights via app_settings rows", () => {
    const customSettings = applyAppSettingsRows([
      { key: "good_seed_weight_g", value: 0.31 },
      { key: "immature_seed_weight_g", value: 0.1 },
      { key: "sm_seed_weight_g", value: 0.25 },
      { key: "dc_seed_weight_g", value: 0.3 },
    ]);
    const customM = batch(computeQcMetrics(rows, customSettings));
    near(customM.defect_weight_g, 43.6);
    near(customM.total_weight_g, 465.2);
    near(customM.good_pct_wt, 90.6);
    near(customM.total_defect_pct_wt, 9.4);
  });

  it("parses text values ('10.0', '0.2', 'UTC', etc.) from app_settings.value into typed Settings", () => {
    const fromText = applyAppSettingsRows([
      { key: "good_seed_weight_g", value: "0.31" },
      { key: "immature_seed_weight_g", value: "0.2" },
      { key: "sm_seed_weight_g", value: "0.25" },
      { key: "dc_seed_weight_g", value: "0.3" },
      { key: "defect_warn_threshold_pct", value: "10.0" },
      { key: "plate_variance_spread_pct", value: "8.0" },
      { key: "active_ttl_s", value: "60" },
      { key: "metrics_window_rows", value: "0" },
      { key: "refresh_sec", value: "5" },
      { key: "expected_plates", value: "5" },
      { key: "weight_sanity_tol", value: "0" },
      { key: "snapshot_filename_tz", value: "UTC" },
      { key: "good_seed_weight_g", value: "   " }, // empty/whitespace ignored safely
      { key: "refresh_sec", value: "not-a-number" }, // invalid number ignored safely
    ]);

    expect(fromText.good_seed_weight_g).toBe(0.31);
    expect(fromText.immature_seed_weight_g).toBe(0.2);
    expect(fromText.sm_seed_weight_g).toBe(0.25);
    expect(fromText.dc_seed_weight_g).toBe(0.3);
    expect(fromText.defect_warn_threshold_pct).toBe(10.0);
    expect(fromText.plate_variance_spread_pct).toBe(8.0);
    expect(fromText.active_ttl_s).toBe(60);
    expect(fromText.metrics_window_rows).toBe(0);
    expect(fromText.refresh_sec).toBe(5);
    expect(fromText.expected_plates).toBe(5);
    expect(fromText.weight_sanity_tol).toBe(0);
    expect(fromText.snapshot_filename_tz).toBe("UTC");
    expect(fromText.seed_weight_g).toEqual({
      good: 0.31,
      immature: 0.2,
      sm: 0.25,
      dc: 0.3,
    });

    const bkkSettings = applyAppSettingsRows([{ key: "snapshot_filename_tz", value: "Asia/Bangkok" }]);
    expect(bkkSettings.snapshot_filename_tz).toBe("Asia/Bangkok");
  });
});

describe("edge cases", () => {
  it("single plate: no variance", () => {
    const m = batch(computeQcMetrics([row(1, { good: 90, immature: 10 }, 800)]));
    expect(m.total_plates).toBe(1);
    expect(m.defect_spread).toBe(0);
    expect(m.has_high_variance).toBe(false);
    near(m.total_defect_pct, 10);
  });

  it("empty batch", () => {
    expect(computeQcMetrics([]).empty).toBe(true);
  });

  it("all rows with snapshot_total = 0", () => {
    expect(computeQcMetrics([row(1, { good: 10 }, 100, 0), row(2, { good: 10 }, 100, 0)]).empty).toBe(true);
  });

  it("disables the obsolete ±25% 500 g weight_warning by default while allowing opt-in via weight_sanity_tol", () => {
    const fivePlates = [1, 2, 3, 4, 5].map((p) => row(p, { good: 70, immature: 10, sm: 10, dc: 10 }, 1000));
    const mDefault = batch(computeQcMetrics(fivePlates));
    expect(mDefault.total_plates).toBe(5);
    expect(mDefault.weight_warning).toBe(false);
    expect(mDefault.defect_weight_g).toBeGreaterThan(0);
    expect(mDefault.total_defect_pct_wt).toBeGreaterThan(10);
    expect(mDefault.is_defect_high).toBe(true);

    // Explicit opt-in to legacy 25% sanity tolerance still works if enabled
    const mOptIn = batch(computeQcMetrics(fivePlates, { ...DEFAULT_SETTINGS, weight_sanity_tol: 0.25 }));
    expect(mOptIn.weight_warning).toBe(true);
  });

  it("incomplete batch (< expected_plates) does not trigger weight_warning even with high seed count", () => {
    const m = batch(computeQcMetrics([row(1, { good: 90, immature: 10 }, 5000)]));
    expect(m.total_plates).toBe(1);
    expect(m.weight_warning).toBe(false);
    expect(m.defect_weight_g).toBeGreaterThan(0);
  });

  it("snapshot_type outside last_frame/plate_end is excluded", () => {
    const m = batch(
      computeQcMetrics([
        row(1, { good: 90, immature: 10 }, 800, 100, "last_frame"),
        row(1, { good: 0, immature: 100 }, 800, 100, "mid_frame"),
        row(2, { good: 80, immature: 20 }, 800, 100, "plate_end"),
      ]),
    );
    expect(m.total_detections).toBe(1600);
    near(m.pct.good!, 85);
  });

  it("unknown class counts toward row denominator and lowers display class fractions proportionally", () => {
    const m = batch(computeQcMetrics([row(1, { good: 80, immature: 10, weird: 10 }, 800)]));
    // display classes sum to 90% of the 800 seeds = 720 seeds; normalized across display classes:
    expect(m.total_detections).toBe(720);
    near(m.pct.good!, (80 / 90) * 100);
    near(m.pct.immature!, (10 / 90) * 100);
    near(m.total_defect_pct, (10 / 90) * 100);
  });

  it("falls back to median snapshot_total when no estimates", () => {
    const m = batch(computeQcMetrics([row(1, { good: 10 }, 0, 40), row(1, { good: 10 }, 0, 55)]));
    expect(m.estimated_seeds).toBe(48); // round-half-to-even of median(40, 55) = 47.5 -> 48
    expect(m.plates[0]!.seeds).toBe(47); // Math.trunc(47.5)
  });

  it("plate with estimates summing to 0: seeds and good seeds fall back to median snapshot_total", () => {
    const m = batch(
      computeQcMetrics([
        row(1, { good: 80, immature: 20 }, 0, 40),
        row(1, { good: 80, immature: 20 }, 0, 60),
        row(2, { good: 90, immature: 10 }, 1000, 100),
      ]),
    );
    const p1 = m.plates[0]!;
    expect(p1.seeds).toBe(50);
    near(p1.good_seeds_est, 40); // median(40, 60) = 50, x 80 %
    expect(m.plates[1]!.seeds).toBe(1000);
    near(m.good_count_est, 40 + 900);
  });

  it("median of even-length list is the mean of the middle two", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const m = batch(
      computeQcMetrics([row(1, { good: 10 }, 100), row(1, { good: 10 }, 200), row(1, { good: 10 }, 300), row(1, { good: 10 }, 400)]),
    );
    expect(m.estimated_seeds).toBe(250);
  });

  it("round1 matches Python half-even on ties", () => {
    expect(round1(0.25)).toBe(0.2);
    expect(round1(0.75)).toBe(0.8);
    expect(round1(15.68)).toBe(15.7);
  });
});

describe("metrics window", () => {
  // 300 rows: plate 1 first (all bad), then 200 rows of plate 2 (all good).
  const early = Array.from({ length: 100 }, () => row(1, { good: 0, immature: 100 }, 800));
  const late = Array.from({ length: 200 }, () => row(2, { good: 100 }, 800));
  const rows = [...early, ...late];

  it("applyWindow keeps the tail; 0 means all", () => {
    expect(applyWindow(rows, 200)).toHaveLength(200);
    expect(applyWindow(rows, 0)).toHaveLength(300);
  });

  it("200-row window silently drops plate 1 (legacy parity)", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, metrics_window_rows: 200 };
    const m = batch(computeQcMetrics(rows, s));
    expect(m.total_plates).toBe(1);
    near(m.total_defect_pct, 0);
  });

  it("window 0 includes every plate", () => {
    const m = batch(computeQcMetrics(rows, { ...DEFAULT_SETTINGS, metrics_window_rows: 0 }));
    expect(m.total_plates).toBe(2);
    expect(m.has_high_variance).toBe(true);
  });
});
