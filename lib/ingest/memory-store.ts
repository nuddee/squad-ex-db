import { DEFAULT_SETTINGS, type Settings } from "@/lib/qc/config";
import type { InspectionRow } from "@/lib/qc/parse";
import type { MetricsRow } from "@/lib/qc/metrics";
import type { IngestStore, SignedUpload, SnapshotRecord } from "./store";

/** In-memory IngestStore: unit tests and the importer's --dry-run. Mirrors the DB's unique keys. */
export class MemoryStore implements IngestStore {
  devices = new Set<string>(["00000000-0000-4000-8000-000000000001", "dev-1"]);
  batches = new Map<string, { id: string; deviceId: string | null; sourceName: string; truck_plate: string; qc_name: string }>();
  rows = new Map<string, Map<string, InspectionRow>>(); // batchId -> key -> row
  snapshots = new Map<string, Map<string, SnapshotRecord>>();
  settings: Settings = { ...DEFAULT_SETTINGS };
  private n = 0;

  async getOrCreateBatch(a: { deviceId: string | null; sourceName: string; mode: string }) {
    for (const b of this.batches.values()) if (b.deviceId === a.deviceId && b.sourceName === a.sourceName) return { id: b.id };
    const id = `batch-${++this.n}`;
    this.batches.set(id, { id, deviceId: a.deviceId, sourceName: a.sourceName, truck_plate: "", qc_name: "" });
    this.rows.set(id, new Map());
    this.snapshots.set(id, new Map());
    return { id };
  }
  async deviceExists(deviceId: string) {
    return this.devices.has(deviceId);
  }
  async updateBatchMeta(batchId: string, meta: { truck_plate: string; qc_name: string }) {
    Object.assign(this.batches.get(batchId)!, meta);
  }
  async upsertRows(batchId: string, rows: readonly InspectionRow[]) {
    const m = this.rows.get(batchId)!;
    for (const r of rows) m.set(`${r.snapshot_time.getTime()}|${r.plate_number}|${r.snapshot_type}`, r);
  }
  async loadMetricsRows(batchId: string): Promise<MetricsRow[]> {
    return [...this.rows.get(batchId)!.values()].sort((a, b) => a.snapshot_time.getTime() - b.snapshot_time.getTime());
  }
  async getSettings() {
    return this.settings;
  }
  async upsertSnapshots(batchId: string, items: readonly SnapshotRecord[]) {
    const m = this.snapshots.get(batchId)!;
    for (const s of items) m.set(s.filename, s);
  }
  async createSignedUpload(path: string): Promise<SignedUpload> {
    return { path, token: `tok-${path}`, signed_url: `https://storage.test/upload/${path}?token=tok` };
  }
  rowCount(batchId: string) {
    return this.rows.get(batchId)?.size ?? 0;
  }
}
