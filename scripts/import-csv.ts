/**
 * Backfill legacy CSVs (and their snapshots/ folders) into Supabase.
 *
 *   pnpm import-csv <file.csv>... [--device NAME] [--no-snapshots] [--dry-run]
 *
 * --dry-run needs no Supabase: it parses, computes the batch weight health and prints the report.
 * Without --dry-run, --device NAME is required (create it with `pnpm create-device NAME`).
 * Re-running is safe (idempotent upserts).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvLocalIfNeeded } from "../lib/env";
import { formatImportReport, importCsv, type SnapshotUploader } from "../lib/ingest/importer";
import { MemoryStore } from "../lib/ingest/memory-store";
import { serviceClient, supabaseStore } from "../lib/ingest/store-supabase";
import { SNAPSHOT_BUCKET } from "../lib/ingest/snapshots";
import { log } from "../lib/log";

loadEnvLocalIfNeeded();

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--device");

async function main() {
  if (files.length === 0) {
    console.error("usage: pnpm import-csv <file.csv>... [--device NAME] [--no-snapshots] [--dry-run]");
    process.exit(2);
  }
  const dryRun = flag("--dry-run");
  const deviceName = opt("--device");
  let store: ReturnType<typeof supabaseStore> | MemoryStore;
  let deviceId: string | null = null;
  let uploader: SnapshotUploader | undefined;

  if (dryRun) {
    store = new MemoryStore();
  } else {
    if (!deviceName) {
      console.error("--device NAME is required (or use --dry-run)");
      process.exit(2);
    }
    const db = serviceClient();
    const { data, error } = await db.from("devices").select("id,revoked_at").eq("name", deviceName).maybeSingle();
    if (error || !data) {
      console.error(`device "${deviceName}" not found. Create it: pnpm create-device ${deviceName}`);
      process.exit(2);
    }
    deviceId = data.id as string;
    store = supabaseStore(db);
    uploader = async (p, bytes, filename) => {
      const ext = path.extname(filename).slice(1).toLowerCase();
      const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const { error: e } = await db.storage.from(SNAPSHOT_BUCKET).upload(p, bytes, { upsert: true, contentType });
      if (e) {
        log("warn", "import.upload_failed", { filename, message: e.message });
        throw e;
      }
    };
  }

  let failed = 0;
  for (const f of files) {
    try {
      const snapDir = path.join(path.dirname(f), "snapshots");
      const report = await importCsv({
        store,
        csvPath: f,
        deviceId,
        dryRun,
        uploader,
        snapshotsDir: !flag("--no-snapshots") && existsSync(snapDir) ? snapDir : undefined,
      });
      console.log(formatImportReport(report));
      log(report.ingest.skipped || report.ingest.weight?.weight_warning ? "warn" : "info", "import.csv", {
        file: path.basename(f),
        received: report.ingest.received,
        accepted: report.ingest.accepted,
        skipped: report.ingest.skipped,
        skip_reasons: report.ingest.skip_reasons,
        weight_warning: report.ingest.weight?.weight_warning ?? null,
        dry_run: dryRun,
      });
    } catch (e) {
      failed++;
      console.error(`${f}: FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
