import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleIngestRows, handleSignSnapshots, type HandlerDeps } from "@/lib/ingest/handlers";
import { MemoryStore } from "@/lib/ingest/memory-store";
import { supabaseStore } from "@/lib/ingest/store-supabase";
import { _resetRateLimits } from "@/lib/ingest/rate-limit";
import { formatImportReport, importCsv } from "@/lib/ingest/importer";
import { storageKey, snapshotPaths, validateSnapshotFilename, resolveSnapshotDisplayPaths, resolveSnapshotDisplayUrls } from "@/lib/ingest/snapshots";
import { sha256Hex, generateDeviceKey } from "@/lib/ingest/auth";
import { parseCsv } from "@/lib/qc/parse";
import {
  checkAdminHeader,
  handleAdminImport,
  MAX_CSV_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
} from "@/app/api/admin/import/route";
import { parseAdminImportResponse } from "@/lib/ingest/import-client";

const fixture = (n: string) => path.join(__dirname, "..", "parity", "fixtures", n);

function makeDeps(store: MemoryStore): HandlerDeps {
  return {
    authenticate: async (req) => {
      const t = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
      return t === "good-key" ? { id: "dev-1", name: "jetson-1" } : null;
    },
    store: () => store,
  };
}
const post = (body: unknown, key: string | null = "good-key") =>
  new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const COLS = ["snapshot_time", "plate_number", "snapshot_type", "snapshot_mix_summary", "snapshot_total", "estimated_grain_count"];
const okRow = (sec: number, plate = 1) => [
  `2026-10-28 10:00:${String(sec).padStart(2, "0")}`, String(plate), "last_frame", "good=90, immature=10", "100", "800",
];

beforeEach(() => _resetRateLimits());

describe("POST /api/ingest/rows", () => {
  it("rejects missing / unknown key with 401", async () => {
    const store = new MemoryStore();
    expect((await handleIngestRows(post({}, null), makeDeps(store))).status).toBe(401);
    expect((await handleIngestRows(post({}, "nope"), makeDeps(store))).status).toBe(401);
  });

  it("validates the body (400) and bad JSON", async () => {
    const deps = makeDeps(new MemoryStore());
    const r = await handleIngestRows(post({ source_name: "../evil.csv", columns: COLS, rows: [okRow(1)] }), deps);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
    expect((await handleIngestRows(post("{nope"), deps)).status).toBe(400);
    const tooMany = await handleIngestRows(post({ source_name: "a.csv", columns: COLS, rows: Array(501).fill(okRow(1)) }), deps);
    expect(tooMany.status).toBe(400);
  });

  it("reports skipped / skip_reasons / skipped_samples with correct record numbers", async () => {
    const store = new MemoryStore();
    const res = await handleIngestRows(
      post({
        source_name: "grain_x_rolling10s.csv",
        columns: COLS,
        first_record: 101,
        rows: [okRow(1), ["bad-time", "1", "last_frame", "good=1", "1", "1"], okRow(2), [...okRow(3), "EXTRA"]],
      }),
      makeDeps(store),
    );
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toMatchObject({ received: 4, accepted: 2, skipped: 2, skip_reasons: { bad_timestamp: 1, too_many_fields: 1 } });
    expect(b.skipped_samples).toEqual([
      { record: 102, reason: "bad_timestamp" },
      { record: 104, reason: "too_many_fields" },
    ]);
    expect(store.rowCount(b.batch_id)).toBe(2);
  });

  it("is idempotent: resending the same rows never duplicates", async () => {
    const store = new MemoryStore();
    const body = { source_name: "a.csv", columns: COLS, rows: [okRow(1), okRow(2)] };
    const a = await (await handleIngestRows(post(body), makeDeps(store))).json();
    const b = await (await handleIngestRows(post(body), makeDeps(store))).json();
    expect(b.batch_id).toBe(a.batch_id);
    expect(store.rowCount(a.batch_id)).toBe(2);
    expect(store.batches.size).toBe(1);
  });

  it("collapses in-request duplicates (last wins) and reports them", async () => {
    const store = new MemoryStore();
    const dup = okRow(1);
    const b = await (
      await handleIngestRows(post({ source_name: "a.csv", columns: COLS, rows: [dup, dup, okRow(2)] }), makeDeps(store))
    ).json();
    expect(b.accepted).toBe(2);
    expect(b.duplicates_in_request).toBe(1);
  });

  it("all rows skipped: no batch is created, report still returned", async () => {
    const store = new MemoryStore();
    const b = await (
      await handleIngestRows(post({ source_name: "a.csv", columns: ["x"], rows: [["1"], ["2"]] }), makeDeps(store))
    ).json();
    expect(b).toMatchObject({ batch_id: null, accepted: 0, skipped: 2, skip_reasons: { missing_time_column: 2 } });
    expect(store.batches.size).toBe(0);
  });

  it("keeps weight_warning disabled by default on real nj2 data while keeping weight_alert_active true", async () => {
    const t = parseCsv(readFileSync(fixture("real_multiplate.csv"), "utf8"));
    const store = new MemoryStore();
    const b = await (
      await handleIngestRows(
        post({ source_name: "grain_nj2_20260914_084808_rolling10s.csv", columns: t[0], rows: t.slice(1) }),
        makeDeps(store),
      )
    ).json();
    expect(b.skipped).toBe(0);
    expect(b.weight).toMatchObject({
      weight_warning: false,
      weight_alert_active: true,
      estimated_seeds: 22292,
      max_plausible_seeds: 1612,
    });
    expect(b.warnings).toEqual([]);
  });

  it("no weight warning on a plausible batch", async () => {
    const b = await (
      await handleIngestRows(post({ source_name: "a.csv", columns: COLS, rows: [okRow(1)] }), makeDeps(new MemoryStore()))
    ).json();
    expect(b.weight.weight_warning).toBe(false);
    expect(b.warnings).toEqual([]);
  });

  it("rate limits per device (429 + Retry-After)", async () => {
    const deps = makeDeps(new MemoryStore());
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await handleIngestRows(post({ source_name: "a.csv", columns: COLS, rows: [okRow(1)] }), deps);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("POST /api/ingest/snapshots/sign", () => {
  const files = (...n: string[]) => n.map((filename) => ({ filename }));

  it("signs valid names, rejects traversal / bad extensions with reasons", async () => {
    const store = new MemoryStore();
    const res = await handleSignSnapshots(
      post({
        source_name: "a.csv",
        files: files("20261028_100001_T1_plate2.jpg", "../../etc/passwd.jpg", "a/b.jpg", "..\\x.png", "notes.txt", ".hidden.jpg", "x\u0000.jpg"),
      }),
      makeDeps(store),
    );
    const b = await res.json();
    expect(b.signed).toHaveLength(1);
    expect(b.skipped).toBe(6);
    expect(b.skip_reasons).toEqual({ invalid_filename: 5, bad_extension: 1 });
    const snap = [...store.snapshots.get(b.batch_id)!.values()][0]!;
    expect(snap.plate_number).toBe(2);
    expect(snap.captured_at?.toISOString()).toBe("2026-10-28T10:00:01.000Z");
    expect(b.signed[0].image.path.startsWith(`${b.batch_id}/`)).toBe(true);
    expect(b.signed[0].thumb.path).toContain("/thumbs/");
  });

  it("unauthorized -> 401", async () => {
    expect((await handleSignSnapshots(post({ source_name: "a.csv", files: files("a.jpg") }, null), makeDeps(new MemoryStore()))).status).toBe(401);
  });
});

describe("storage keys", () => {
  it("ASCII-only, collision-safe for Thai names, stable", () => {
    const a = storageKey("20261028_100001_1กข234_plate1.jpg");
    const b = storageKey("20261028_100001_2กข234_plate1.jpg");
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(a).not.toBe(b);
    expect(storageKey("20261028_100001_1กข234_plate1.jpg")).toBe(a);
    expect(storageKey("plain_name.jpg")).toBe("plain_name.jpg");
    expect(snapshotPaths("B", "x.png")).toEqual({ image: "B/x.png", thumb: "B/thumbs/x.jpg" });
  });
  it("filename validation", () => {
    expect(validateSnapshotFilename("ok.JPG")).toBeNull();
    expect(validateSnapshotFilename("a..b.jpg")).toBe("invalid_filename");
    expect(validateSnapshotFilename("a.gif")).toBe("bad_extension");
  });
});

describe("device keys", () => {
  it("generates unpredictable keys; hash is 64 hex", () => {
    const k = generateDeviceKey();
    expect(k).toMatch(/^agv_[A-Za-z0-9_-]{43}$/);
    expect(k).not.toBe(generateDeviceKey());
    expect(sha256Hex(k)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("CSV importer", () => {
  it("dry-run on real nj2 CSV succeeds with weight_warning disabled by default", async () => {
    const r = await importCsv({ store: new MemoryStore(), csvPath: fixture("real_multiplate.csv"), deviceId: null, dryRun: true });
    expect(r.ingest).toMatchObject({ received: 25, accepted: 25, skipped: 0 });
    expect(r.ingest.weight?.weight_warning).toBe(false);
    const text = formatImportReport(r);
    expect(text).toMatch(/dry run/);
  });

  it("chunks >500 rows, keeps record numbers, merges skip reasons, idempotent re-run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agv-"));
    try {
      const lines = [COLS.join(",")];
      for (let i = 0; i < 1200; i++) {
        const t = new Date(Date.UTC(2026, 9, 28, 3, 0, 0) + i * 1000).toISOString().slice(11, 19);
        lines.push(`2026-10-28 ${t.replace(/^03/, "10")},1,last_frame,"good=90, immature=10",100,800`);
      }
      lines[601] = "garbage,1,last_frame,good=1,1,1"; // record 601 (chunk 2)
      lines[1100] = "2026-10-28 11:00:00,1,last_frame,good=1,1,1,EXTRA"; // record 1100 (chunk 3)
      const csv = path.join(dir, "grain_t_rolling10s.csv");
      writeFileSync(csv, lines.join("\n"));
      const store = new MemoryStore();
      const r = await importCsv({ store, csvPath: csv, deviceId: "dev-1" });
      expect(r.ingest).toMatchObject({ received: 1200, skipped: 2, skip_reasons: { bad_timestamp: 1, too_many_fields: 1 } });
      expect(r.ingest.skipped_samples).toEqual([
        { record: 601, reason: "bad_timestamp" },
        { record: 1100, reason: "too_many_fields" },
      ]);
      expect(store.rowCount(r.ingest.batch_id!)).toBe(1198);
      const again = await importCsv({ store, csvPath: csv, deviceId: "dev-1" });
      expect(again.ingest.batch_id).toBe(r.ingest.batch_id);
      expect(store.rowCount(r.ingest.batch_id!)).toBe(1198);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a snapshots folder with rejection reasons", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agv-"));
    try {
      const csv = path.join(dir, "grain_t_rolling10s.csv");
      writeFileSync(csv, [COLS.join(","), `2026-10-28 10:00:01,1,last_frame,"good=90, immature=10",100,800`].join("\n"));
      const snaps = path.join(dir, "snapshots");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(snaps);
      writeFileSync(path.join(snaps, "20261028_100001_T_plate1.jpg"), "x");
      writeFileSync(path.join(snaps, "20261028_100002_T_plate1.jpg"), "x");
      writeFileSync(path.join(snaps, "Thumbs.db"), "x"); // ignored, not an image
      const uploaded: string[] = [];
      const store = new MemoryStore();
      const r = await importCsv({
        store, csvPath: csv, deviceId: null, snapshotsDir: snaps,
        uploader: async (p, _b, f) => {
          if (f.includes("100002")) throw new Error("boom");
          uploaded.push(p);
        },
      });
      expect(r.snapshots).toEqual({ found: 2, stored: 1, rejected: 1, reject_reasons: { upload_failed: 1 } });
      expect(uploaded).toHaveLength(1);
      expect(store.snapshots.get(r.ingest.batch_id!)!.size).toBe(1);
      expect(formatImportReport(r)).toMatch(/rejected 1 \(upload_failed=1\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshot gallery thumbnail fallback", () => {
  it("falls back to storage_path / fullUrl when thumb_path or thumbUrl is missing", () => {
    expect(resolveSnapshotDisplayPaths({ storage_path: "b/full.jpg", thumb_path: null })).toEqual({
      thumbOrFullPath: "b/full.jpg",
      fullPath: "b/full.jpg",
    });
    expect(resolveSnapshotDisplayPaths({ storage_path: "b/full.jpg", thumb_path: "b/thumbs/full.jpg" })).toEqual({
      thumbOrFullPath: "b/thumbs/full.jpg",
      fullPath: "b/full.jpg",
    });
    expect(resolveSnapshotDisplayUrls({ fullUrl: "https://s/full", thumbUrl: null })).toEqual({
      thumbUrl: "https://s/full",
      fullUrl: "https://s/full",
    });
    expect(resolveSnapshotDisplayUrls({ fullUrl: "https://s/full", thumbUrl: "https://s/thumb" })).toEqual({
      thumbUrl: "https://s/thumb",
      fullUrl: "https://s/full",
    });
  });
});

describe("POST /api/admin/import & client response handling", () => {
  const prevSvc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAdm = process.env.ADMIN_IMPORT_TOKEN;
  const prevAllow = process.env.ALLOW_INSECURE_ADMIN_IMPORT;

  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-never-accept-here";
    process.env.ADMIN_IMPORT_TOKEN = "admin-import-secret-123";
    delete process.env.ALLOW_INSECURE_ADMIN_IMPORT;
  });

  const makeCsvFile = (content = `${COLS.join(",")}\n2026-10-28 10:00:01,1,last_frame,"good=90, immature=10",100,800\n`, name = "grain_ok_rolling10s.csv") =>
    new File([content], name, { type: "text/csv" });

  it("1. fails closed (503) when ADMIN_IMPORT_TOKEN is unset, allowing bypass ONLY when NODE_ENV=development AND ALLOW_INSECURE_ADMIN_IMPORT=1", async () => {
    const req = new Request("http://x/api/admin/import", {
      method: "POST",
      headers: { "x-admin-token": "service-role-secret-never-accept-here" },
    });
    expect(checkAdminHeader(req, { configuredToken: "", nodeEnv: "production", allowInsecure: "1" })).toBe("disabled");
    expect(checkAdminHeader(req, { configuredToken: "", nodeEnv: "development", allowInsecure: "0" })).toBe("disabled");
    expect(checkAdminHeader(req, { configuredToken: "", nodeEnv: "development", allowInsecure: "" })).toBe("disabled");
    expect(checkAdminHeader(req, { configuredToken: "", nodeEnv: "development", allowInsecure: "1" })).toBe("ok");

    const res503 = await handleAdminImport(new Request("http://x/api/admin/import", { method: "POST" }), {
      configuredToken: "",
      nodeEnv: "production",
      allowInsecure: "1",
    });
    expect(res503.status).toBe(503);
    expect((await res503.json()).error).toBe("route_disabled");
  });

  it("2. unauthorized without a token, rejects SUPABASE_SERVICE_ROLE_KEY and wrong tokens (401), accepts ADMIN_IMPORT_TOKEN via header or Bearer", async () => {
    // Missing token
    const noTokenRes = await handleAdminImport(new Request("http://x/api/admin/import", { method: "POST" }), {
      configuredToken: "admin-import-secret-123",
    });
    expect(noTokenRes.status).toBe(401);

    const reqWithHeader = (tok: string) =>
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": tok } });
    // Rejects SUPABASE_SERVICE_ROLE_KEY
    expect((await handleAdminImport(reqWithHeader("service-role-secret-never-accept-here"), { configuredToken: "admin-import-secret-123" })).status).toBe(401);
    // Rejects wrong length and wrong same-length token
    expect((await handleAdminImport(reqWithHeader("short"), { configuredToken: "admin-import-secret-123" })).status).toBe(401);
    expect((await handleAdminImport(reqWithHeader("admin-import-secret-999"), { configuredToken: "admin-import-secret-123" })).status).toBe(401);

    // Accepts via x-admin-token
    const store = new MemoryStore();
    const fd1 = new FormData();
    fd1.append("csv", makeCsvFile());
    const okHeader = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fd1 }),
      { configuredToken: "admin-import-secret-123", store: () => store },
    );
    expect(okHeader.status).toBe(200);

    // Accepts via Authorization: Bearer
    const fd2 = new FormData();
    fd2.append("csv", makeCsvFile());
    const okBearer = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { authorization: "Bearer admin-import-secret-123" }, body: fd2 }),
      { configuredToken: "admin-import-secret-123", store: () => store },
    );
    expect(okBearer.status).toBe(200);
  });

  it("3. idempotency: importing the same CSV twice (with device_id = null) yields one batch and no duplicate rows", async () => {
    const store = new MemoryStore();
    const csvContent = [
      COLS.join(","),
      `2026-10-28 10:00:01,1,last_frame,"good=90, immature=10",100,800`,
      `2026-10-28 10:00:02,2,last_frame,"good=85, immature=15",100,800`,
    ].join("\n");

    const runImport = async () => {
      const fd = new FormData();
      fd.append("csv", makeCsvFile(csvContent, "grain_idem_rolling10s.csv"));
      const req = new Request("http://x/api/admin/import", {
        method: "POST",
        headers: { "x-admin-token": "admin-import-secret-123" },
        body: fd,
      });
      const res = await handleAdminImport(req, { configuredToken: "admin-import-secret-123", store: () => store });
      expect(res.status).toBe(200);
      return res.json();
    };

    const first = await runImport();
    const second = await runImport();
    expect(second.ingest.batch_id).toBe(first.ingest.batch_id);
    expect(store.batches.size).toBe(1);
    expect(store.rowCount(first.ingest.batch_id)).toBe(2);
  });

  it("4. validates device_id as a UUID and checks that the device exists in store; rejects with 400 otherwise", async () => {
    const store = new MemoryStore();
    const postWithDevice = async (deviceId: string) => {
      const fd = new FormData();
      fd.append("csv", makeCsvFile());
      fd.append("device_id", deviceId);
      return handleAdminImport(
        new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fd }),
        { configuredToken: "admin-import-secret-123", store: () => store },
      );
    };

    // Invalid UUID format -> 400
    const badUuid = await postWithDevice("not-a-uuid");
    expect(badUuid.status).toBe(400);
    expect((await badUuid.json()).error).toBe("invalid_device_id");

    // Valid UUID that does not exist -> 400
    const unknownUuid = await postWithDevice("00000000-0000-4000-8000-000000000999");
    expect(unknownUuid.status).toBe(400);
    expect((await unknownUuid.json()).error).toBe("unknown_device_id");

    // Existing UUID -> 200
    const validUuid = await postWithDevice("00000000-0000-4000-8000-000000000001");
    expect(validUuid.status).toBe(200);
  });

  it("5. enforces payload limits: CSV <= 10 MB, <= 100 snapshot files, each snapshot <= 10 MB (413)", async () => {
    const store = new MemoryStore();

    // Oversize CSV (> 10 MB)
    const bigCsv = new File([new Uint8Array(MAX_CSV_BYTES + 1)], "grain_big_rolling10s.csv", { type: "text/csv" });
    const fdCsv = new FormData();
    fdCsv.append("csv", bigCsv);
    const resBigCsv = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fdCsv }),
      { configuredToken: "admin-import-secret-123", store: () => store },
    );
    expect(resBigCsv.status).toBe(413);
    expect((await resBigCsv.json()).error).toBe("csv_too_large");

    // > 100 snapshot files
    const fdMany = new FormData();
    fdMany.append("csv", makeCsvFile());
    for (let i = 0; i < MAX_SNAPSHOT_FILES + 1; i++) {
      fdMany.append("snapshots", new File(["x"], `20261028_100001_T_plate${i}.jpg`, { type: "image/jpeg" }));
    }
    const resMany = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fdMany }),
      { configuredToken: "admin-import-secret-123", store: () => store },
    );
    expect(resMany.status).toBe(413);
    expect((await resMany.json()).error).toBe("too_many_snapshots");

    // Single snapshot > 10 MB
    const fdBigSnap = new FormData();
    fdBigSnap.append("csv", makeCsvFile());
    fdBigSnap.append("snapshots", new File([new Uint8Array(MAX_SNAPSHOT_BYTES + 1)], "20261028_100001_T_plate1.jpg", { type: "image/jpeg" }));
    const resBigSnap = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fdBigSnap }),
      { configuredToken: "admin-import-secret-123", store: () => store },
    );
    expect(resBigSnap.status).toBe(413);
    expect((await resBigSnap.json()).error).toBe("snapshot_too_large");
  });

  it("6. returns a generic message on 500 without leaking internal error details", async () => {
    const fd = new FormData();
    fd.append("csv", makeCsvFile());
    const res500 = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fd }),
      {
        configuredToken: "admin-import-secret-123",
        store: () => {
          throw new Error("SECRET_DB_CONNECTION_STRING_LEAK");
        },
      },
    );
    expect(res500.status).toBe(500);
    const body = await res500.json();
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Internal server error during import. Check server logs for details.");
    expect(JSON.stringify(body)).not.toContain("SECRET_DB_CONNECTION_STRING_LEAK");
  });

  it("7. warns when snapshots are attached but the CSV yields no batch (instead of silently dropping them)", async () => {
    const store = new MemoryStore();
    const fd = new FormData();
    fd.append("csv", makeCsvFile(`${COLS.join(",")}\nbad-ts,1,last_frame,good=1,1,1\n`, "grain_empty_rolling10s.csv"));
    fd.append("snapshots", new File(["img"], "20261028_100001_T_plate1.jpg", { type: "image/jpeg" }));

    const res = await handleAdminImport(
      new Request("http://x/api/admin/import", { method: "POST", headers: { "x-admin-token": "admin-import-secret-123" }, body: fd }),
      { configuredToken: "admin-import-secret-123", store: () => store },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingest.batch_id).toBeNull();
    expect(body.snapshots).toBeNull();
    expect(body.ingest.warnings.some((w: string) => w.includes("SNAPSHOTS NOT IMPORTED"))).toBe(true);
    expect(body.summary_text).toContain("SNAPSHOTS NOT IMPORTED");
  });

  it("client parser formats non-JSON / 413 / !res.ok cleanly", async () => {
    const ui413 = await parseAdminImportResponse({
      ok: false,
      status: 413,
      text: async () => "<html><body>413 Request Entity Too Large</body></html>",
    });
    expect(ui413.error).toBe("payload_too_large");
    expect(ui413.message).toMatch(/pnpm import-csv/);

    const ui502 = await parseAdminImportResponse({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    });
    expect(ui502.error).toBe("http_502");
    expect(ui502.message).toMatch(/non-JSON response \(HTTP 502\)/);

    const ui401 = await parseAdminImportResponse({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "unauthorized", message: "Invalid or missing ADMIN_IMPORT_TOKEN." }),
    });
    expect(ui401.error).toBe("unauthorized");
    expect(ui401.message).toMatch(/ADMIN_IMPORT_TOKEN/);

    process.env.SUPABASE_SERVICE_ROLE_KEY = prevSvc;
    process.env.ADMIN_IMPORT_TOKEN = prevAdm;
    process.env.ALLOW_INSECURE_ADMIN_IMPORT = prevAllow;
  });
});

describe("supabaseStore.loadMetricsRows pagination under smaller PostgREST max_rows", () => {
  it("continues fetching when a page returns fewer than PAGE (1000) rows and stops only on an empty page", async () => {
    const totalRows = 620;
    const postgrestMaxRows = 250; // smaller than PAGE = 1000
    const allRows = Array.from({ length: totalRows }, (_, i) => ({
      plate_number: (i % 5) + 1,
      snapshot_type: "last_frame",
      snapshot_total: 100,
      estimated_grain_count: 800,
      mix: { good: 90, immature: 10 },
    }));

    const rangesRequested: [number, number][] = [];
    const fakeDb = {
      from(table: string) {
        expect(table).toBe("inspection_rows");
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          range: async (from: number, to: number) => {
            rangesRequested.push([from, to]);
            const slice = allRows.slice(from, Math.min(to + 1, from + postgrestMaxRows));
            return { data: slice, error: null };
          },
        };
        return chain;
      },
    };

    const store = supabaseStore(fakeDb as any);
    const loaded = await store.loadMetricsRows("batch-123");
    expect(loaded).toHaveLength(totalRows);
    expect(rangesRequested).toEqual([
      [0, 999],    // returns 250 rows (0..249)
      [250, 1249], // returns 250 rows (250..499)
      [500, 1499], // returns 120 rows (500..619)
      [620, 1619], // returns 0 rows -> loop terminates
    ]);
  });
});
