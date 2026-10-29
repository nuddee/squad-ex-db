import { z } from "zod";
import {
  parseInspectionRecords,
  MAX_SKIP_SAMPLES,
  type InspectionRow,
  type ParseResult,
  type SkipReason,
  type SkippedRecord,
} from "@/lib/qc/parse";
import { computeQcMetrics } from "@/lib/qc/metrics";
import { summarizeWeight, type WeightSummary } from "@/lib/qc/format";
import type { IngestStore } from "./store";

export const MAX_ROWS_PER_REQUEST = 500;

/** Source file names are plain names, never paths. */
export const sourceNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !/[\\/\0]/.test(s) && s !== "." && s !== "..", "source_name must be a file name, not a path");

export const ingestRowsBodySchema = z.object({
  source_name: sourceNameSchema,
  /** CSV header as written by the device (e.g. snapshot_time, plate_number, ...). */
  columns: z.array(z.string().max(100)).min(1).max(100),
  /** Raw CSV records (strings), same order as the file. */
  rows: z.array(z.array(z.string().max(10_000)).max(100)).min(1).max(MAX_ROWS_PER_REQUEST),
  /** 1-based record number of rows[0] in the source CSV (header excluded); makes skipped_samples point at the right line. */
  first_record: z.number().int().min(1).default(1),
});
export type IngestRowsBody = z.infer<typeof ingestRowsBodySchema>;

export interface IngestReport {
  batch_id: string | null;
  source_name: string;
  received: number;
  /** Rows written (after skipping unreadable rows and collapsing in-request duplicates). */
  accepted: number;
  skipped: number;
  skip_reasons: Partial<Record<SkipReason, number>>;
  skipped_samples: SkippedRecord[];
  /** Rows dropped because a later row in the same request had the same (time, plate, type) key. */
  duplicates_in_request: number;
  /** Batch-level weight health after this write; null when not computed or the batch has no valid rows. */
  weight: WeightSummary | null;
  /** Mirrors weight.message so clients/logs can't miss it. */
  warnings: string[];
}

export function dedupeRows(rows: readonly InspectionRow[]): { rows: InspectionRow[]; duplicates: number } {
  const byKey = new Map<string, InspectionRow>();
  for (const r of rows) byKey.set(`${r.snapshot_time.getTime()}|${r.plate_number}|${r.snapshot_type}`, r);
  return { rows: [...byKey.values()], duplicates: rows.length - byKey.size };
}

export interface IngestParams {
  deviceId: string | null;
  sourceName: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  firstRecord?: number;
  mode?: string;
}

/**
 * Parse -> dedupe -> idempotent upsert -> (optionally) batch weight health.
 * Shared by POST /api/ingest/rows and the CSV importer so both report identically.
 */
export async function ingestRows(
  store: IngestStore,
  p: IngestParams,
  opts: { computeWeight?: boolean } = {},
): Promise<IngestReport> {
  const computeWeight = opts.computeWeight ?? true;
  const parsed: ParseResult = parseInspectionRecords(p.columns, p.rows, p.firstRecord ?? 1);
  const { rows, duplicates } = dedupeRows(parsed.rows);

  const report: IngestReport = {
    batch_id: null,
    source_name: p.sourceName,
    received: p.rows.length,
    accepted: rows.length,
    skipped: parsed.skipped,
    skip_reasons: parsed.skip_reasons,
    skipped_samples: parsed.skipped_samples,
    duplicates_in_request: duplicates,
    weight: null,
    warnings: [],
  };
  if (rows.length === 0) return report;

  const batch = await store.getOrCreateBatch({ deviceId: p.deviceId, sourceName: p.sourceName, mode: p.mode ?? "grain" });
  report.batch_id = batch.id;
  const last = rows[rows.length - 1]!; // rows are time-ascending: legacy uses the latest row's plate/QC
  await store.updateBatchMeta(batch.id, { truck_plate: last.truck_plate, qc_name: last.qc_name });
  await store.upsertRows(batch.id, rows);

  if (computeWeight) await attachWeight(store, report);
  return report;
}

export async function attachWeight(store: IngestStore, report: IngestReport): Promise<void> {
  if (!report.batch_id) return;
  const [settings, metricsRows] = await Promise.all([store.getSettings(), store.loadMetricsRows(report.batch_id)]);
  const m = computeQcMetrics(metricsRows, settings);
  if (m.empty) return;
  report.weight = summarizeWeight(m, settings);
  if (report.weight.message) report.warnings.push(report.weight.message);
}

/** Merge per-chunk reports (importer, which sends 500-row chunks) into one report. */
export function mergeReports(reports: readonly IngestReport[], sourceName: string): IngestReport {
  const out: IngestReport = {
    batch_id: null, source_name: sourceName, received: 0, accepted: 0, skipped: 0,
    skip_reasons: {}, skipped_samples: [], duplicates_in_request: 0, weight: null, warnings: [],
  };
  for (const r of reports) {
    out.batch_id ??= r.batch_id;
    out.received += r.received;
    out.accepted += r.accepted;
    out.skipped += r.skipped;
    out.duplicates_in_request += r.duplicates_in_request;
    for (const [k, v] of Object.entries(r.skip_reasons)) {
      const key = k as SkipReason;
      out.skip_reasons[key] = (out.skip_reasons[key] ?? 0) + (v ?? 0);
    }
    for (const s of r.skipped_samples) if (out.skipped_samples.length < MAX_SKIP_SAMPLES) out.skipped_samples.push(s);
    if (r.weight) { out.weight = r.weight; out.warnings = [...r.warnings]; } // last computed wins
  }
  return out;
}

/** Human-readable multi-line report (importer stdout, edge logs). */
export function formatReport(r: IngestReport): string {
  const lines = [
    `${r.source_name}: received ${r.received}, accepted ${r.accepted}, skipped ${r.skipped}` +
      (r.duplicates_in_request ? `, ${r.duplicates_in_request} duplicate(s) collapsed` : "") +
      (r.batch_id ? ` -> batch ${r.batch_id}` : ""),
  ];
  if (r.skipped) {
    lines.push(`  skip reasons: ${Object.entries(r.skip_reasons).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push(`  first skipped records: ${r.skipped_samples.map((s) => `#${s.record}(${s.reason})`).join(" ")}`);
  }
  for (const w of r.warnings) lines.push(`  ${w}`);
  return lines.join("\n");
}
