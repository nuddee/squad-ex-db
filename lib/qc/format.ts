/** Display helpers shared by UI, PDF and ingest/import reports. */

import type { BatchMetrics } from "./metrics";
import type { Settings } from "./config";

/** Per-plate seeds: null (no estimated counts for that plate) renders as an em dash. */
export function formatSeeds(seeds: number | null | undefined): string {
  return seeds === null || seeds === undefined ? "—" : seeds.toLocaleString("en-US");
}

/**
 * Weight-conversion health of a batch (matches x-26-10.py).
 * Weight is calculated per class (estimated class count × per-class seed weight) and summed to total_weight_g.
 * total_sample_weight_g (500 g) is used only as a ±25% sanity check on complete batches; defect weight % is
 * computed relative to total_weight_g, so the weight-based defect alert stays active even when weight_warning is true.
 */
export interface WeightSummary {
  weight_warning: boolean;
  estimated_seeds: number;
  good_count_est: number;
  good_weight_g: number;
  defect_weight_g: number;
  total_weight_g: number;
  total_sample_weight_g: number;
  /** total_sample_weight_g / good_seed_weight_g: reference good seeds for the expected sample weight. */
  max_plausible_seeds: number;
  /** True: defect % (wt) is relative to estimated total_weight_g, so the alert remains active. */
  weight_alert_active: boolean;
  message: string | null;
}

export function summarizeWeight(
  m: BatchMetrics,
  s: Pick<Settings, "good_seed_weight_g" | "total_sample_weight_g">,
): WeightSummary {
  const maxSeeds = s.good_seed_weight_g > 0 ? Math.floor(s.total_sample_weight_g / s.good_seed_weight_g) : 0;
  const message = m.weight_warning
    ? `WEIGHT WARNING: Estimated total weight (${m.total_weight_g.toFixed(0)} g) differs from the expected ` +
      `sample weight (${s.total_sample_weight_g.toFixed(0)} g) by more than 25%. Check seed count or seed weights.`
    : null;
  return {
    weight_warning: m.weight_warning,
    estimated_seeds: m.estimated_seeds,
    good_count_est: m.good_count_est,
    good_weight_g: m.good_weight_g,
    defect_weight_g: m.defect_weight_g,
    total_weight_g: m.total_weight_g,
    total_sample_weight_g: s.total_sample_weight_g,
    max_plausible_seeds: maxSeeds,
    weight_alert_active: true,
    message,
  };
}
