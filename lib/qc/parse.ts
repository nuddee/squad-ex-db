import { parseCsvTimestamp } from "./time";

export type Mix = Record<string, number>;

/**
 * "good=120 (60.0%), immature=30 (15.0%)" -> {good:120, immature:30}.
 * Duplicate names are summed. Unknown class names are kept (they count toward grand_total).
 */
export function parseMixSummary(s: unknown): Mix {
  const out: Mix = {};
  if (typeof s !== "string") return out;
  const re = /([A-Za-z0-9\-_]+)\s*=\s*([0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1]!;
    out[name] = (out[name] ?? 0) + Number.parseInt(m[2]!, 10);
  }
  return out;
}

export interface InspectionRow {
  snapshot_time: Date;
  truck_plate: string;
  qc_name: string;
  plate_number: number;
  snapshot_type: string;
  snapshot_total: number;
  estimated_grain_count: number;
  mix: Mix;
  mix_raw: string;
}

export type SkipReason = "too_many_fields" | "bad_timestamp" | "missing_time_column";

export interface SkippedRecord {
  /** 1-based data record number (header excluded). */
  record: number;
  reason: SkipReason;
}

export interface ParseResult {
  rows: InspectionRow[];
  /** Data records dropped (bad field count or unparseable time). Always equals the sum of skip_reasons. */
  skipped: number;
  /** Count per reason, for API responses and importer/edge-sync logs. */
  skip_reasons: Partial<Record<SkipReason, number>>;
  /** First MAX_SKIP_SAMPLES skipped records, for diagnostics. */
  skipped_samples: SkippedRecord[];
}

export const MAX_SKIP_SAMPLES = 20;

/** One-line summary for logs, e.g. "skipped 3 row(s): bad_timestamp=2, too_many_fields=1". */
export function formatSkipSummary(r: Pick<ParseResult, "skipped" | "skip_reasons">): string {
  if (r.skipped === 0) return "skipped 0 row(s)";
  const parts = Object.entries(r.skip_reasons).map(([k, v]) => `${k}=${v}`);
  return `skipped ${r.skipped} row(s): ${parts.join(", ")}`;
}

/** Minimal RFC 4180 CSV reader (quoted fields, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** pandas to_numeric(errors="coerce").fillna(fallback).astype(int) */
function toInt(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v.trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Port of legacy load_csv. Unreadable rows are skipped, not fatal. Sorted by time ascending (stable).
 * Rows with an unparseable time are skipped because inspection_rows.snapshot_time is NOT NULL.
 */
export function parseInspectionCsv(text: string): ParseResult {
  const table = parseCsv(text);
  if (table.length === 0) return parseInspectionRecords([], []);
  return parseInspectionRecords(table[0]!, table.slice(1));
}

/**
 * Same rules as parseInspectionCsv but on an already-split header + data records.
 * Used by the ingest API (device sends columns + rows). `firstRecord` is the 1-based
 * record number of records[0] in the source file, so skipped_samples point at the right line.
 */
export function parseInspectionRecords(
  headerRaw: readonly string[],
  records: readonly (readonly string[])[],
  firstRecord = 1,
): ParseResult {
  const skip_reasons: Partial<Record<SkipReason, number>> = {};
  const skipped_samples: SkippedRecord[] = [];
  let skipped = 0;
  const skip = (record: number, reason: SkipReason) => {
    skipped++;
    skip_reasons[reason] = (skip_reasons[reason] ?? 0) + 1;
    if (skipped_samples.length < MAX_SKIP_SAMPLES) skipped_samples.push({ record, reason });
  };
  const header = headerRaw.map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);

  const timeCol = idx("snapshot_time") >= 0 ? idx("snapshot_time") : idx("bin_end_ts");
  const plateTruckCol = idx("truck_plate") >= 0 ? idx("truck_plate") : idx("farm_name");
  const qcCol = idx("qc_name");
  const mixCol = idx("snapshot_mix_summary");
  const totalCol = idx("snapshot_total");
  const plateNumCol = idx("plate_number");
  const typeCol = idx("snapshot_type");
  const estCol = idx("estimated_grain_count");

  const rows: InspectionRow[] = [];
  if (timeCol < 0) {
    records.forEach((_, i) => skip(firstRecord + i, "missing_time_column"));
    return { rows, skipped, skip_reasons, skipped_samples };
  }

  records.forEach((r, i) => {
    const rec = firstRecord + i;
    // pandas on_bad_lines="skip": rows with more fields than the header are dropped.
    if (r.length > header.length) return skip(rec, "too_many_fields");
    const ts = parseCsvTimestamp(r[timeCol]);
    if (!ts) return skip(rec, "bad_timestamp");
    const total = totalCol >= 0 ? toInt(r[totalCol], 0) : 0;
    const mixRaw = mixCol >= 0 ? (r[mixCol] ?? "") : "";
    rows.push({
      snapshot_time: ts,
      truck_plate: plateTruckCol >= 0 ? (r[plateTruckCol] ?? "") : "",
      qc_name: qcCol >= 0 ? (r[qcCol] ?? "") : "",
      plate_number: plateNumCol >= 0 ? toInt(r[plateNumCol], 1) : 1,
      snapshot_type: typeCol >= 0 ? (r[typeCol] ?? "") : "last_frame",
      snapshot_total: total,
      estimated_grain_count: estCol >= 0 ? toInt(r[estCol], 0) : total,
      mix: parseMixSummary(mixRaw),
      mix_raw: mixRaw,
    });
  });
  // Array.prototype.sort is stable (ES2019+), matching a stable time sort.
  rows.sort((a, b) => a.snapshot_time.getTime() - b.snapshot_time.getTime());
  return { rows, skipped, skip_reasons, skipped_samples };
}
