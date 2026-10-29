/**
 * Phase 6: Server-side Thai/English QC PDF Report Generator (`pdfkit`, pure JS, no headless Chromium).
 *
 * Strictly reuses `computeQcMetrics` (`lib/qc/metrics.ts`), `formatSeeds` / `summarizeWeight` (`lib/qc/format.ts`),
 * `round1`, and `matchSnapshotToRow` (`lib/qc/snapshot-meta.ts`). Never recomputes QC numbers independently.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RawBatchRecord,
  RawInspectionRowRecord,
  RawSnapshotRecord,
} from "@/lib/dashboard/queries";
import { loadAppSettings } from "@/lib/dashboard/queries";
import {
  SNAPSHOT_BUCKET,
  resolveSnapshotDisplayPaths,
} from "@/lib/ingest/snapshots";
import {
  DEFAULT_REPORT_FOOTER_LEFT,
  DEFAULT_REPORT_FORM_CODE,
  DEFAULT_SETTINGS,
  GOOD_KEY,
  MODES,
  SEED_WEIGHT_G,
  VALID_SNAPSHOT_TYPES,
  WEIGHT_VALUES_MEASURED,
  type QcMode,
  type Settings,
  type SnapshotFilenameTz,
} from "@/lib/qc/config";
import { formatSeeds, summarizeWeight, type WeightSummary } from "@/lib/qc/format";
import {
  applyWindow,
  computeQcMetrics,
  round1,
  type BatchMetrics,
  type QcMetrics,
} from "@/lib/qc/metrics";
import { matchSnapshotToRow, parseSnapshotMeta } from "@/lib/qc/snapshot-meta";
import { formatBangkokTimestamp } from "@/lib/qc/time";

export const REPORT_BUCKET = "reports";

/**
 * Normalize a stored `public.reports.storage_path` to the object key inside the `reports` bucket.
 * Legacy rows were written as `reports/<batch_id>/<ts>.pdf` (redundant bucket prefix); new rows are
 * `<batch_id>/<ts>.pdf`. Strips a single leading `reports/`. Use wherever a stored path is read.
 */
export function normalizeReportKey(storagePath: string): string {
  return storagePath.startsWith(`${REPORT_BUCKET}/`)
    ? storagePath.slice(REPORT_BUCKET.length + 1)
    : storagePath;
}

/**
 * Create a signed URL for a stored report path, resolving both key forms without moving objects.
 * New rows: key is `<batch_id>/<ts>.pdf`. Legacy rows: the object was physically uploaded under the
 * literal key `reports/<batch_id>/<ts>.pdf`, so if the normalized key does not exist we fall back to the raw path.
 */
export async function createReportSignedUrl(
  db: SupabaseClient,
  storagePath: string,
  expiresInSec: number = REPORT_SIGNED_URL_EXPIRY_SEC,
): Promise<{ signedUrl: string | null; key: string | null; error: string | null }> {
  const normalized = normalizeReportKey(storagePath);
  const candidates = normalized === storagePath ? [storagePath] : [normalized, storagePath];
  let lastError: string | null = null;
  for (const key of candidates) {
    const { data, error } = await db.storage.from(REPORT_BUCKET).createSignedUrl(key, expiresInSec);
    if (!error && data?.signedUrl) return { signedUrl: data.signedUrl, key, error: null };
    lastError = error?.message ?? "no signedUrl";
  }
  return { signedUrl: null, key: null, error: lastError };
}
export const REPORT_SIGNED_URL_EXPIRY_SEC = 600; // 10 minutes
export const DEFAULT_MAX_REPORT_SNAPSHOTS = 6;
export const MAX_REPORT_SNAPSHOTS = 6;
export const SNAPSHOT_FETCH_TIMEOUT_MS = 6000;

export interface ReportSnapshotEntry {
  id: string;
  labelThEn: string;
  filename: string;
  plateNumber: number | null;
  capturedBangkok: string;
  rowMatchLine: string;
  approximate: boolean;
  hasMatch: boolean;
  /** Preferred storage path for PDF embedding (thumbnail if available, fallback full image). */
  imageStoragePath: string;
  fullStoragePath: string;
  imageBytes?: Buffer | null;
}

export interface ReportModel {
  batchId: string;
  sourceName: string;
  deviceName: string;
  truckPlatesText: string;
  qcNamesText: string;
  primaryQcName: string;
  generatedAtIso: string;
  generatedAtBangkok: string;
  dataStartBangkok: string;
  dataEndBangkok: string;
  dateStrBangkok: string;
  timeStrBangkok: string;
  totalRows: number;
  keptRowsCount: number;
  settings: Settings;
  mode: QcMode;
  metrics: QcMetrics;
  weight: WeightSummary | null;
  weightFootnote: string;
  snapshots: ReportSnapshotEntry[];
}

const MM_TO_PT = 72 / 25.4;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 14 * MM_TO_PT; // 14 mm, matching legacy x-26-10.py line 967

let cachedRegularFont: Buffer | null = null;
let cachedBoldFont: Buffer | null = null;

export function loadBundledThaiFonts(): {
  regular: Buffer | null;
  bold: Buffer | null;
} {
  if (!cachedRegularFont || !cachedBoldFont) {
    const primaryReg = path.join(
      process.cwd(),
      "lib",
      "report",
      "fonts",
      "Sarabun-Regular.ttf",
    );
    const primaryBold = path.join(
      process.cwd(),
      "lib",
      "report",
      "fonts",
      "Sarabun-Bold.ttf",
    );
    const fallbackReg = path.join(__dirname, "fonts", "Sarabun-Regular.ttf");
    const fallbackBold = path.join(__dirname, "fonts", "Sarabun-Bold.ttf");

    if (existsSync(primaryReg)) {
      cachedRegularFont = readFileSync(primaryReg);
    } else if (existsSync(fallbackReg)) {
      cachedRegularFont = readFileSync(fallbackReg);
    }

    if (existsSync(primaryBold)) {
      cachedBoldFont = readFileSync(primaryBold);
    } else if (existsSync(fallbackBold)) {
      cachedBoldFont = readFileSync(fallbackBold);
    }
  }
  return { regular: cachedRegularFont, bold: cachedBoldFont };
}

function formatDateAndTimePartsBangkok(iso: string | null | undefined): {
  dateStr: string;
  timeStr: string;
} {
  const formatted = formatBangkokTimestamp(iso);
  if (formatted === "—") return { dateStr: "—", timeStr: "—" };
  const [timePart, datePart] = formatted.split(" · ");
  return {
    dateStr: datePart ?? "—",
    timeStr: timePart ? timePart.slice(0, 5) : "—",
  };
}

/**
 * Select up to `maxSnapshots` (default 6) representative snapshots for the PDF report:
 * - Port of `_select_best_snapshot_per_plate` (`x-26-10.py` lines 885–958) + row-match line with
 *   `approximate` cross-plate fallback detection.
 * - Prefers one snapshot per active plate (highest `snapshot_total` within active scan window,
 *   fallback newest on that plate), then fills remaining slots up to `maxSnapshots` with newest snapshots.
 * - Uses thumbnail path (`thumb_path`) when available, falling back to `storage_path`.
 */
export function selectReportSnapshots(params: {
  snapshots: readonly RawSnapshotRecord[];
  rows: readonly RawInspectionRowRecord[];
  truckPlate: string;
  qcName: string;
  tz: SnapshotFilenameTz;
  maxSnapshots?: number;
}): ReportSnapshotEntry[] {
  const maxSnapshots = Math.max(
    1,
    Math.min(24, Math.trunc(params.maxSnapshots ?? DEFAULT_MAX_REPORT_SNAPSHOTS)),
  );
  if (params.snapshots.length === 0) return [];

  const validRows = params.rows.filter(
    (r) => VALID_SNAPSHOT_TYPES.includes(r.snapshot_type) && r.snapshot_total > 0,
  );

  const enriched = params.snapshots.map((s) => {
    const meta = parseSnapshotMeta(s.filename, params.tz);
    const effectiveTs =
      meta.ts ?? (s.captured_at ? new Date(s.captured_at) : null);
    const effectiveMs =
      effectiveTs && !Number.isNaN(effectiveTs.getTime()) ? effectiveTs.getTime() : null;
    const effectiveIso =
      effectiveMs !== null ? new Date(effectiveMs).toISOString() : s.captured_at;
    const effectivePlate = s.plate_number ?? meta.plate;
    const match = matchSnapshotToRow(
      {
        filename: s.filename,
        plate_number: effectivePlate,
        captured_at: effectiveTs,
      },
      validRows,
      params.tz,
      15,
    );
    return {
      raw: s,
      effectiveTs,
      effectiveMs,
      effectiveIso,
      effectivePlate,
      match,
    };
  });

  // Sort newest first
  enriched.sort((a, b) => {
    if (a.effectiveMs !== null && b.effectiveMs !== null && a.effectiveMs !== b.effectiveMs) {
      return b.effectiveMs - a.effectiveMs;
    }
    if (a.effectiveMs !== null && b.effectiveMs === null) return -1;
    if (a.effectiveMs === null && b.effectiveMs !== null) return 1;
    return b.raw.filename.localeCompare(a.raw.filename);
  });

  const byPlate = new Map<number, typeof enriched>();
  for (const item of enriched) {
    if (item.effectivePlate !== null && item.effectivePlate !== undefined) {
      const list = byPlate.get(item.effectivePlate);
      if (list) list.push(item);
      else byPlate.set(item.effectivePlate, [item]);
    }
  }

  const chosen: { labelThEn: string; entry: (typeof enriched)[number] }[] = [];
  const chosenIds = new Set<string>();

  const plateNums = [...byPlate.keys()].sort((a, b) => a - b);
  for (const p of plateNums) {
    if (chosen.length >= maxSnapshots) break;
    const candidates = byPlate.get(p) ?? [];
    if (candidates.length === 0) continue;

    // Pick candidate with highest matched `snapshot_total` on the same plate (or newest fallback)
    let best = candidates[0]!;
    let bestScore = -1;
    let bestNegDiff = -Infinity;
    for (const c of candidates) {
      if (c.match && c.match.samePlate) {
        const score = c.match.row.snapshot_total ?? 0;
        const negDiff = -c.match.deltaSeconds;
        if (score > bestScore || (score === bestScore && negDiff > bestNegDiff)) {
          bestScore = score;
          bestNegDiff = negDiff;
          best = c;
        }
      }
    }
    chosen.push({
      labelThEn: `จานที่ ${p} (Plate ${p})`,
      entry: best,
    });
    chosenIds.add(best.raw.id);
  }

  // If no plated snapshots or fewer than maxSnapshots, fill from newest remaining
  if (chosen.length === 0) {
    for (const item of enriched.slice(0, maxSnapshots)) {
      const idx = chosen.length + 1;
      chosen.push({
        labelThEn: `ตัวอย่าง ${idx} (Sample ${idx})`,
        entry: item,
      });
      chosenIds.add(item.raw.id);
    }
  }

  return chosen.slice(0, maxSnapshots).map(({ labelThEn, entry }) => {
    const displayPaths = resolveSnapshotDisplayPaths(entry.raw);
    const capturedBangkok = entry.effectiveIso
      ? formatBangkokTimestamp(entry.effectiveIso)
      : "Timestamp unavailable";

    let rowMatchLine = "⚠️ No matching row";
    let approximate = false;
    let hasMatch = false;
    if (entry.match) {
      hasMatch = true;
      approximate = entry.match.approximate;
      const mRow = entry.match.row;
      const rowTimeBangkok = formatBangkokTimestamp(mRow.snapshot_time);
      const plateStr = `Plate ${mRow.plate_number} · `;
      if (approximate) {
        rowMatchLine = `Row match (other plate · approximate): ${plateStr}${params.truckPlate || "—"} · QC: ${params.qcName || "—"} (${rowTimeBangkok})`;
      } else {
        rowMatchLine = `Row match: ${plateStr}${params.truckPlate || "—"} · QC: ${params.qcName || "—"} (${rowTimeBangkok})`;
      }
    }

    return {
      id: entry.raw.id,
      labelThEn,
      filename: entry.raw.filename,
      plateNumber: entry.effectivePlate,
      capturedBangkok,
      rowMatchLine,
      approximate,
      hasMatch,
      imageStoragePath: displayPaths.thumbOrFullPath,
      fullStoragePath: displayPaths.fullPath,
    };
  });
}

export function buildWeightFootnote(
  metrics: QcMetrics,
  settings: Settings,
): string {
  const goodW = settings.good_seed_weight_g ?? SEED_WEIGHT_G.good;
  const immW = settings.immature_seed_weight_g ?? SEED_WEIGHT_G.immature;
  const smW = settings.sm_seed_weight_g ?? SEED_WEIGHT_G.sm;
  const dcW = settings.dc_seed_weight_g ?? SEED_WEIGHT_G.dc;
  const measuredStatus =
    (settings.weight_values_measured ?? WEIGHT_VALUES_MEASURED)
      ? "measured"
      : "ASSUMED, not measured";

  if (metrics.empty) {
    return (
      `* % by weight is an estimate computed from seed counts using per-class seed weights ` +
      `(good ${goodW} g, immature ${immW} g, spoiled/mold ${smW} g, discolor ${dcW} g per seed). ` +
      `Seed weights are ${measuredStatus}.`
    );
  }

  return (
    `* % by weight = estimated seeds per class × per-class seed weight: ` +
    `good ${Math.round(metrics.good_count_est).toLocaleString("en-US")} seeds × ${goodW} g = ${round1(metrics.good_weight_g).toFixed(1)} g; ` +
    `defects = ${round1(metrics.defect_weight_g).toFixed(1)} g, total = ${round1(metrics.total_weight_g).toFixed(1)} g est. ` +
    `(good ${goodW} g, immature ${immW} g, spoiled/mold ${smW} g, discolor ${dcW} g per seed). ` +
    `Seed weights are ${measuredStatus}; % by weight is an estimate.`
  );
}

/**
 * Build the complete report data model using `computeQcMetrics` and `summarizeWeight` directly.
 * Guaranteed to produce the exact same numbers as `buildBatchDetailPayload` (`lib/dashboard/queries.ts`).
 */
export function buildReportModel(params: {
  batch: RawBatchRecord;
  deviceName?: string | null;
  rows: readonly RawInspectionRowRecord[];
  snapshots?: readonly RawSnapshotRecord[];
  settings?: Settings;
  maxSnapshots?: number;
  generatedAt?: Date;
}): ReportModel {
  const settings = params.settings ?? DEFAULT_SETTINGS;
  const mode = MODES.grain!;
  const generatedAt = params.generatedAt ?? new Date();
  const rows = params.rows;

  const windowed = applyWindow(rows, settings.metrics_window_rows);
  const kept = windowed.filter(
    (r) => VALID_SNAPSHOT_TYPES.includes(r.snapshot_type) && r.snapshot_total > 0,
  );

  // Single source of truth: computeQcMetrics + summarizeWeight
  const metrics = computeQcMetrics(rows, settings, mode);
  const weight = !metrics.empty ? summarizeWeight(metrics, settings) : null;

  const truckPlate = params.batch.truck_plate || "—";
  const qcName = params.batch.qc_name || "—";

  const firstIso =
    rows.length > 0 ? rows[0]!.snapshot_time : params.batch.started_at;
  const lastIso =
    rows.length > 0
      ? rows[rows.length - 1]!.snapshot_time
      : params.batch.last_data_at;

  const { dateStr, timeStr } = formatDateAndTimePartsBangkok(lastIso);

  const selectedSnapshots = selectReportSnapshots({
    snapshots: params.snapshots ?? [],
    rows,
    truckPlate,
    qcName,
    tz: settings.snapshot_filename_tz ?? "UTC",
    maxSnapshots: params.maxSnapshots ?? DEFAULT_MAX_REPORT_SNAPSHOTS,
  });

  return {
    batchId: params.batch.id,
    sourceName: params.batch.source_name,
    deviceName: params.deviceName || (params.batch.device_id ?? "manual-import"),
    truckPlatesText: truckPlate,
    qcNamesText: qcName,
    primaryQcName: qcName,
    generatedAtIso: generatedAt.toISOString(),
    generatedAtBangkok: formatBangkokTimestamp(generatedAt),
    dataStartBangkok: formatBangkokTimestamp(firstIso),
    dataEndBangkok: formatBangkokTimestamp(lastIso),
    dateStrBangkok: dateStr,
    timeStrBangkok: timeStr,
    totalRows: rows.length,
    keptRowsCount: kept.length,
    settings,
    mode,
    metrics,
    weight,
    weightFootnote: buildWeightFootnote(metrics, settings),
    snapshots: selectedSnapshots,
  };
}

/**
 * Render a `ReportModel` into a PDF `Buffer` using `pdfkit` and bundled Thai Sarabun fonts.
 */
export async function renderQcReportPdf(model: ReportModel): Promise<Buffer> {
  const { regular, bold } = loadBundledThaiFonts();

  const doc = new PDFDocument({
    size: "A4",
    // Pass the bundled TTF Buffer directly so pdfkit never reads built-in .afm/.cjs font files at runtime
    font: (regular ?? "Helvetica") as unknown as string,
    margins: {
      top: PAGE_MARGIN,
      bottom: 18 * MM_TO_PT,
      left: PAGE_MARGIN,
      right: PAGE_MARGIN,
    },
    bufferPages: true,
    info: {
      Title: `Grain QC Report — ${model.sourceName}`,
      Author: `${model.settings.report_footer_left || DEFAULT_REPORT_FOOTER_LEFT} · AgriVision QC`,
      Subject: `Truck Plate: ${model.truckPlatesText} | QC: ${model.qcNamesText}`,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const FONT_REG = regular ? "ThaiFont" : "Helvetica";
  const FONT_BOLD = bold ? "ThaiFont-Bold" : "Helvetica-Bold";
  if (regular) doc.registerFont("ThaiFont", regular);
  if (bold) doc.registerFont("ThaiFont-Bold", bold);

  const W = A4_WIDTH - 2 * PAGE_MARGIN;
  const X0 = PAGE_MARGIN;
  let y = PAGE_MARGIN + 4;

  const ensureSpace = (neededPt: number) => {
    if (y + neededPt > A4_HEIGHT - 22 * MM_TO_PT) {
      doc.addPage();
      y = PAGE_MARGIN + 4;
    }
  };

  // ── 1. Title ──
  doc.font(FONT_BOLD).fontSize(13).fillColor("#0f172a");
  doc.text("รายงานผลการตรวจตัวอย่างคุณภาพเมล็ด", X0, y, {
    width: W,
    align: "center",
  });
  y = doc.y + 1;
  doc.font(FONT_BOLD).fontSize(11.5).fillColor("#0f172a");
  doc.text("Grain Quality Inspection Report", X0, y, {
    width: W,
    align: "center",
  });
  y = doc.y + 8;

  // ── 2. Header Info Table (matches x-26-10.py lines 1038–1070 + batch/device/time range) ──
  const totalPlates = !model.metrics.empty ? model.metrics.total_plates : 0;
  const scopeLabel =
    totalPlates > 0
      ? `${totalPlates} จานตัวอย่าง / ${totalPlates} Plate(s) Composite`
      : "0 จานตัวอย่าง / No valid scan rows";

  const dataRangeLabel =
    model.dataStartBangkok !== "—" && model.dataEndBangkok !== "—"
      ? `${model.dataStartBangkok}  →  ${model.dataEndBangkok}`
      : "—";

  const hdrBoxH = 58;
  doc.save();
  doc.rect(X0, y, W, hdrBoxH).fillAndStroke("#f2f7ff", "#0f172a");
  doc.strokeColor("#475569").lineWidth(0.5);
  doc.moveTo(X0, y + 19).lineTo(X0 + W, y + 19).stroke();
  doc.moveTo(X0, y + 38).lineTo(X0 + W, y + 38).stroke();
  doc.moveTo(X0 + W * 0.42, y).lineTo(X0 + W * 0.42, y + 38).stroke();
  doc.moveTo(X0 + W * 0.72, y).lineTo(X0 + W * 0.72, y + 19).stroke();

  const drawHdrCell = (
    x: number,
    cy: number,
    w: number,
    label: string,
    val: string,
  ) => {
    doc
      .font(FONT_BOLD)
      .fontSize(8.2)
      .fillColor("#0f172a")
      .text(`${label} ${val}`, x + 5, cy + 3.5, {
        width: w - 10,
        lineBreak: false,
        ellipsis: true,
      });
  };

  drawHdrCell(
    X0,
    y,
    W * 0.42,
    "ทะเบียนรถ / Truck Plate:",
    model.truckPlatesText,
  );
  drawHdrCell(
    X0 + W * 0.42,
    y,
    W * 0.3,
    "วันที่ / Date:",
    model.dateStrBangkok,
  );
  drawHdrCell(
    X0 + W * 0.72,
    y,
    W * 0.28,
    "เวลา / Time:",
    model.timeStrBangkok,
  );

  drawHdrCell(
    X0,
    y + 19,
    W * 0.42,
    "ผู้ตรวจ / Inspector (QC):",
    model.qcNamesText,
  );
  drawHdrCell(
    X0 + W * 0.42,
    y + 19,
    W * 0.58,
    "ขอบเขตการตรวจ / Scope:",
    scopeLabel,
  );

  drawHdrCell(
    X0,
    y + 38,
    W,
    "ไฟล์ / Batch:",
    `${model.sourceName}  |  Device: ${model.deviceName}  |  Range: ${dataRangeLabel}  |  Generated: ${model.generatedAtBangkok}`,
  );
  doc.restore();
  y += hdrBoxH + 8;

  // ── 3. Summary Strip (By Weight Good % / Defect %, "X g of Y g est.", Sample Count, Alert Status) ──
  if (model.metrics.empty) {
    doc.save();
    doc.rect(X0, y, W, 34).fillAndStroke("#fffbeb", "#f59e0b");
    doc
      .font(FONT_BOLD)
      .fontSize(9.5)
      .fillColor("#92400e")
      .text(
        "ไม่มีข้อมูลการตรวจวัดในแบตช์นี้ / No valid inspection rows in this batch yet.",
        X0 + 10,
        y + 10,
        { width: W - 20, align: "center" },
      );
    doc.restore();
    y += 44;
  } else {
    const m: BatchMetrics = model.metrics;
    const goodWtStr = `${round1(m.good_pct_wt).toFixed(1)}%`;
    const defWtStr = `${round1(m.total_defect_pct_wt).toFixed(1)}%`;
    const goodGramsStr = `${m.good_weight_g.toFixed(0)} g of ${m.total_weight_g.toFixed(0)} g est.`;
    const defGramsStr = `${m.defect_weight_g.toFixed(0)} g of ${m.total_weight_g.toFixed(0)} g est.`;
    const threshStr = `${round1(model.settings.defect_warn_threshold_pct).toFixed(1)}%`;
    const alertLabel = m.is_defect_high
      ? `ALERT: Defect >= ${threshStr} (Exceeds threshold)`
      : `OK: Defect < ${threshStr} (Within threshold)`;

    const cardGap = 6;
    const cardW = (W - cardGap * 3) / 4;
    const cardH = 44;

    const summaryCards = [
      {
        title: "เมล็ดดี (Good by wt)",
        val: `${goodWtStr} (${round1(m.pct[GOOD_KEY] ?? 0).toFixed(1)}% cnt)`,
        sub: `${goodGramsStr} · ${m.total_plates} plate(s)`,
        bg: "#f0fdf4",
        border: "#86efac",
        color: "#15803d",
      },
      {
        title: "ของเสียรวม (Total Defect by wt)",
        val: `${defWtStr} (${round1(m.total_defect_pct).toFixed(1)}% cnt)`,
        sub: defGramsStr,
        bg: m.is_defect_high ? "#fef2f2" : "#f8fafc",
        border: m.is_defect_high ? "#dc2626" : "#cbd5e1",
        color: m.is_defect_high ? "#dc2626" : "#0f172a",
      },
      {
        title: "จำนวนเมล็ด (Sample Count)",
        val: `${m.estimated_seeds.toLocaleString("en-US")} seeds`,
        sub: `Est. seeds (${m.total_plates} plate${m.total_plates > 1 ? "s" : ""})`,
        bg: "#f8fafc",
        border: "#cbd5e1",
        color: "#0f172a",
      },
      {
        title: "สถานะเกณฑ์เตือน (Alert Status)",
        val: m.is_defect_high ? "⚠ ALERT" : "✓ NORMAL",
        sub: alertLabel,
        bg: m.is_defect_high ? "#fef2f2" : "#f0fdf4",
        border: m.is_defect_high ? "#dc2626" : "#86efac",
        color: m.is_defect_high ? "#dc2626" : "#15803d",
      },
    ];

    summaryCards.forEach((c, idx) => {
      const cx = X0 + idx * (cardW + cardGap);
      doc.save();
      doc.roundedRect(cx, y, cardW, cardH, 4).fillAndStroke(c.bg, c.border);
      doc
        .font(FONT_BOLD)
        .fontSize(7)
        .fillColor("#475569")
        .text(c.title, cx + 6, y + 4, { width: cardW - 12, lineBreak: false });
      doc
        .font(FONT_BOLD)
        .fontSize(10.5)
        .fillColor(c.color)
        .text(c.val, cx + 6, y + 15, { width: cardW - 12, lineBreak: false });
      doc
        .font(FONT_REG)
        .fontSize(6.8)
        .fillColor("#475569")
        .text(c.sub, cx + 6, y + 30, { width: cardW - 12, lineBreak: false });
      doc.restore();
    });
    y += cardH + 8;
  }

  // ── 4. Main Inspection Table (matches x-26-10.py lines 1075–1186 + per-class weight %) ──
  const colW = [
    13 * MM_TO_PT,
    W - (13 + 18 + 27 + 27 + 44) * MM_TO_PT,
    18 * MM_TO_PT,
    27 * MM_TO_PT,
    27 * MM_TO_PT,
    44 * MM_TO_PT,
  ];
  const hdrH = 24;

  const drawTableRow = (
    cells: { text: string; subText?: string; align?: "left" | "center"; bold?: boolean }[],
    rowH: number,
    bgColor: string,
    isHeader = false,
  ) => {
    ensureSpace(rowH + 4);
    doc.save();
    doc.rect(X0, y, W, rowH).fillAndStroke(bgColor, "#334155");
    let cx = X0;
    for (let i = 0; i < colW.length; i++) {
      const w = colW[i]!;
      if (i > 0) {
        doc
          .strokeColor("#64748b")
          .lineWidth(0.4)
          .moveTo(cx, y)
          .lineTo(cx, y + rowH)
          .stroke();
      }
      const cell = cells[i]!;
      const align = cell.align ?? "center";
      const padX = align === "left" ? 5 : 2;
      doc
        .font(isHeader || cell.bold ? FONT_BOLD : FONT_REG)
        .fontSize(isHeader ? 7.6 : 8)
        .fillColor("#0f172a")
        .text(cell.text, cx + padX, y + (cell.subText ? 2.5 : 5.5), {
          width: w - padX * 2,
          align,
          lineBreak: false,
        });
      if (cell.subText) {
        doc
          .font(FONT_REG)
          .fontSize(6.4)
          .fillColor("#475569")
          .text(cell.subText, cx + padX, y + 12.5, {
            width: w - padX * 2,
            align,
            lineBreak: false,
          });
      }
      cx += w;
    }
    doc.restore();
    y += rowH;
  };

  drawTableRow(
    [
      { text: "ลำดับ", subText: "No.", bold: true },
      { text: "รายการตรวจสอบ", subText: "Inspection Item", align: "left", bold: true },
      { text: "หน่วย", subText: "Unit", bold: true },
      { text: "ผลตรวจ", subText: "% by Count", bold: true },
      { text: "ผลตรวจ", subText: "% by Weight*", bold: true },
      { text: "หมายเหตุ", subText: "Remark", bold: true },
    ],
    hdrH,
    "#d9e6f2",
    true,
  );

  const m = !model.metrics.empty ? model.metrics : null;
  let rowNo = 0;
  for (const cls of model.mode.classes) {
    rowNo += 1;
    const cntPct = m ? round1(m.pct[cls.key] ?? 0).toFixed(1) + "%" : "0.0%";
    const wtPctVal = m
      ? cls.key === GOOD_KEY
        ? round1(m.good_pct_wt)
        : round1(m.class_pct_wt[cls.key] ?? 0)
      : 0;
    const wtPct = `${wtPctVal.toFixed(1)}%`;
    const bg = rowNo % 2 === 1 ? "#ffffff" : "#f7faff";
    drawTableRow(
      [
        { text: String(rowNo) },
        {
          text: `จำนวน ${cls.label}`,
          subText: `${cls.label} — Count & Weight Ratio`,
          align: "left",
        },
        { text: "%" },
        { text: cntPct, bold: true },
        { text: wtPct, bold: true },
        { text: `Count: ${cntPct} | Wt: ${wtPct}` },
      ],
      22,
      bg,
    );
  }

  // Summary Row: Total Defect
  rowNo += 1;
  const defCntStr = m ? `${round1(m.total_defect_pct).toFixed(1)}%` : "0.0%";
  const defWtStr = m ? `${round1(m.total_defect_pct_wt).toFixed(1)}%` : "0.0%";
  const defRemark = m
    ? `${m.defect_weight_g.toFixed(0)} g of ${m.total_weight_g.toFixed(0)} g est.`
    : "";
  drawTableRow(
    [
      { text: String(rowNo) },
      {
        text: "เมล็ดบกพร่องรวม",
        subText: "Total Defect (SM + DC + Immature)",
        align: "left",
        bold: true,
      },
      { text: "%" },
      { text: defCntStr, bold: true },
      { text: defWtStr, bold: true },
      { text: defRemark },
    ],
    22,
    "#ffebeb",
  );

  // Summary Row: Good Grain Ratio
  rowNo += 1;
  const goodCntStr = m ? `${round1(m.pct[GOOD_KEY] ?? 0).toFixed(1)}%` : "0.0%";
  const goodWtStr = m ? `${round1(m.good_pct_wt).toFixed(1)}%` : "0.0%";
  const goodRemark = m
    ? `${m.good_weight_g.toFixed(0)} g of ${m.total_weight_g.toFixed(0)} g est.`
    : "";
  drawTableRow(
    [
      { text: String(rowNo) },
      {
        text: "อัตราส่วนเมล็ดดี",
        subText: "Good Grain Ratio",
        align: "left",
        bold: true,
      },
      { text: "%" },
      { text: goodCntStr, bold: true },
      { text: goodWtStr, bold: true },
      { text: goodRemark },
    ],
    22,
    "#e0ffe0",
  );

  // ── 5. Weight Footnote (IMPORTANT: per-class seed weights from app_settings, ASSUMED not measured, no fixed 500g mention) ──
  y += 4;
  doc
    .font(FONT_REG)
    .fontSize(7.2)
    .fillColor("#334155")
    .text(model.weightFootnote, X0, y, { width: W, align: "left" });
  y = doc.y + 8;

  // ── 6. Vector Quality Mix Bar Chart ──
  if (m) {
    const chartBoxH = 66;
    ensureSpace(chartBoxH + 10);
    doc.save();
    doc.roundedRect(X0, y, W, chartBoxH, 4).fillAndStroke("#f8fafc", "#cbd5e1");
    doc
      .font(FONT_BOLD)
      .fontSize(8.5)
      .fillColor("#0f172a")
      .text("สัดส่วนคุณภาพเมล็ด / Quality Mix (Vector Chart — % by Count)", X0 + 8, y + 5, {
        width: W - 16,
      });

    const barLabelW = 95;
    const barMaxW = W - barLabelW - 55;
    let barY = y + 20;
    for (const cls of model.mode.classes) {
      const pctVal = Math.max(0, Math.min(100, round1(m.pct[cls.key] ?? 0)));
      const fillW = Math.max(2, (pctVal / 100) * barMaxW);
      doc
        .font(FONT_REG)
        .fontSize(7.4)
        .fillColor("#0f172a")
        .text(cls.label, X0 + 8, barY, { width: barLabelW - 8, lineBreak: false });
      doc
        .rect(X0 + barLabelW, barY + 1.5, barMaxW, 7.5)
        .fill("#e2e8f0");
      doc
        .rect(X0 + barLabelW, barY + 1.5, fillW, 7.5)
        .fill(cls.color || "#16a34a");
      doc
        .font(FONT_BOLD)
        .fontSize(7.4)
        .fillColor("#0f172a")
        .text(`${pctVal.toFixed(1)}%`, X0 + barLabelW + barMaxW + 6, barY, {
          width: 42,
          lineBreak: false,
        });
      barY += 11;
    }
    doc.restore();
    y += chartBoxH + 8;
  }

  // ── 7. Per-Plate Breakdown Table + Plate Variance Flag ──
  if (m && m.plates.length > 0) {
    ensureSpace(45 + m.plates.length * 16);
    const spreadTxt =
      m.plates.length > 1
        ? m.has_high_variance
          ? `  |  ⚠ High Plate Variance: Spread ${round1(m.defect_spread).toFixed(1)}% >= ${round1(model.settings.plate_variance_spread_pct).toFixed(1)}% (Min ${round1(m.min_defect).toFixed(1)}%, Max ${round1(m.max_defect).toFixed(1)}%)`
          : `  |  Plate Variance Spread: ${round1(m.defect_spread).toFixed(1)}% (< ${round1(model.settings.plate_variance_spread_pct).toFixed(1)}% threshold)`
        : "  |  Single Plate";

    doc
      .font(FONT_BOLD)
      .fontSize(9)
      .fillColor("#0f172a")
      .text(
        `ผลตรวจแยกตามจานตัวอย่าง / Per-Plate Breakdown${spreadTxt}`,
        X0,
        y,
        { width: W },
      );
    y = doc.y + 3;

    const pHeaders = [
      "จาน / Plate",
      "Seeds",
      "Good %",
      "Immature %",
      "SM %",
      "DC %",
      "Defect %",
      "Good seeds (est.)",
    ];
    const pColW = W / pHeaders.length;
    const pRowH = 15;

    const drawPlateRow = (vals: string[], bg: string, isBold = false) => {
      ensureSpace(pRowH + 2);
      doc.save();
      doc.rect(X0, y, W, pRowH).fillAndStroke(bg, "#475569");
      vals.forEach((v, i) => {
        const cx = X0 + i * pColW;
        if (i > 0) {
          doc
            .strokeColor("#94a3b8")
            .lineWidth(0.4)
            .moveTo(cx, y)
            .lineTo(cx, y + pRowH)
            .stroke();
        }
        doc
          .font(isBold || i === 0 || i === 6 ? FONT_BOLD : FONT_REG)
          .fontSize(7.5)
          .fillColor("#0f172a")
          .text(v, cx + 2, y + 3, {
            width: pColW - 4,
            align: "center",
            lineBreak: false,
          });
      });
      doc.restore();
      y += pRowH;
    };

    drawPlateRow(pHeaders, "#d9e6f2", true);
    for (const p of m.plates) {
      const defRounded = round1(p.defect_pct);
      const isMax =
        m.plates.length > 1 &&
        defRounded === round1(m.max_defect) &&
        round1(m.max_defect) > round1(m.min_defect);
      const isMin =
        m.plates.length > 1 && defRounded === round1(m.min_defect);
      const bg = isMax ? "#fffbeb" : isMin ? "#f0fdf4" : "#ffffff";

      drawPlateRow(
        [
          `Plate ${p.plate}`,
          formatSeeds(p.seeds),
          `${round1(p.pct.good ?? 0).toFixed(1)}%`,
          `${round1(p.pct.immature ?? 0).toFixed(1)}%`,
          `${round1(p.pct.sm ?? 0).toFixed(1)}%`,
          `${round1(p.pct.dc ?? 0).toFixed(1)}%`,
          `${defRounded.toFixed(1)}%`,
          round1(p.good_seeds_est).toFixed(1),
        ],
        bg,
      );
    }
    y += 8;
  }

  // ── 8. Representative Snapshots (2-column grid, up to N=6, with row-match & approximate indicator) ──
  if (model.snapshots.length > 0) {
    ensureSpace(140);
    doc
      .font(FONT_BOLD)
      .fontSize(9.5)
      .fillColor("#0f172a")
      .text("ภาพตัวอย่างแต่ละจาน / Plate Sample Snapshots", X0, y, {
        width: W,
      });
    y = doc.y + 4;

    const colGap = 10;
    const cellW = (W - colGap) / 2;
    const imgH = 96;
    const cellH = imgH + 34;

    for (let i = 0; i < model.snapshots.length; i += 2) {
      ensureSpace(cellH + 8);
      const pair = model.snapshots.slice(i, i + 2);
      pair.forEach((snap, colIdx) => {
        const cx = X0 + colIdx * (cellW + colGap);
        doc.save();
        doc
          .roundedRect(cx, y, cellW, cellH, 4)
          .fillAndStroke("#ffffff", "#cbd5e1");

        if (snap.imageBytes && snap.imageBytes.length > 0) {
          try {
            doc.image(snap.imageBytes, cx + 4, y + 4, {
              fit: [cellW - 8, imgH - 4],
              align: "center",
              valign: "center",
            });
          } catch {
            doc
              .font(FONT_REG)
              .fontSize(7.5)
              .fillColor("#64748b")
              .text(`(Image preview unavailable: ${snap.filename})`, cx + 6, y + imgH / 2 - 4, {
                width: cellW - 12,
                align: "center",
              });
          }
        } else {
          doc
            .rect(cx + 4, y + 4, cellW - 8, imgH - 4)
            .fill("#f1f5f9");
          doc
            .font(FONT_REG)
            .fontSize(7.5)
            .fillColor("#64748b")
            .text(`${snap.labelThEn} — ${snap.filename}`, cx + 6, y + imgH / 2 - 4, {
              width: cellW - 12,
              align: "center",
            });
        }

        doc
          .font(FONT_BOLD)
          .fontSize(7.2)
          .fillColor("#0f172a")
          .text(
            `${snap.labelThEn} · ${snap.capturedBangkok} · ${snap.filename}`,
            cx + 5,
            y + imgH + 2,
            { width: cellW - 10, lineBreak: false, ellipsis: true },
          );
        doc
          .font(FONT_REG)
          .fontSize(6.8)
          .fillColor(
            snap.hasMatch && !snap.approximate ? "#15803d" : "#b45309",
          )
          .text(snap.rowMatchLine, cx + 5, y + imgH + 13, {
            width: cellW - 10,
            lineBreak: false,
            ellipsis: true,
          });
        doc.restore();
      });
      y += cellH + 6;
    }
  }

  // ── 9. Signature Block (matches x-26-10.py lines 1289–1306) ──
  ensureSpace(46);
  y += 8;
  doc
    .font(FONT_REG)
    .fontSize(8.5)
    .fillColor("#0f172a")
    .text(
      "ผู้ตรวจ / Inspector: ...........................................",
      X0,
      y,
      { width: W / 2, align: "center" },
    );
  doc.text(
    "ผู้อนุมัติ / Approved by: ...........................................",
    X0 + W / 2,
    y,
    { width: W / 2, align: "center" },
  );
  y += 14;
  doc
    .font(FONT_REG)
    .fontSize(8)
    .fillColor("#64748b")
    .text(`(${model.primaryQcName})`, X0, y, {
      width: W / 2,
      align: "center",
    });

  // ── 10. Top Accent Line + Consistent Footer with Page Numbers across all buffered pages ──
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i);
    doc.save();
    // Top green accent line (matches x-26-10.py line 1312)
    doc
      .strokeColor("#66b833")
      .lineWidth(2)
      .moveTo(PAGE_MARGIN, 8 * MM_TO_PT)
      .lineTo(A4_WIDTH - PAGE_MARGIN, 8 * MM_TO_PT)
      .stroke();

    // Footer separator line
    const footerLineY = A4_HEIGHT - 12 * MM_TO_PT;
    doc
      .strokeColor("#64748b")
      .lineWidth(0.4)
      .moveTo(PAGE_MARGIN, footerLineY)
      .lineTo(A4_WIDTH - PAGE_MARGIN, footerLineY)
      .stroke();

    // Footer text (left: report_footer_left + generated timestamp in Bangkok; right: report_form_code | Page X / Y)
    const footerLeft =
      model.settings.report_footer_left?.trim() || DEFAULT_REPORT_FOOTER_LEFT;
    const formCode =
      model.settings.report_form_code?.trim() || DEFAULT_REPORT_FORM_CODE;
    const footerTextY = A4_HEIGHT - 9.5 * MM_TO_PT;
    doc
      .font(FONT_REG)
      .fontSize(6.8)
      .fillColor("#64748b")
      .text(
        `${footerLeft} — Generated: ${model.generatedAtBangkok} (Asia/Bangkok)`,
        PAGE_MARGIN,
        footerTextY,
        { width: W * 0.7, align: "left", lineBreak: false },
      );
    doc.text(
      `${formCode}  |  Page ${i + 1} / ${totalPages}`,
      PAGE_MARGIN + W * 0.7,
      footerTextY,
      { width: W * 0.3, align: "right", lineBreak: false },
    );
    doc.restore();
  }

  doc.end();
  return done;
}

async function downloadSnapshotBufferWithTimeout(
  db: SupabaseClient,
  primaryPath: string,
  fallbackPath: string,
  timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS,
): Promise<Buffer | null> {
  const tryDownload = async (storagePath: string): Promise<Buffer | null> => {
    const timeoutPromise = new Promise<null>((resolve) => {
      const id = setTimeout(() => resolve(null), timeoutMs);
      id.unref?.();
    });
    const downloadPromise = (async () => {
      const { data, error } = await db.storage
        .from(SNAPSHOT_BUCKET)
        .download(storagePath);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    })();
    return Promise.race([downloadPromise, timeoutPromise]);
  };

  try {
    const primary = await tryDownload(primaryPath);
    if (primary && primary.length > 0) return primary;
    if (fallbackPath !== primaryPath) {
      return await tryDownload(fallbackPath);
    }
    return null;
  } catch {
    return null;
  }
}

export interface GeneratedReportResult {
  report_id: string | null;
  batch_id: string;
  filename: string;
  storage_path: string;
  signed_url: string;
  expires_in_sec: number;
  created_at: string;
}

const PAGE = 1000;

/**
 * Full server-side workflow for `POST /api/batches/[id]/report`:
 * 1. Loads `app_settings`, `batches`, `devices`, `inspection_rows`, and `snapshots` in parallel.
 * 2. Builds `ReportModel` via `computeQcMetrics` (no duplicate math).
 * 3. Downloads up to `maxSnapshots` (default 6) representative thumbnails in parallel with timeout.
 * 4. Renders the PDF buffer, uploads to private `reports` bucket (key `<batch_id>/<timestamp>.pdf`),
 *    inserts a row into `public.reports`, and creates a 10-minute signed URL.
 */
export async function generateAndStoreBatchReport(
  db: SupabaseClient,
  batchId: string,
  opts: { maxSnapshots?: number; createdBy?: string | null; now?: Date } = {},
): Promise<GeneratedReportResult | null> {
  const now = opts.now ?? new Date();
  const requestedSnapshots = opts.maxSnapshots ?? DEFAULT_MAX_REPORT_SNAPSHOTS;
  const maxSnapshots = Math.min(
    Math.max(1, Math.trunc(requestedSnapshots)),
    MAX_REPORT_SNAPSHOTS,
  );

  const [settings, batchRes] = await Promise.all([
    loadAppSettings(db),
    db
      .from("batches")
      .select(
        "id,mode,device_id,source_name,truck_plate,qc_name,started_at,last_data_at,row_count,created_at",
      )
      .eq("id", batchId)
      .maybeSingle(),
  ]);

  if (batchRes.error) throw new Error(`batches select: ${batchRes.error.message}`);
  if (!batchRes.data) return null;
  const batch = batchRes.data as RawBatchRecord;

  const fetchDeviceName = async (): Promise<string | null> => {
    if (!batch.device_id) return "manual-import";
    const { data } = await db
      .from("devices")
      .select("name")
      .eq("id", batch.device_id)
      .maybeSingle();
    return (data as { name?: string } | null)?.name ?? batch.device_id;
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

  const [deviceName, rows, snapshots] = await Promise.all([
    fetchDeviceName(),
    fetchAllRows(),
    fetchAllSnapshots(),
  ]);

  const model = buildReportModel({
    batch,
    deviceName,
    rows,
    snapshots,
    settings,
    maxSnapshots,
    generatedAt: now,
  });

  // Fetch representative snapshot thumbnails in parallel with per-image timeout
  if (model.snapshots.length > 0) {
    const buffers = await Promise.all(
      model.snapshots.map((s) =>
        downloadSnapshotBufferWithTimeout(db, s.imageStoragePath, s.fullStoragePath),
      ),
    );
    model.snapshots.forEach((s, i) => {
      s.imageBytes = buffers[i] ?? null;
    });
  }

  const pdfBuffer = await renderQcReportPdf(model);

  const tsCompact = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const safeStem = batch.source_name
    .replace(/\.csv$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
  const filename = `report_grain_${safeStem}_${tsCompact}.pdf`;
  // Object key inside the `reports` bucket (no bucket-name prefix); same value stored in public.reports.storage_path
  const storagePath = `${batchId}/${tsCompact}.pdf`;

  const { error: uploadError } = await db.storage
    .from(REPORT_BUCKET)
    .upload(storagePath, pdfBuffer, {
      upsert: true,
      contentType: "application/pdf",
    });
  if (uploadError) {
    throw new Error(`reports storage upload: ${uploadError.message}`);
  }

  const signed = await createReportSignedUrl(db, storagePath, REPORT_SIGNED_URL_EXPIRY_SEC);
  const signedData = signed.signedUrl ? { signedUrl: signed.signedUrl } : null;
  const signError = signed.error ? { message: signed.error } : null;
  if (signError || !signedData?.signedUrl) {
    throw new Error(`reports createSignedUrl: ${signError?.message ?? "no signedUrl"}`);
  }

  // Record in `public.reports` table (columns in 20261028000001_schema.sql:
  // id, batch_id, storage_path, filename, params, created_by, created_at)
  const { data: repRow, error: repError } = await db
    .from("reports")
    .insert({
      batch_id: batchId,
      storage_path: storagePath,
      filename,
      params: {
        max_snapshots: maxSnapshots,
        metrics_window_rows: settings.metrics_window_rows,
        good_seed_weight_g: settings.good_seed_weight_g,
        immature_seed_weight_g: settings.immature_seed_weight_g,
        sm_seed_weight_g: settings.sm_seed_weight_g,
        dc_seed_weight_g: settings.dc_seed_weight_g,
        report_footer_left: settings.report_footer_left,
        report_form_code: settings.report_form_code,
      },
      created_by: opts.createdBy ?? null,
    })
    .select("id,created_at")
    .maybeSingle();

  if (repError) {
    throw new Error(`reports insert: ${repError.message}`);
  }

  return {
    report_id: (repRow as { id?: string } | null)?.id ?? null,
    batch_id: batchId,
    filename,
    storage_path: storagePath,
    signed_url: signedData.signedUrl,
    expires_in_sec: REPORT_SIGNED_URL_EXPIRY_SEC,
    created_at:
      (repRow as { created_at?: string } | null)?.created_at ?? now.toISOString(),
  };
}
