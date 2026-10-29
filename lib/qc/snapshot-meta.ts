import { bangkokWallClockToDate, utcWallClockToDate } from "./time";
import {
  DEFAULT_SNAPSHOT_FILENAME_TZ,
  MODES,
  type SnapshotFilenameTz,
} from "./config";

export interface SnapshotMeta {
  ts: Date | null;
  plate: number | null;
}

const PLATE_RE = /_plate(\d+)/i;

function wallClockToDate(
  tz: SnapshotFilenameTz,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): Date | null {
  return tz === "Asia/Bangkok"
    ? bangkokWallClockToDate(y, mo, d, h, mi, s)
    : utcWallClockToDate(y, mo, d, h, mi, s);
}

export function tsFromFilename(
  fname: string,
  tz: SnapshotFilenameTz = DEFAULT_SNAPSHOT_FILENAME_TZ,
): Date | null {
  // 1. YYYYMMDD_HHMMSS (wall-clock in `snapshot_filename_tz`, default UTC).
  // Require no adjacent digit before the 8-digit date or after the 6-digit time so epoch prefixes don't overlap.
  const re1 = /(?<!\d)(\d{8}_\d{6})(?!\d)/g;
  for (let m = re1.exec(fname); m !== null; m = re1.exec(fname)) {
    const r = m[1]!;
    const d = wallClockToDate(
      tz,
      +r.slice(0, 4),
      +r.slice(4, 6),
      +r.slice(6, 8),
      +r.slice(9, 11),
      +r.slice(11, 13),
      +r.slice(13, 15),
    );
    if (d) return d;
  }
  // 2. YYYY-MM-DD HH-MM-SS or YYYY-MM-DD_HH-MM-SS
  let m = /(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/.exec(fname);
  if (m) {
    const d = wallClockToDate(tz, +m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    if (d) return d;
  }
  // 3. 13-digit epoch milliseconds
  m = /(\d{13})/.exec(fname);
  if (m?.[1]) {
    const d = new Date(Number(m[1]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  // 4. 10-digit epoch seconds
  m = /(\d{10})/.exec(fname);
  if (m?.[1]) {
    const d = new Date(Number(m[1]) * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Extract timestamp + plate number from a snapshot filename using `snapshot_filename_tz` (default `"UTC"`).
 * Handles:
 *  YYYYMMDD_HHMMSS_<Truck>_plateN.jpg, snapshot_<Truck>_YYYYMMDD_HHMMSS_plateN.jpg, and names without a plate.
 */
export function parseSnapshotMeta(
  fname: string,
  tz: SnapshotFilenameTz = DEFAULT_SNAPSHOT_FILENAME_TZ,
): SnapshotMeta {
  const m = PLATE_RE.exec(fname);
  const plate = m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
  return {
    ts: tsFromFilename(fname, tz),
    plate: plate !== null && Number.isFinite(plate) ? plate : null,
  };
}

export function isImageFilename(fname: string, modeId = "grain"): boolean {
  const exts = MODES[modeId]?.imageExts ?? [];
  const lower = fname.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

export interface MatchCandidate {
  filename: string;
  ts: Date | null;
  plate: number | null;
}

/**
 * Port of match_snapshot_image: closest filename timestamp to rowTs within tolerance.
 * Images with a plate number different from targetPlate are skipped; images without one are kept.
 */
export function matchSnapshot<T extends MatchCandidate>(
  rowTs: Date | null,
  images: readonly T[],
  targetPlate: number | null = null,
  toleranceSeconds = 15,
): T | null {
  if (!rowTs || images.length === 0) return null;
  let best: T | null = null;
  let bestDiff = Infinity;
  for (const img of images) {
    if (targetPlate !== null && img.plate !== null && img.plate !== targetPlate) continue;
    if (!img.ts) continue;
    const diff = Math.abs(img.ts.getTime() - rowTs.getTime()) / 1000;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = img;
    }
  }
  return best && bestDiff <= toleranceSeconds ? best : null;
}

export interface RowMatchCandidate {
  id?: number;
  snapshot_time: Date | string;
  plate_number: number;
  snapshot_total?: number;
  mix_raw?: string;
}

export interface SnapshotToRowMatch<R extends RowMatchCandidate = RowMatchCandidate> {
  row: R;
  deltaSeconds: number;
  samePlate: boolean;
  /**
   * True when the snapshot had a plate number (`plate_number !== null`), no valid row existed on
   * that plate in the batch, and the matcher fell back to matching a row from a different plate.
   */
  approximate: boolean;
}

/**
 * Port of the legacy gallery row matcher (x-26-10.py lines 2076–2105):
 * Given a snapshot (filename or pre-parsed timestamp/plate), find the closest CSV row within
 * `±toleranceSeconds` (default 15 s), prioritizing rows on the same plate first (and falling back
 * to all rows only when no rows exist for that plate).
 * When the snapshot specifies a plate number (`imgPlate !== null`) and falls back to another plate's
 * row because `imgPlate` has no rows, `approximate: true` is set so the API and UI never present
 * a cross-plate fallback as an exact match.
 */
export function matchSnapshotToRow<R extends RowMatchCandidate>(
  snap: { filename: string; plate_number?: number | null; captured_at?: Date | string | null },
  rows: readonly R[],
  tz: SnapshotFilenameTz = DEFAULT_SNAPSHOT_FILENAME_TZ,
  toleranceSeconds = 15,
): SnapshotToRowMatch<R> | null {
  if (rows.length === 0) return null;
  const meta = parseSnapshotMeta(snap.filename, tz);
  const imgTs =
    meta.ts ??
    (snap.captured_at instanceof Date
      ? snap.captured_at
      : typeof snap.captured_at === "string" && snap.captured_at
        ? new Date(snap.captured_at)
        : null);
  if (!imgTs || Number.isNaN(imgTs.getTime())) return null;

  const imgPlate = snap.plate_number ?? meta.plate;
  let targetRows: readonly R[] = rows;
  if (imgPlate !== null && imgPlate !== undefined) {
    const plateSubset = rows.filter((r) => r.plate_number === imgPlate);
    if (plateSubset.length > 0) {
      targetRows = plateSubset;
    }
  }

  let bestRow: R | null = null;
  let bestDiff = Infinity;
  const imgMs = imgTs.getTime();
  for (const r of targetRows) {
    const rowMs =
      r.snapshot_time instanceof Date
        ? r.snapshot_time.getTime()
        : new Date(r.snapshot_time).getTime();
    if (!Number.isFinite(rowMs)) continue;
    const diff = Math.abs(rowMs - imgMs) / 1000;
    if (diff < bestDiff) {
      bestDiff = diff;
      bestRow = r;
    }
  }

  if (!bestRow || bestDiff > toleranceSeconds) return null;
  const hasSnapshotPlate = imgPlate !== null && imgPlate !== undefined;
  const samePlate = hasSnapshotPlate ? bestRow.plate_number === imgPlate : true;
  const approximate = hasSnapshotPlate && bestRow.plate_number !== imgPlate;
  return {
    row: bestRow,
    deltaSeconds: bestDiff,
    samePlate,
    approximate,
  };
}
