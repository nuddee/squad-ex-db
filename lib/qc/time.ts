import { DEVICE_UTC_OFFSET_MIN } from "./config";

const MS_PER_MIN = 60_000;

function validDateParts(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

/** Build an instant from a wall-clock reading in the device timezone (Asia/Bangkok, UTC+7). */
export function bangkokWallClockToDate(
  y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0,
): Date | null {
  if (!validDateParts(y, mo, d, h, mi, s)) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - DEVICE_UTC_OFFSET_MIN * MS_PER_MIN);
}

/** Build an instant from a wall-clock reading in UTC. */
export function utcWallClockToDate(
  y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0,
): Date | null {
  if (!validDateParts(y, mo, d, h, mi, s)) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
}

const CSV_TS =
  /^\s*(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\s*$/;

/**
 * Parse a CSV timestamp. Naive values are interpreted as Asia/Bangkok wall-clock.
 * Values that carry an explicit offset/Z are honoured as real instants.
 * Returns null when unparseable (caller skips the row).
 */
export function parseCsvTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = CSV_TS.exec(raw);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, tz] = m;
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  const parts = [ys, mos, ds, hs, mis, ss].map(Number) as [number, number, number, number, number, number];
  if (!tz) return bangkokWallClockToDate(...parts, ms);
  if (!validDateParts(...parts)) return null;
  let offMin = 0;
  if (tz !== "Z") {
    const sign = tz.startsWith("-") ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4) || "0");
    offMin = sign * (oh * 60 + om);
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], ms) - offMin * MS_PER_MIN);
}

function toBangkokShiftedDate(input: Date | string | number | null | undefined): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + DEVICE_UTC_OFFSET_MIN * MS_PER_MIN);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format an instant in Asia/Bangkok (UTC+7) as `HH:mm:ss · dd/MM/yyyy` (matches legacy `strftime("%H:%M:%S · %d/%m/%Y")`).
 */
export function formatBangkokTimestamp(input: Date | string | number | null | undefined): string {
  const shifted = toBangkokShiftedDate(input);
  if (!shifted) return "—";
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = pad2(shifted.getUTCSeconds());
  const dd = pad2(shifted.getUTCDate());
  const mo = pad2(shifted.getUTCMonth() + 1);
  const yyyy = shifted.getUTCFullYear();
  return `${hh}:${mm}:${ss} · ${dd}/${mo}/${yyyy}`;
}

/**
 * Format an instant in Asia/Bangkok (UTC+7) as `yyyy-MM-dd` for grouping batches by local Bangkok calendar day.
 */
export function formatBangkokDateKey(input: Date | string | number | null | undefined): string {
  const shifted = toBangkokShiftedDate(input);
  if (!shifted) return "unknown";
  const yyyy = shifted.getUTCFullYear();
  const mo = pad2(shifted.getUTCMonth() + 1);
  const dd = pad2(shifted.getUTCDate());
  return `${yyyy}-${mo}-${dd}`;
}

/** Human-readable age string matching legacy `_age_label(age_s)`. */
export function formatAgeLabel(ageSec: number): string {
  const s = Math.max(0, Math.floor(ageSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Traffic-light freshness dot matching legacy `_freshness_dot(age_s)`: 🟢 < 60s, 🟡 < 300s, 🔴 >= 300s. */
export function freshnessDot(ageSec: number): "🟢" | "🟡" | "🔴" {
  const s = Math.max(0, ageSec);
  if (s < 60) return "🟢";
  if (s < 300) return "🟡";
  return "🔴";
}
