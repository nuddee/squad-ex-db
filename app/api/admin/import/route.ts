import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, type SessionCheckDeps } from "@/lib/auth/session";
import { isDevBypassAllowed } from "@/lib/env";
import { parseCsv } from "@/lib/qc/parse";
import {
  attachWeight,
  formatReport,
  ingestRows,
  mergeReports,
  MAX_ROWS_PER_REQUEST,
  sourceNameSchema,
  type IngestReport,
} from "@/lib/ingest/core";
import { extractClientIp, rateLimit } from "@/lib/ingest/rate-limit";
import { serviceClient, supabaseStore } from "@/lib/ingest/store-supabase";
import { SNAPSHOT_BUCKET, snapshotPaths, validateSnapshotFilename, type RejectReason } from "@/lib/ingest/snapshots";
import { isImageFilename, parseSnapshotMeta } from "@/lib/qc/snapshot-meta";
import type { SnapshotImportReport } from "@/lib/ingest/importer";
import type { IngestStore } from "@/lib/ingest/store";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const MAX_CSV_BYTES = 10 * 1024 * 1024;           // 10 MB CSV limit
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;      // 10 MB per snapshot image
export const MAX_SNAPSHOT_FILES = 100;                   // <= 100 snapshot files per request

const uuidSchema = z.string().uuid();

export interface AdminAuthCheckOptions {
  configuredToken?: string;
  nodeEnv?: string;
  allowInsecure?: string;
}

/**
 * Fail-closed admin authentication check:
 * - Accepts ONLY `ADMIN_IMPORT_TOKEN` (via `x-admin-token` or `Authorization: Bearer <token>`),
 *   compared with `crypto.timingSafeEqual` on equal-length UTF-8 buffers.
 * - `SUPABASE_SERVICE_ROLE_KEY` is NEVER accepted.
 * - If `ADMIN_IMPORT_TOKEN` is unset, returns `"disabled"` (HTTP 503), UNLESS
 *   `NODE_ENV === "development"` AND `ALLOW_INSECURE_ADMIN_IMPORT === "1"`.
 */
export function checkAdminHeader(
  req: Request,
  opts: AdminAuthCheckOptions = {},
): "ok" | "disabled" | "unauthorized" {
  const expected = (opts.configuredToken ?? process.env.ADMIN_IMPORT_TOKEN ?? "").trim();
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const allowInsecure = opts.allowInsecure ?? process.env.ALLOW_INSECURE_ADMIN_IMPORT;

  if (!expected) {
    if (isDevBypassAllowed({ NODE_ENV: nodeEnv }) && allowInsecure === "1") {
      return "ok";
    }
    return "disabled";
  }

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const candidate = (req.headers.get("x-admin-token") ?? bearer ?? "").trim();
  if (!candidate) return "unauthorized";

  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return "unauthorized";
  return timingSafeEqual(a, b) ? "ok" : "unauthorized";
}

export const verifyAdminImportToken = checkAdminHeader;

export interface AdminImportDeps extends AdminAuthCheckOptions, SessionCheckDeps {
  store?: () => IngestStore;
  uploadSnapshot?: (storagePath: string, bytes: Buffer, contentType: string) => Promise<void>;
}

export async function handleAdminImport(req: Request, deps: AdminImportDeps = {}): Promise<Response> {
  const rl = rateLimit(`admin.import:${extractClientIp(req)}`, {
    capacity: 30,
    refillPerSec: 0.5,
  });
  if (!rl.ok) {
    log("warn", "admin.import.rate_limited", { ip: extractClientIp(req) });
    return NextResponse.json(
      { error: "rate_limited", message: "Too many import requests. Please retry shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterS) } },
    );
  }

  const hasExplicitTokenHeader = Boolean(
    req.headers.get("x-admin-token")?.trim() ||
      /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? ""),
  );
  const hasSessionCookie = Boolean(req.headers.get("cookie")?.trim()) || Boolean(deps.resolveUser);

  if (!hasExplicitTokenHeader && hasSessionCookie) {
    const adminSession = await requireAdmin(req, deps);
    if (!adminSession.ok) {
      return adminSession.response;
    }
  } else {
    const auth = checkAdminHeader(req, deps);
    if (auth === "disabled") {
      return NextResponse.json(
        {
          error: "route_disabled",
          message: "ADMIN_IMPORT_TOKEN is not configured on the server; admin import is disabled.",
        },
        { status: 503 },
      );
    }
    if (auth === "unauthorized") {
      return NextResponse.json(
        { error: "unauthorized", message: "Invalid or missing ADMIN_IMPORT_TOKEN." },
        { status: 401 },
      );
    }
  }

  try {
    const form = await req.formData();
    const csvFile = form.get("csv");
    if (!(csvFile instanceof File)) {
      return NextResponse.json({ error: "missing_csv_file", message: "CSV file is required." }, { status: 400 });
    }
    if (csvFile.size > MAX_CSV_BYTES) {
      return NextResponse.json(
        {
          error: "csv_too_large",
          message: `CSV file exceeds the 10 MB limit (${(csvFile.size / (1024 * 1024)).toFixed(1)} MB). Use the CLI importer: pnpm import-csv <file.csv> --device <name>.`,
        },
        { status: 413 },
      );
    }

    const sourceName = csvFile.name.split(/[\\/]/).pop() ?? "upload.csv";
    const nameCheck = sourceNameSchema.safeParse(sourceName);
    if (!nameCheck.success) {
      return NextResponse.json(
        { error: "invalid_source_name", message: "source_name must be a valid file name, not a path." },
        { status: 400 },
      );
    }

    const snapFiles = form.getAll("snapshots").filter((f): f is File => f instanceof File && f.size > 0);
    if (snapFiles.length > MAX_SNAPSHOT_FILES) {
      return NextResponse.json(
        {
          error: "too_many_snapshots",
          message: `Too many snapshot files (${snapFiles.length}); at most ${MAX_SNAPSHOT_FILES} images per request are allowed. For bulk snapshot imports, use the CLI: pnpm import-csv <file.csv> --device <name>.`,
        },
        { status: 413 },
      );
    }
    for (const sf of snapFiles) {
      if (sf.size > MAX_SNAPSHOT_BYTES) {
        const fname = sf.name.split(/[\\/]/).pop() ?? sf.name;
        return NextResponse.json(
          {
            error: "snapshot_too_large",
            message: `Snapshot "${fname}" exceeds the 10 MB per-image limit (${(sf.size / (1024 * 1024)).toFixed(1)} MB).`,
          },
          { status: 413 },
        );
      }
    }

    const store = deps.store ? deps.store() : supabaseStore();

    const deviceIdRaw = (form.get("device_id") as string | null)?.trim() || null;
    if (deviceIdRaw !== null) {
      if (!uuidSchema.safeParse(deviceIdRaw).success) {
        return NextResponse.json(
          { error: "invalid_device_id", message: "device_id must be a valid UUID." },
          { status: 400 },
        );
      }
      const exists = await store.deviceExists(deviceIdRaw);
      if (!exists) {
        return NextResponse.json(
          { error: "unknown_device_id", message: `No active device found with id ${deviceIdRaw}.` },
          { status: 400 },
        );
      }
    }

    const text = await csvFile.text();
    const table = parseCsv(text);
    const header = table[0] ?? [];
    const records = table.slice(1);

    const uploadSnapshot =
      deps.uploadSnapshot ??
      (async (storagePath: string, bytes: Buffer, contentType: string) => {
        const { error } = await serviceClient().storage.from(SNAPSHOT_BUCKET).upload(storagePath, bytes, { upsert: true, contentType });
        if (error) throw new Error(error.message);
      });

    const chunks: IngestReport[] = [];
    for (let i = 0; i < records.length; i += MAX_ROWS_PER_REQUEST) {
      chunks.push(
        await ingestRows(
          store,
          { deviceId: deviceIdRaw, sourceName, columns: header, rows: records.slice(i, i + MAX_ROWS_PER_REQUEST), firstRecord: i + 1 },
          { computeWeight: false },
        ),
      );
    }
    if (chunks.length === 0) {
      chunks.push(await ingestRows(store, { deviceId: deviceIdRaw, sourceName, columns: header, rows: [] }, { computeWeight: false }));
    }
    const ingest = mergeReports(chunks, sourceName);
    await attachWeight(store, ingest);

    let snapshots: SnapshotImportReport | null = null;
    if (snapFiles.length > 0 && !ingest.batch_id) {
      ingest.warnings.push(
        `SNAPSHOTS NOT IMPORTED: ${snapFiles.length} snapshot file(s) were attached, but the CSV yielded no valid inspection rows (no batch was created).`,
      );
    } else if (snapFiles.length > 0 && ingest.batch_id) {
      const settings = await store.getSettings();
      const rep: SnapshotImportReport = { found: 0, stored: 0, rejected: 0, reject_reasons: {} };
      const bump = (r: RejectReason | "upload_failed") => {
        rep.rejected++;
        rep.reject_reasons[r] = (rep.reject_reasons[r] ?? 0) + 1;
      };
      const toUpsert = [];
      for (const sf of snapFiles) {
        const fname = sf.name.split(/[\\/]/).pop() ?? sf.name;
        if (!isImageFilename(fname)) continue;
        rep.found++;
        const why = validateSnapshotFilename(fname);
        if (why) {
          bump(why);
          continue;
        }
        const paths = snapshotPaths(ingest.batch_id, fname);
        const bytes = Buffer.from(await sf.arrayBuffer());
        const ext = fname.split(".").pop()?.toLowerCase() ?? "jpg";
        const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        try {
          await uploadSnapshot(paths.image, bytes, contentType);
        } catch {
          bump("upload_failed");
          continue;
        }
        const meta = parseSnapshotMeta(fname, settings.snapshot_filename_tz);
        toUpsert.push({ filename: fname, storage_path: paths.image, thumb_path: null, plate_number: meta.plate, captured_at: meta.ts });
        rep.stored++;
      }
      if (toUpsert.length) await store.upsertSnapshots(ingest.batch_id, toUpsert);
      snapshots = rep;
    }

    log(ingest.skipped || ingest.warnings.length ? "warn" : "info", "admin.import", {
      source: sourceName,
      batch_id: ingest.batch_id,
      received: ingest.received,
      accepted: ingest.accepted,
      skipped: ingest.skipped,
      skip_reasons: ingest.skip_reasons,
      weight_warning: ingest.weight?.weight_warning ?? null,
      snapshots_stored: snapshots?.stored ?? 0,
    });

    return NextResponse.json({
      ingest,
      snapshots,
      summary_text: formatReport(ingest),
    });
  } catch (e) {
    log("error", "admin.import.failed", { message: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { error: "internal_error", message: "Internal server error during import. Check server logs for details." },
      { status: 500 },
    );
  }
}

export function POST(req: Request) {
  return handleAdminImport(req);
}
