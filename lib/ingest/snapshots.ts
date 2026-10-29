import { createHash } from "node:crypto";
import { z } from "zod";
import { isImageFilename, parseSnapshotMeta } from "@/lib/qc/snapshot-meta";
import { sourceNameSchema } from "./core";
import type { IngestStore, SnapshotRecord } from "./store";

export const SNAPSHOT_BUCKET = "snapshots";
export const MAX_FILES_PER_SIGN = 200;

export const signBodySchema = z.object({
  source_name: sourceNameSchema,
  files: z.array(z.object({ filename: z.string().max(1000) })).min(1).max(MAX_FILES_PER_SIGN),
  /** Set false when the uploader cannot produce a 480 px thumbnail: thumb_path stays null and no thumb URL is issued. */
  thumbs: z.boolean().default(true),
});
export type SignBody = z.infer<typeof signBodySchema>;

export type RejectReason = "invalid_filename" | "bad_extension";

/** Reject anything that is not a plain image file name (blocks path traversal, control chars, hidden files). */
export function validateSnapshotFilename(name: string): RejectReason | null {
  if (
    name.length === 0 || name.length > 255 ||
    /[\\/\0-\x1f\x7f]/.test(name) ||
    name.startsWith(".") || name.includes("..") || name !== name.trim()
  ) return "invalid_filename";
  if (!isImageFilename(name)) return "bad_extension";
  return null;
}

/**
 * ASCII-only storage key (Supabase object keys reject many unicode chars; filenames contain Thai plates).
 * Names that needed changes get a short hash of the original so two different names never collide.
 */
export function storageKey(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  const hash = createHash("sha1").update(filename).digest("hex").slice(0, 8);
  const needsHash = safe !== filename || stem.length > 120;
  return `${needsHash ? `${stem.slice(0, 120)}-${hash}` : stem}${ext}`;
}

export function snapshotPaths(batchId: string, filename: string): { image: string; thumb: string } {
  const key = storageKey(filename);
  const stem = key.slice(0, key.lastIndexOf(".") > 0 ? key.lastIndexOf(".") : undefined);
  return { image: `${batchId}/${key}`, thumb: `${batchId}/thumbs/${stem}.jpg` };
}

export interface DisplaySnapshotPaths {
  /** Path to prefer for grid/gallery thumbnails: falls back to storage_path when thumb_path is missing. */
  thumbOrFullPath: string;
  /** Always the full-resolution storage_path. */
  fullPath: string;
}

/**
 * Resolve gallery image paths for a snapshot record.
 * When a thumbnail is missing (`thumb_path` is null/empty), the gallery falls back to `storage_path`.
 */
export function resolveSnapshotDisplayPaths(snap: { storage_path: string; thumb_path?: string | null }): DisplaySnapshotPaths {
  const thumb = snap.thumb_path?.trim();
  return {
    thumbOrFullPath: thumb ? thumb : snap.storage_path,
    fullPath: snap.storage_path,
  };
}

/**
 * Resolve signed URLs for a snapshot card: if the thumbnail signed URL is missing, falls back to the full image URL.
 */
export function resolveSnapshotDisplayUrls(urls: { fullUrl: string; thumbUrl?: string | null }): { thumbUrl: string; fullUrl: string } {
  const thumb = urls.thumbUrl?.trim();
  return {
    thumbUrl: thumb ? thumb : urls.fullUrl,
    fullUrl: urls.fullUrl,
  };
}

export interface SignReport {
  batch_id: string | null;
  source_name: string;
  received: number;
  signed: {
    filename: string;
    image: { path: string; token: string; signed_url: string };
    thumb: { path: string; token: string; signed_url: string } | null;
  }[];
  rejected: { filename: string; reason: RejectReason }[];
  /** Same counters as the rows endpoint so edge-sync logs one shape. */
  skipped: number;
  skip_reasons: Partial<Record<RejectReason, number>>;
}

export async function signSnapshots(
  store: IngestStore,
  p: { deviceId: string | null; sourceName: string; filenames: readonly string[]; thumbs?: boolean },
): Promise<SignReport> {
  const withThumbs = p.thumbs ?? true;
  const rejected: SignReport["rejected"] = [];
  const skip_reasons: SignReport["skip_reasons"] = {};
  const ok: string[] = [];
  for (const f of new Set(p.filenames)) {
    const why = validateSnapshotFilename(f);
    if (why) {
      rejected.push({ filename: f.slice(0, 100), reason: why });
      skip_reasons[why] = (skip_reasons[why] ?? 0) + 1;
    } else ok.push(f);
  }
  const report: SignReport = {
    batch_id: null, source_name: p.sourceName, received: p.filenames.length,
    signed: [], rejected, skipped: rejected.length, skip_reasons,
  };
  if (ok.length === 0) return report;

  const [batch, settings] = await Promise.all([
    store.getOrCreateBatch({ deviceId: p.deviceId, sourceName: p.sourceName, mode: "grain" }),
    store.getSettings(),
  ]);
  report.batch_id = batch.id;

  const records: SnapshotRecord[] = [];
  for (const filename of ok) {
    const paths = snapshotPaths(batch.id, filename);
    const meta = parseSnapshotMeta(filename, settings.snapshot_filename_tz);
    records.push({
      filename, storage_path: paths.image, thumb_path: withThumbs ? paths.thumb : null,
      plate_number: meta.plate, captured_at: meta.ts,
    });
    const [image, thumb] = await Promise.all([
      store.createSignedUpload(paths.image),
      withThumbs ? store.createSignedUpload(paths.thumb) : Promise.resolve(null),
    ]);
    report.signed.push({ filename, image, thumb });
  }
  await store.upsertSnapshots(batch.id, records);
  return report;
}
