import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertProductionEnv,
  getPublicSupabaseUrl,
  getServiceRoleKey,
  getSupabasePublishableKey,
  getSupabaseUrl,
  isPlaceholder,
} from "@/lib/env";
import { applyAppSettingsRows, DEFAULT_SETTINGS, type Settings } from "@/lib/qc/config";
import type { InspectionRow } from "@/lib/qc/parse";
import type { MetricsRow } from "@/lib/qc/metrics";
import { SNAPSHOT_BUCKET } from "./snapshots";
import type { IngestStore, SignedUpload, SnapshotRecord } from "./store";

let cached: SupabaseClient | null = null;

/** Service-role client. Server-only: the key must never reach the browser. Created lazily so builds don't need env. */
export function serviceClient(): SupabaseClient {
  if (cached) return cached;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    assertProductionEnv(process.env);
  }
  const url = getSupabaseUrl();
  const key = getServiceRoleKey();
  if (!url || !key || isPlaceholder(url) || isPlaceholder(key)) {
    throw new Error(
      "Missing or placeholder Supabase environment variables (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Copy .env.example to .env.local, fill in your keys, and run `pnpm check-env`.",
    );
  }
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

/** Public/anon client helper (checks NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY first, then NEXT_PUBLIC_SUPABASE_ANON_KEY). */
export function publicSupabaseConfig(): { url: string; publishableKey: string } {
  const url = getPublicSupabaseUrl();
  const publishableKey = getSupabasePublishableKey();
  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) must be set",
    );
  }
  return { url, publishableKey };
}

const UPSERT_CHUNK = 500;
const PAGE = 1000;

export function supabaseStore(db: SupabaseClient = serviceClient()): IngestStore {
  return {
    async getOrCreateBatch({ deviceId, sourceName, mode }) {
      const find = async () => {
        let q = db.from("batches").select("id").eq("source_name", sourceName);
        q = deviceId ? q.eq("device_id", deviceId) : q.is("device_id", null);
        const { data, error } = await q.maybeSingle();
        if (error) throw new Error(`batches select: ${error.message}`);
        return data as { id: string } | null;
      };
      const existing = await find();
      if (existing) return existing;
      const { data, error } = await db
        .from("batches")
        .insert({ mode, device_id: deviceId, source_name: sourceName })
        .select("id")
        .single();
      if (error) {
        if (error.code === "23505") { // concurrent insert of the same (device, source)
          const again = await find();
          if (again) return again;
        }
        throw new Error(`batches insert: ${error.message}`);
      }
      return data as { id: string };
    },

    async deviceExists(deviceId: string): Promise<boolean> {
      const { data, error } = await db
        .from("devices")
        .select("id")
        .eq("id", deviceId)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw new Error(`devices select: ${error.message}`);
      return !!data;
    },

    async updateBatchMeta(batchId, meta) {
      const { error } = await db.from("batches").update(meta).eq("id", batchId);
      if (error) throw new Error(`batches update: ${error.message}`);
    },

    async upsertRows(batchId, rows: readonly InspectionRow[]) {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK).map((r) => ({
          batch_id: batchId,
          snapshot_time: r.snapshot_time.toISOString(),
          plate_number: r.plate_number,
          snapshot_type: r.snapshot_type,
          snapshot_total: r.snapshot_total,
          estimated_grain_count: r.estimated_grain_count,
          mix: r.mix,
          mix_raw: r.mix_raw,
        }));
        const { error } = await db
          .from("inspection_rows")
          .upsert(chunk, { onConflict: "batch_id,snapshot_time,plate_number,snapshot_type" });
        if (error) throw new Error(`inspection_rows upsert: ${error.message}`);
      }
    },

    async loadMetricsRows(batchId) {
      const out: MetricsRow[] = [];
      for (let from = 0; ; ) {
        const { data, error } = await db
          .from("inspection_rows")
          .select("plate_number,snapshot_type,snapshot_total,estimated_grain_count,mix")
          .eq("batch_id", batchId)
          .order("snapshot_time", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`inspection_rows select: ${error.message}`);
        if (!data || data.length === 0) break;
        out.push(...(data as MetricsRow[]));
        from += data.length;
      }
      return out;
    },

    async getSettings(): Promise<Settings> {
      const { data, error } = await db.from("app_settings").select("key,value");
      if (error) throw new Error(`app_settings select: ${error.message}`);
      return applyAppSettingsRows(
        (data ?? []) as { key: string; value: number | string }[],
        DEFAULT_SETTINGS,
      );
    },

    async upsertSnapshots(batchId, items: readonly SnapshotRecord[]) {
      const rows = items.map((s) => ({
        batch_id: batchId,
        filename: s.filename,
        storage_path: s.storage_path,
        thumb_path: s.thumb_path,
        plate_number: s.plate_number,
        captured_at: s.captured_at ? s.captured_at.toISOString() : null,
      }));
      const { error } = await db.from("snapshots").upsert(rows, { onConflict: "batch_id,filename" });
      if (error) throw new Error(`snapshots upsert: ${error.message}`);
    },

    async createSignedUpload(path): Promise<SignedUpload> {
      const { data, error } = await db.storage.from(SNAPSHOT_BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new Error(`signed upload url: ${error?.message ?? "no data"}`);
      return { path: data.path, token: data.token, signed_url: data.signedUrl };
    },
  };
}
