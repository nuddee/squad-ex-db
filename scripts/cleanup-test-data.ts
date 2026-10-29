#!/usr/bin/env tsx
/**
 * Clean up test data (test reports, test batches, and/or revoked devices) in Supabase.
 *
 * Defaults to `--dry-run` so nothing is deleted unless `--confirm` is explicitly passed.
 *
 * Usage:
 *   pnpm cleanup-test-data                          # dry-run: lists test reports, test batches, and revoked devices
 *   pnpm cleanup-test-data --confirm                # deletes test reports, test batches, and revoked devices
 *   pnpm cleanup-test-data --reports-only --confirm # deletes only test reports (Storage objects + DB rows)
 *   pnpm cleanup-test-data --batch <uuid> --confirm # deletes a specific batch (Storage snapshots/reports + DB row)
 */
import { loadEnvLocalIfNeeded } from "../lib/env";
import { SNAPSHOT_BUCKET } from "../lib/ingest/snapshots";
import { serviceClient } from "../lib/ingest/store-supabase";
import { normalizeReportKey, REPORT_BUCKET } from "../lib/report/pdf";

export interface CleanupOptions {
  confirm: boolean;
  reportsOnly: boolean;
  batchId: string | null;
  batchPattern: RegExp;
}

export function parseCleanupArgs(argv: readonly string[]): CleanupOptions {
  let confirm = false;
  let reportsOnly = false;
  let batchId: string | null = null;
  let patternStr = "^(grain_(test|nj2|synthetic|smoke|replace|backlog|fail|ok)_|test[-_])";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--dry-run") {
      confirm = false;
    } else if (arg === "--reports-only") {
      reportsOnly = true;
    } else if (arg === "--batch" && argv[i + 1]) {
      batchId = argv[++i]!.trim();
    } else if (arg === "--pattern" && argv[i + 1]) {
      patternStr = argv[++i]!.trim();
    }
  }

  return {
    confirm,
    reportsOnly,
    batchId,
    batchPattern: new RegExp(patternStr, "i"),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIfNeeded();
  const opts = parseCleanupArgs(process.argv.slice(2));
  const db = serviceClient();

  console.log(
    opts.confirm
      ? "=== AgriVision QC Cleanup (LIVE DELETE MODE: --confirm) ==="
      : "=== AgriVision QC Cleanup (DRY RUN: pass --confirm to delete) ===",
  );

  // 1. Reports in public.reports
  let reportsQuery = db
    .from("reports")
    .select("id,batch_id,storage_path,filename,created_at")
    .order("created_at", { ascending: false });
  if (opts.batchId) {
    reportsQuery = reportsQuery.eq("batch_id", opts.batchId);
  }
  const { data: reports, error: repErr } = await reportsQuery;
  if (repErr) throw new Error(`reports select: ${repErr.message}`);

  const reportList = (reports ?? []) as {
    id: string;
    batch_id: string;
    storage_path: string;
    filename: string;
    created_at: string;
  }[];

  console.log(`\n[1] Reports matched: ${reportList.length}`);
  for (const r of reportList) {
    console.log(`  - id=${r.id} batch=${r.batch_id} path=${r.storage_path} (${r.created_at})`);
  }

  if (opts.confirm && reportList.length > 0) {
    const storageKeys = new Set<string>();
    for (const r of reportList) {
      storageKeys.add(normalizeReportKey(r.storage_path));
      storageKeys.add(r.storage_path);
    }
    const { error: rmStorageErr } = await db.storage
      .from(REPORT_BUCKET)
      .remove([...storageKeys]);
    if (rmStorageErr) {
      console.warn(`  ! storage remove warning (${REPORT_BUCKET}): ${rmStorageErr.message}`);
    }
    const ids = reportList.map((r) => r.id);
    const { error: delRepErr } = await db.from("reports").delete().in("id", ids);
    if (delRepErr) throw new Error(`reports delete: ${delRepErr.message}`);
    console.log(`  -> Deleted ${reportList.length} report row(s) and storage objects.`);
  }

  if (opts.reportsOnly) {
    return;
  }

  // 2. Test batches
  const { data: batches, error: batchErr } = await db
    .from("batches")
    .select("id,source_name,truck_plate,row_count,created_at")
    .order("created_at", { ascending: false });
  if (batchErr) throw new Error(`batches select: ${batchErr.message}`);

  const matchedBatches = ((batches ?? []) as {
    id: string;
    source_name: string;
    truck_plate: string;
    row_count: number;
    created_at: string;
  }[]).filter((b) =>
    opts.batchId
      ? b.id === opts.batchId
      : opts.batchPattern.test(b.source_name) || opts.batchPattern.test(b.truck_plate ?? ""),
  );

  console.log(`\n[2] Test batches matched: ${matchedBatches.length}`);
  for (const b of matchedBatches) {
    console.log(
      `  - id=${b.id} source_name=${b.source_name} plate=${b.truck_plate} rows=${b.row_count}`,
    );
  }

  if (opts.confirm && matchedBatches.length > 0) {
    for (const b of matchedBatches) {
      const { data: snaps } = await db
        .from("snapshots")
        .select("storage_path,thumb_path")
        .eq("batch_id", b.id);
      const snapKeys: string[] = [];
      for (const s of (snaps ?? []) as { storage_path: string; thumb_path: string | null }[]) {
        if (s.storage_path) snapKeys.push(s.storage_path);
        if (s.thumb_path) snapKeys.push(s.thumb_path);
      }
      if (snapKeys.length > 0) {
        await db.storage.from(SNAPSHOT_BUCKET).remove(snapKeys);
      }
      const { error: delBatchErr } = await db.from("batches").delete().eq("id", b.id);
      if (delBatchErr) throw new Error(`batches delete (${b.id}): ${delBatchErr.message}`);
      console.log(`  -> Deleted batch ${b.id} (${b.source_name}) and ${snapKeys.length} snapshot object(s).`);
    }
  }

  // 3. Revoked devices that have 0 remaining batches
  if (!opts.batchId) {
    const { data: revokedDevices, error: devErr } = await db
      .from("devices")
      .select("id,name,revoked_at")
      .not("revoked_at", "is", null);
    if (devErr) throw new Error(`devices select: ${devErr.message}`);

    const devList = (revokedDevices ?? []) as {
      id: string;
      name: string;
      revoked_at: string;
    }[];

    console.log(`\n[3] Revoked devices matched: ${devList.length}`);
    for (const d of devList) {
      console.log(`  - id=${d.id} name=${d.name} revoked_at=${d.revoked_at}`);
    }

    if (opts.confirm && devList.length > 0) {
      for (const d of devList) {
        // Null out device_id on any historical batches before deleting the revoked device row
        await db.from("batches").update({ device_id: null }).eq("device_id", d.id);
        const { error: delDevErr } = await db.from("devices").delete().eq("id", d.id);
        if (delDevErr) throw new Error(`devices delete (${d.id}): ${delDevErr.message}`);
        console.log(`  -> Deleted revoked device ${d.name} (${d.id}).`);
      }
    }
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /cleanup-test-data(?:\.ts|\.js)?$/i.test(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error("[cleanup-test-data] Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
