import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SNAPSHOT_BUCKET,
  resolveSnapshotDisplayPaths,
  resolveSnapshotDisplayUrls,
} from "@/lib/ingest/snapshots";
import {
  applyAppSettingsRows,
  DEFAULT_SETTINGS,
  MODES,
  VALID_SNAPSHOT_TYPES,
  type Settings,
  type SnapshotFilenameTz,
} from "@/lib/qc/config";
import { summarizeWeight, type WeightSummary } from "@/lib/qc/format";
import { applyWindow, computeQcMetrics, type QcMetrics } from "@/lib/qc/metrics";
import type { Mix } from "@/lib/qc/parse";
import { matchSnapshotToRow, parseSnapshotMeta } from "@/lib/qc/snapshot-meta";
import {
  formatAgeLabel,
  formatBangkokDateKey,
  formatBangkokTimestamp,
  freshnessDot,
} from "@/lib/qc/time";

export interface RawBatchRecord {
  id: string;
  mode: string;
  device_id: string | null;
  source_name: string;
  truck_plate: string;
  qc_name: string;
  started_at: string | null;
  last_data_at: string | null;
  row_count: number;
  created_at: string;
}

export interface BatchSummaryItem extends RawBatchRecord {
  age_s: number;
  age_label: string;
  freshness: "🟢" | "🟡" | "🔴";
  bangkok_date: string;
  is_today: boolean;
}

export interface ListBatchesResponse {
  batches: BatchSummaryItem[];
  settings: Settings;
  active_batch_id: string | null;
  today_bangkok: string;
  server_time: string;
}

export interface RawInspectionRowRecord {
  id?: number;
  snapshot_time: string;
  plate_number: number;
  snapshot_type: string;
  snapshot_total: number;
  estimated_grain_count: number;
  mix: Mix;
  mix_raw: string;
}

export interface TracingRow {
  row_index: number;
  snapshot_time: string;
  snapshot_time_iso: string;
  truck_plate: string;
  qc_name: string;
  snapshot_mix_summary: string;
  plate_number: number;
  snapshot_total: number;
}

export interface BatchDetailResponse {
  batch: BatchSummaryItem;
  settings: Settings;
  snapshot_count: number;
  total_rows: number;
  windowed_rows: number;
  kept_rows_count: number;
  latest_time_bangkok: string;
  metrics: QcMetrics;
  weight: WeightSummary | null;
  tracing_rows: TracingRow[];
  server_time: string;
}

export function buildBatchSummaryItem(
  raw: RawBatchRecord,
  nowMs: number = Date.now(),
  todayBangkok: string = formatBangkokDateKey(new Date(nowMs)),
): BatchSummaryItem {
  const refIso = raw.last_data_at ?? raw.created_at;
  const refMs = new Date(refIso).getTime();
  const ageSec = Number.isFinite(refMs) ? Math.max(0, (nowMs - refMs) / 1000) : 0;
  const bkkDate = formatBangkokDateKey(refIso);
  return {
    ...raw,
    truck_plate: raw.truck_plate || "—",
    qc_name: raw.qc_name || "—",
    age_s: ageSec,
    age_label: formatAgeLabel(ageSec),
    freshness: freshnessDot(ageSec),
    bangkok_date: bkkDate,
    is_today: bkkDate === todayBangkok,
  };
}

/**
 * Pick the newest batch whose `last_data_at` (or `created_at` fallback) is within `active_ttl_s`.
 * Batches are expected to be sorted newest-first.
 */
export function selectAutoConnectBatchId(
  batches: readonly BatchSummaryItem[],
  activeTtlSec: number,
): string | null {
  if (batches.length === 0) return null;
  const sorted = [...batches].sort((a, b) => a.age_s - b.age_s);
  const newest = sorted[0]!;
  return newest.age_s <= activeTtlSec ? newest.id : null;
}

export function buildBatchDetailPayload(params: {
  batch: RawBatchRecord;
  rows: readonly RawInspectionRowRecord[];
  snapshotCount: number;
  settings: Settings;
  nowMs?: number;
}): BatchDetailResponse {
  const nowMs = params.nowMs ?? Date.now();
  const batchItem = buildBatchSummaryItem(params.batch, nowMs);
  const settings = params.settings;
  const rows = params.rows;

  const windowed = applyWindow(rows, settings.metrics_window_rows);
  const kept = windowed.filter(
    (r) => VALID_SNAPSHOT_TYPES.includes(r.snapshot_type) && r.snapshot_total > 0,
  );

  const metrics = computeQcMetrics(rows, settings, MODES.grain!);
  const weight = !metrics.empty ? summarizeWeight(metrics, settings) : null;

  const latestIso =
    rows.length > 0 ? rows[rows.length - 1]!.snapshot_time : params.batch.last_data_at;
  const latestBangkok = formatBangkokTimestamp(latestIso);

  const tracingRows: TracingRow[] = kept.map((r, idx) => ({
    row_index: idx,
    snapshot_time: formatBangkokTimestamp(r.snapshot_time),
    snapshot_time_iso: r.snapshot_time,
    truck_plate: batchItem.truck_plate,
    qc_name: batchItem.qc_name,
    snapshot_mix_summary: r.mix_raw,
    plate_number: r.plate_number,
    snapshot_total: r.snapshot_total,
  }));

  return {
    batch: batchItem,
    settings,
    snapshot_count: params.snapshotCount,
    total_rows: rows.length,
    windowed_rows: windowed.length,
    kept_rows_count: kept.length,
    latest_time_bangkok: latestBangkok,
    metrics,
    weight,
    tracing_rows: tracingRows,
    server_time: new Date(nowMs).toISOString(),
  };
}

export async function loadAppSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db.from("app_settings").select("key,value");
  if (error) throw new Error(`app_settings select: ${error.message}`);
  return applyAppSettingsRows(
    (data ?? []) as { key: string; value: number | string }[],
    DEFAULT_SETTINGS,
  );
}

export async function listDashboardBatches(
  db: SupabaseClient,
  nowMs: number = Date.now(),
): Promise<ListBatchesResponse> {
  const [settings, batchesRes] = await Promise.all([
    loadAppSettings(db),
    db
      .from("batches")
      .select(
        "id,mode,device_id,source_name,truck_plate,qc_name,started_at,last_data_at,row_count,created_at",
      )
      .order("last_data_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (batchesRes.error) {
    throw new Error(`batches select: ${batchesRes.error.message}`);
  }

  const todayBangkok = formatBangkokDateKey(new Date(nowMs));
  const items = ((batchesRes.data ?? []) as RawBatchRecord[]).map((b) =>
    buildBatchSummaryItem(b, nowMs, todayBangkok),
  );
  // Sort by lowest age_s first so newest activity is always at index 0
  items.sort((a, b) => a.age_s - b.age_s);

  return {
    batches: items,
    settings,
    active_batch_id: selectAutoConnectBatchId(items, settings.active_ttl_s),
    today_bangkok: todayBangkok,
    server_time: new Date(nowMs).toISOString(),
  };
}

const PAGE = 1000;

export async function getDashboardBatchDetail(
  db: SupabaseClient,
  batchId: string,
  nowMs: number = Date.now(),
): Promise<BatchDetailResponse | null> {
  const [settings, batchRes, snapCountRes] = await Promise.all([
    loadAppSettings(db),
    db
      .from("batches")
      .select(
        "id,mode,device_id,source_name,truck_plate,qc_name,started_at,last_data_at,row_count,created_at",
      )
      .eq("id", batchId)
      .maybeSingle(),
    db
      .from("snapshots")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", batchId),
  ]);

  if (batchRes.error) throw new Error(`batches select: ${batchRes.error.message}`);
  if (!batchRes.data) return null;
  if (snapCountRes.error) throw new Error(`snapshots count: ${snapCountRes.error.message}`);

  const rows: RawInspectionRowRecord[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await db
      .from("inspection_rows")
      .select(
        "id,snapshot_time,plate_number,snapshot_type,snapshot_total,estimated_grain_count,mix,mix_raw",
      )
      .eq("batch_id", batchId)
      .order("snapshot_time", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`inspection_rows select: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as RawInspectionRowRecord[]));
    from += data.length;
  }

  return buildBatchDetailPayload({
    batch: batchRes.data as RawBatchRecord,
    rows,
    snapshotCount: snapCountRes.count ?? 0,
    settings,
    nowMs,
  });
}

export const SNAPSHOTS_PER_PAGE = 16;
export const SNAPSHOT_SIGNED_URL_EXPIRY_SEC = 600; // 10 minutes (short expiry)

export interface RawSnapshotRecord {
  id: string;
  batch_id: string;
  filename: string;
  storage_path: string;
  thumb_path: string | null;
  plate_number: number | null;
  captured_at: string | null;
}

export interface SnapshotMatchedRowSummary {
  row_id?: number;
  snapshot_time_iso: string;
  snapshot_time_bangkok: string;
  plate_number: number;
  truck_plate: string;
  qc_name: string;
  snapshot_total: number;
  mix_raw: string;
  delta_s: number;
  same_plate: boolean;
  /** True when the snapshot had a plate number with no rows and fell back to another plate's row. */
  approximate: boolean;
}

export interface SnapshotGalleryItem {
  id: string;
  /** 0-based index within the filtered snapshot list (`0 .. total_filtered - 1`). */
  index: number;
  filename: string;
  plate_number: number | null;
  captured_at: string | null;
  captured_bangkok: string;
  storage_path: string;
  thumb_path: string | null;
  /** Signed URL for the grid card (thumbnail if available, otherwise falls back to full image). */
  thumb_url: string;
  /** Signed URL for the full-resolution image ("View larger" dialog). */
  full_url: string;
  row_match: SnapshotMatchedRowSummary | null;
}

export interface BatchSnapshotsResponse {
  batch_id: string;
  truck_plate: string;
  qc_name: string;
  snapshot_filename_tz: SnapshotFilenameTz;
  total_snapshots: number;
  total_filtered: number;
  matched_count: number;
  unmatched_count: number;
  available_plates: number[];
  plate_filter: number | null;
  page: number;
  page_size: number;
  total_pages: number;
  items: SnapshotGalleryItem[];
  server_time: string;
}

export type BulkSignedUrlSigner = (
  paths: readonly string[],
  expiresInSec: number,
) => Promise<Map<string, string>>;

/**
 * Pure builder for the Snapshots tab gallery payload + bulk signed URL resolution.
 * - Sorts snapshots newest first (by parsed filename timestamp in `snapshot_filename_tz`, then `captured_at`, then `filename desc`).
 * - Matches each snapshot to the closest valid inspection row (same plate first, then within ±15 s) in memory without N+1 queries.
 * - Signs URLs in ONE bulk call (`signUrls`) ONLY for the current page's items (`16` per page).
 * - Falls back `thumb_url` to `full_url` whenever `thumb_path` is null or lacks a signed URL.
 */
export async function buildBatchSnapshotsPayload(params: {
  batch: Pick<RawBatchRecord, "id" | "truck_plate" | "qc_name">;
  snapshots: readonly RawSnapshotRecord[];
  rows: readonly RawInspectionRowRecord[];
  settings: Settings;
  page?: number;
  pageSize?: number;
  plateFilter?: number | null;
  toleranceSeconds?: number;
  signUrls: BulkSignedUrlSigner;
  nowMs?: number;
}): Promise<BatchSnapshotsResponse> {
  const nowMs = params.nowMs ?? Date.now();
  const tz = params.settings.snapshot_filename_tz ?? "UTC";
  const toleranceSeconds = params.toleranceSeconds ?? 15;
  const pageSize = Math.max(1, Math.min(64, Math.trunc(params.pageSize ?? SNAPSHOTS_PER_PAGE)));
  const truckPlate = params.batch.truck_plate || "—";
  const qcName = params.batch.qc_name || "—";

  // Valid scan rows (matching legacy `valid_scan = scan_df.dropna(subset=["snapshot_time"])`)
  const validRows = params.rows.filter(
    (r) => VALID_SNAPSHOT_TYPES.includes(r.snapshot_type) && r.snapshot_total > 0,
  );

  // Enrich snapshots with parsed timestamp + plate using `snapshot_filename_tz`
  const enriched = params.snapshots.map((s) => {
    const meta = parseSnapshotMeta(s.filename, tz);
    const effectiveTs =
      meta.ts ?? (s.captured_at ? new Date(s.captured_at) : null);
    const effectiveMs =
      effectiveTs && !Number.isNaN(effectiveTs.getTime()) ? effectiveTs.getTime() : null;
    const effectivePlate = s.plate_number ?? meta.plate;
    const match = matchSnapshotToRow(
      {
        filename: s.filename,
        plate_number: effectivePlate,
        captured_at: effectiveTs,
      },
      validRows,
      tz,
      toleranceSeconds,
    );
    return {
      raw: s,
      effectiveIso: effectiveMs !== null ? new Date(effectiveMs).toISOString() : s.captured_at,
      effectiveMs,
      effectivePlate,
      match,
    };
  });

  // Sort newest first (largest timestamp first, fallback filename descending, matching legacy `sorted(..., reverse=True)`)
  enriched.sort((a, b) => {
    if (a.effectiveMs !== null && b.effectiveMs !== null && a.effectiveMs !== b.effectiveMs) {
      return b.effectiveMs - a.effectiveMs;
    }
    if (a.effectiveMs !== null && b.effectiveMs === null) return -1;
    if (a.effectiveMs === null && b.effectiveMs !== null) return 1;
    return b.raw.filename.localeCompare(a.raw.filename);
  });

  const platesSet = new Set<number>();
  for (const item of enriched) {
    if (item.effectivePlate !== null && item.effectivePlate !== undefined) {
      platesSet.add(item.effectivePlate);
    }
  }
  const availablePlates = [...platesSet].sort((a, b) => a - b);

  const plateFilter =
    params.plateFilter !== null && params.plateFilter !== undefined && Number.isFinite(params.plateFilter)
      ? Math.trunc(params.plateFilter)
      : null;

  const filtered =
    plateFilter !== null
      ? enriched.filter((item) => item.effectivePlate === plateFilter)
      : enriched;

  let matchedCount = 0;
  for (const item of filtered) {
    if (item.match) matchedCount += 1;
  }
  const unmatchedCount = filtered.length - matchedCount;

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Math.max(1, Math.trunc(params.page ?? 1));
  const safePage = Math.min(requestedPage, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const pageSlice = filtered.slice(startIdx, startIdx + pageSize);

  // Collect storage paths ONLY for the current page and sign in ONE bulk call
  const pathsToSign = new Set<string>();
  for (const entry of pageSlice) {
    const displayPaths = resolveSnapshotDisplayPaths(entry.raw);
    pathsToSign.add(displayPaths.fullPath);
    pathsToSign.add(displayPaths.thumbOrFullPath);
  }

  const signedUrlMap =
    pathsToSign.size > 0
      ? await params.signUrls([...pathsToSign], SNAPSHOT_SIGNED_URL_EXPIRY_SEC)
      : new Map<string, string>();

  const items: SnapshotGalleryItem[] = pageSlice.map((entry, idx) => {
    const globalIdx = startIdx + idx;
    const displayPaths = resolveSnapshotDisplayPaths(entry.raw);
    const fullSigned = signedUrlMap.get(displayPaths.fullPath) ?? "";
    const thumbCandidate =
      displayPaths.thumbOrFullPath !== displayPaths.fullPath
        ? signedUrlMap.get(displayPaths.thumbOrFullPath) ?? null
        : null;
    const resolvedUrls = resolveSnapshotDisplayUrls({
      fullUrl: fullSigned,
      thumbUrl: thumbCandidate,
    });

    const matchedRowTime = entry.match?.row.snapshot_time as Date | string | undefined;
    const rowMatch: SnapshotMatchedRowSummary | null =
      entry.match && matchedRowTime
        ? {
            row_id: entry.match.row.id,
            snapshot_time_iso:
              typeof matchedRowTime === "string"
                ? matchedRowTime
                : matchedRowTime.toISOString(),
            snapshot_time_bangkok: formatBangkokTimestamp(matchedRowTime),
            plate_number: entry.match.row.plate_number,
            truck_plate: truckPlate,
            qc_name: qcName,
            snapshot_total: entry.match.row.snapshot_total ?? 0,
            mix_raw: entry.match.row.mix_raw ?? "",
            delta_s: Math.round(entry.match.deltaSeconds * 10) / 10,
            same_plate: entry.match.samePlate,
            approximate: entry.match.approximate,
          }
        : null;

    return {
      id: entry.raw.id,
      index: globalIdx,
      filename: entry.raw.filename,
      plate_number: entry.effectivePlate,
      captured_at: entry.effectiveIso,
      captured_bangkok: entry.effectiveIso
        ? formatBangkokTimestamp(entry.effectiveIso)
        : "Timestamp unavailable",
      storage_path: entry.raw.storage_path,
      thumb_path: entry.raw.thumb_path,
      thumb_url: resolvedUrls.thumbUrl,
      full_url: resolvedUrls.fullUrl,
      row_match: rowMatch,
    };
  });

  return {
    batch_id: params.batch.id,
    truck_plate: truckPlate,
    qc_name: qcName,
    snapshot_filename_tz: tz,
    total_snapshots: enriched.length,
    total_filtered: filtered.length,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    available_plates: availablePlates,
    plate_filter: plateFilter,
    page: safePage,
    page_size: pageSize,
    total_pages: totalPages,
    items,
    server_time: new Date(nowMs).toISOString(),
  };
}

export async function getDashboardBatchSnapshots(
  db: SupabaseClient,
  batchId: string,
  opts: {
    page?: number;
    pageSize?: number;
    plateFilter?: number | null;
    nowMs?: number;
  } = {},
): Promise<BatchSnapshotsResponse | null> {
  const [settings, batchRes] = await Promise.all([
    loadAppSettings(db),
    db
      .from("batches")
      .select("id,truck_plate,qc_name")
      .eq("id", batchId)
      .maybeSingle(),
  ]);

  if (batchRes.error) throw new Error(`batches select: ${batchRes.error.message}`);
  if (!batchRes.data) return null;

  // Fetch all snapshots and all valid inspection rows for the batch in parallel (no N+1 queries)
  const fetchAllSnapshots = async (): Promise<RawSnapshotRecord[]> => {
    const out: RawSnapshotRecord[] = [];
    for (let from = 0; ; ) {
      const { data, error } = await db
        .from("snapshots")
        .select("id,batch_id,filename,storage_path,thumb_path,plate_number,captured_at")
        .eq("batch_id", batchId)
        .order("captured_at", { ascending: false, nullsFirst: false })
        .order("filename", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`snapshots select: ${error.message}`);
      if (!data || data.length === 0) break;
      out.push(...(data as RawSnapshotRecord[]));
      from += data.length;
    }
    return out;
  };

  const fetchAllRows = async (): Promise<RawInspectionRowRecord[]> => {
    const out: RawInspectionRowRecord[] = [];
    for (let from = 0; ; ) {
      const { data, error } = await db
        .from("inspection_rows")
        .select(
          "id,snapshot_time,plate_number,snapshot_type,snapshot_total,estimated_grain_count,mix,mix_raw",
        )
        .eq("batch_id", batchId)
        .order("snapshot_time", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`inspection_rows select: ${error.message}`);
      if (!data || data.length === 0) break;
      out.push(...(data as RawInspectionRowRecord[]));
      from += data.length;
    }
    return out;
  };

  const [snapshots, rows] = await Promise.all([fetchAllSnapshots(), fetchAllRows()]);

  const signUrls: BulkSignedUrlSigner = async (paths, expiresInSec) => {
    const map = new Map<string, string>();
    if (paths.length === 0) return map;
    const { data, error } = await db.storage
      .from(SNAPSHOT_BUCKET)
      .createSignedUrls([...paths], expiresInSec);
    if (error) throw new Error(`createSignedUrls: ${error.message}`);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl && !item.error) {
        map.set(item.path, item.signedUrl);
      }
    }
    return map;
  };

  return buildBatchSnapshotsPayload({
    batch: batchRes.data as Pick<RawBatchRecord, "id" | "truck_plate" | "qc_name">,
    snapshots,
    rows,
    settings,
    page: opts.page,
    pageSize: opts.pageSize,
    plateFilter: opts.plateFilter,
    signUrls,
    nowMs: opts.nowMs,
  });
}
