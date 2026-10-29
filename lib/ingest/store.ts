import type { InspectionRow } from "@/lib/qc/parse";
import type { MetricsRow } from "@/lib/qc/metrics";
import type { Settings } from "@/lib/qc/config";

export interface SnapshotRecord {
  filename: string;
  storage_path: string;
  thumb_path: string | null;
  plate_number: number | null;
  captured_at: Date | null;
}

export interface SignedUpload {
  path: string;
  token: string;
  signed_url: string;
}

/** Persistence surface used by the ingest core. Implemented by Supabase (prod) and in-memory (tests). */
export interface IngestStore {
  getOrCreateBatch(a: { deviceId: string | null; sourceName: string; mode: string }): Promise<{ id: string }>;
  deviceExists(deviceId: string): Promise<boolean>;
  updateBatchMeta(batchId: string, meta: { truck_plate: string; qc_name: string }): Promise<void>;
  /** Idempotent: unique (batch_id, snapshot_time, plate_number, snapshot_type); later writes win. */
  upsertRows(batchId: string, rows: readonly InspectionRow[]): Promise<void>;
  /** All rows of the batch, time-ascending (for metrics). */
  loadMetricsRows(batchId: string): Promise<MetricsRow[]>;
  getSettings(): Promise<Settings>;
  /** Idempotent: unique (batch_id, filename). */
  upsertSnapshots(batchId: string, items: readonly SnapshotRecord[]): Promise<void>;
  createSignedUpload(path: string): Promise<SignedUpload>;
}
