import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildBatchDetailPayload,
  type RawBatchRecord,
  type RawInspectionRowRecord,
  type RawSnapshotRecord,
} from "@/lib/dashboard/queries";
import {
  DEFAULT_REPORT_FOOTER_LEFT,
  DEFAULT_REPORT_FORM_CODE,
  DEFAULT_SETTINGS,
  applyAppSettingsRows,
} from "@/lib/qc/config";
import { round1 } from "@/lib/qc/metrics";
import { parseInspectionCsv } from "@/lib/qc/parse";
import {
  REPORT_BUCKET,
  buildReportModel,
  createReportSignedUrl,
  generateAndStoreBatchReport,
  loadBundledThaiFonts,
  normalizeReportKey,
  renderQcReportPdf,
} from "@/lib/report/pdf";

const GOLDEN_BATCH: RawBatchRecord = {
  id: "22222222-3333-4444-5555-666666666666",
  mode: "grain",
  device_id: "00000000-0000-4000-8000-000000000001",
  source_name: "grain_1กข2345_20261028_100000_rolling10s.csv",
  truck_plate: "1กข-2345 กรุงเทพมหานคร",
  qc_name: "สมชาย ใจดี (Somchai)",
  started_at: "2026-10-28T03:00:00.000Z",
  last_data_at: "2026-10-28T03:01:00.000Z",
  row_count: 2,
  created_at: "2026-10-28T03:00:00.000Z",
};

const GOLDEN_ROWS: RawInspectionRowRecord[] = [
  {
    id: 1,
    snapshot_time: "2026-10-28T03:00:10.000Z",
    plate_number: 1,
    snapshot_type: "last_frame",
    snapshot_total: 100,
    estimated_grain_count: 800,
    mix: { good: 90, immature: 6, sm: 2, dc: 2 },
    mix_raw: "good=90, immature=6, sm=2, dc=2",
  },
  {
    id: 2,
    snapshot_time: "2026-10-28T03:01:00.000Z",
    plate_number: 2,
    snapshot_type: "last_frame",
    snapshot_total: 100,
    estimated_grain_count: 800,
    mix: { good: 80, immature: 10, sm: 5, dc: 5 },
    mix_raw: "good=80, immature=10, sm=5, dc=5",
  },
];

function countPdfPages(pdfBuffer: Buffer): number {
  const raw = pdfBuffer.toString("latin1");
  const matches = raw.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

describe("normalizeReportKey", () => {
  it("strips a single legacy 'reports/' prefix and leaves new keys untouched", () => {
    const id = "6fa6c9cb-706e-4671-8425-090da07cfe1d";
    expect(normalizeReportKey(`reports/${id}/20261029T040151Z.pdf`)).toBe(`${id}/20261029T040151Z.pdf`);
    expect(normalizeReportKey(`${id}/20261029T040151Z.pdf`)).toBe(`${id}/20261029T040151Z.pdf`);
    expect(normalizeReportKey("reports/reports/x.pdf")).toBe("reports/x.pdf");
  });

  it("createReportSignedUrl resolves new keys directly and legacy rows via fallback to the raw prefixed key", async () => {
    const id = "6fa6c9cb-706e-4671-8425-090da07cfe1d";
    const existing = new Set([`${id}/new.pdf`, `reports/${id}/old.pdf`]);
    const attempts: string[] = [];
    const db = {
      storage: {
        from: () => ({
          createSignedUrl: async (key: string) => {
            attempts.push(key);
            return existing.has(key)
              ? { data: { signedUrl: `https://x/sign/reports/${key}` }, error: null }
              : { data: null, error: { message: "Object not found" } };
          },
        }),
      },
    } as unknown as SupabaseClient;

    const n = await createReportSignedUrl(db, `${id}/new.pdf`);
    expect(n.key).toBe(`${id}/new.pdf`);
    const o = await createReportSignedUrl(db, `reports/${id}/old.pdf`);
    expect(o.key).toBe(`reports/${id}/old.pdf`);
    expect(attempts).toEqual([`${id}/new.pdf`, `${id}/old.pdf`, `reports/${id}/old.pdf`]);
    const missing = await createReportSignedUrl(db, `${id}/missing.pdf`);
    expect(missing.signedUrl).toBeNull();
  });
});

describe("Phase 6: PDF report generator & model parity", () => {
  it("bundles Thai-capable Sarabun Regular and Bold fonts and never reads pdfkit built-in font data files at runtime", async () => {
    const fonts = loadBundledThaiFonts();
    expect(fonts.regular).not.toBeNull();
    expect(fonts.bold).not.toBeNull();
    expect(fonts.regular!.length).toBeGreaterThan(50_000);
    expect(fonts.bold!.length).toBeGreaterThan(50_000);

    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      const model = buildReportModel({
        batch: GOLDEN_BATCH,
        deviceName: "jetson-line-1",
        rows: GOLDEN_ROWS,
        settings: DEFAULT_SETTINGS,
      });
      const pdfBuf = await renderQcReportPdf(model);
      expect(pdfBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it("1. reuses computeQcMetrics, matches dashboard numbers on golden case, and supports configurable report_footer_left & report_form_code via app_settings", async () => {
    const dashboardDetail = buildBatchDetailPayload({
      batch: GOLDEN_BATCH,
      rows: GOLDEN_ROWS,
      snapshotCount: 0,
      settings: DEFAULT_SETTINGS,
    });

    const reportModel = buildReportModel({
      batch: GOLDEN_BATCH,
      deviceName: "jetson-line-1",
      rows: GOLDEN_ROWS,
      settings: DEFAULT_SETTINGS,
    });

    expect(reportModel.metrics).toEqual(dashboardDetail.metrics);
    expect(reportModel.weight).toEqual(dashboardDetail.weight);
    expect(reportModel.settings.report_footer_left).toBe(DEFAULT_REPORT_FOOTER_LEFT);
    expect(reportModel.settings.report_form_code).toBe(DEFAULT_REPORT_FORM_CODE);

    // Footnote must cite the 4 per-class weights from app_settings and "ASSUMED, not measured", never fixed 500 g
    expect(reportModel.weightFootnote).toContain("good 0.31 g");
    expect(reportModel.weightFootnote).toContain("immature 0.2 g");
    expect(reportModel.weightFootnote).toContain("spoiled/mold 0.25 g");
    expect(reportModel.weightFootnote).toContain("discolor 0.3 g");
    expect(reportModel.weightFootnote).toContain("ASSUMED, not measured");
    expect(reportModel.weightFootnote).not.toContain("500");

    // Verify custom footer settings via applyAppSettingsRows
    const customSettings = applyAppSettingsRows([
      { key: "report_footer_left", value: "SQUAD · Custom QC Report" },
      { key: "report_form_code", value: "FM-JJR-REV2" },
    ]);
    expect(customSettings.report_footer_left).toBe("SQUAD · Custom QC Report");
    expect(customSettings.report_form_code).toBe("FM-JJR-REV2");

    const customModel = buildReportModel({
      batch: GOLDEN_BATCH,
      deviceName: "jetson-line-1",
      rows: GOLDEN_ROWS,
      settings: customSettings,
    });
    const customPdf = await renderQcReportPdf(customModel);
    const utf16BeSquad = Buffer.from(
      "\x00S\x00Q\x00U\x00A\x00D\x00 \x00\xb7\x00 \x00C\x00u\x00s\x00t\x00o\x00m",
      "latin1",
    );
    expect(customPdf.includes(utf16BeSquad)).toBe(true);
  });

  it("2. smoke test: generates valid PDF buffers (%PDF header, >= 1 page) for the golden case (with Thai names & approximate snapshot match) and for an empty batch", async () => {
    const snapshots: RawSnapshotRecord[] = [
      {
        id: "snap-p1",
        batch_id: GOLDEN_BATCH.id,
        filename: "20261028_030010_1กข2345_plate1.jpg",
        storage_path: `${GOLDEN_BATCH.id}/p1.jpg`,
        thumb_path: `${GOLDEN_BATCH.id}/thumbs/p1.jpg`,
        plate_number: 1,
        captured_at: "2026-10-28T03:00:10.000Z",
      },
      // Plate 3 has no rows in GOLDEN_ROWS, but timestamp is within ±15s of Plate 1 -> approximate match
      {
        id: "snap-p3-approx",
        batch_id: GOLDEN_BATCH.id,
        filename: "20261028_030012_1กข2345_plate3.jpg",
        storage_path: `${GOLDEN_BATCH.id}/p3.jpg`,
        thumb_path: null,
        plate_number: 3,
        captured_at: "2026-10-28T03:00:12.000Z",
      },
    ];

    const goldenModel = buildReportModel({
      batch: GOLDEN_BATCH,
      deviceName: "jetson-line-1",
      rows: GOLDEN_ROWS,
      snapshots,
      settings: DEFAULT_SETTINGS,
      generatedAt: new Date("2026-10-29T03:45:00.000Z"),
    });

    expect(goldenModel.snapshots).toHaveLength(2);
    expect(goldenModel.snapshots[0]?.approximate).toBe(false);
    expect(goldenModel.snapshots[1]?.approximate).toBe(true);
    expect(goldenModel.snapshots[1]?.rowMatchLine).toContain("other plate · approximate");

    const goldenPdf = await renderQcReportPdf(goldenModel);
    expect(goldenPdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(countPdfPages(goldenPdf)).toBeGreaterThanOrEqual(1);

    // Empty batch (no rows, no snapshots, long Thai/English name)
    const emptyBatch: RawBatchRecord = {
      ...GOLDEN_BATCH,
      id: "33333333-4444-5555-6666-777777777777",
      truck_plate:
        "ทะเบียนรถยาวมาก 99กข-9999 นครราชสีมา — Long Truck Plate Name Wrapping Check",
      qc_name: "ผู้ตรวจสอบคุณภาพเมล็ดข้าว สมหญิง รักงานดี (Inspector Somying)",
      row_count: 0,
    };
    const emptyModel = buildReportModel({
      batch: emptyBatch,
      rows: [],
      snapshots: [],
      settings: DEFAULT_SETTINGS,
    });
    expect(emptyModel.metrics.empty).toBe(true);
    const emptyPdf = await renderQcReportPdf(emptyModel);
    expect(emptyPdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(countPdfPages(emptyPdf)).toBeGreaterThanOrEqual(1);
  });

  it("3. SAMPLE 1 (grain_SAMPLE 1_20261019_061517_rolling10s.csv) acceptance: Good 84.5% / Defect 15.5% by weight (71 g of 84 g est.), caps image downloads to <= 6 on 137 snapshots, and writes ./tmp/sample1_qc_report.pdf", async () => {
    const sample1Candidates = [
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "grain_SAMPLE 1_20261019_061517_rolling10s.csv",
      ),
      "C:/tmp/agv-test/grain_SAMPLE 1_20261019_061517_rolling10s.csv",
    ];
    const sample1Path = sample1Candidates.find((p) => existsSync(p));
    expect(sample1Path).toBeDefined();

    const csvText = readFileSync(sample1Path!, "utf8");
    const parsed = parseInspectionCsv(csvText);
    expect(parsed.rows.length).toBe(55);

    const lastRow = parsed.rows[parsed.rows.length - 1]!;
    const sample1Batch: RawBatchRecord = {
      id: "6fa6c9cb-706e-4671-8425-090da07cfe1d",
      mode: "grain",
      device_id: null,
      source_name: "grain_SAMPLE 1_20261019_061517_rolling10s.csv",
      truck_plate: lastRow.truck_plate,
      qc_name: lastRow.qc_name,
      started_at: parsed.rows[0]!.snapshot_time.toISOString(),
      last_data_at: lastRow.snapshot_time.toISOString(),
      row_count: parsed.rows.length,
      created_at: parsed.rows[0]!.snapshot_time.toISOString(),
    };

    const rawRows: RawInspectionRowRecord[] = parsed.rows.map((r, i) => ({
      id: i + 1,
      snapshot_time: r.snapshot_time.toISOString(),
      plate_number: r.plate_number,
      snapshot_type: r.snapshot_type,
      snapshot_total: r.snapshot_total,
      estimated_grain_count: r.estimated_grain_count,
      mix: r.mix,
      mix_raw: r.mix_raw,
    }));

    const model = buildReportModel({
      batch: sample1Batch,
      deviceName: "test-pc",
      rows: rawRows,
      settings: DEFAULT_SETTINGS,
      generatedAt: new Date("2026-10-29T03:45:00.000Z"),
    });

    expect(model.metrics.empty).toBe(false);
    if (!model.metrics.empty) {
      expect(round1(model.metrics.good_pct_wt)).toBe(84.5);
      expect(round1(model.metrics.total_defect_pct_wt)).toBe(15.5);
      expect(Math.round(model.metrics.good_weight_g)).toBe(71);
      expect(Math.round(model.metrics.defect_weight_g)).toBe(13);
      expect(Math.round(model.metrics.total_weight_g)).toBe(84);
      expect(round1(model.metrics.pct.good ?? 0)).toBe(81.5);
      expect(round1(model.metrics.total_defect_pct)).toBe(18.5);
      expect(model.metrics.estimated_seeds).toBe(281);
      expect(model.metrics.total_plates).toBe(1);
    }

    const pdfBuf = await renderQcReportPdf(model);
    expect(pdfBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(countPdfPages(pdfBuf)).toBeGreaterThanOrEqual(1);

    const outDir = path.join(process.cwd(), "tmp");
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "sample1_qc_report.pdf");
    writeFileSync(outFile, pdfBuf);
    expect(existsSync(outFile)).toBe(true);

    // Verify generateAndStoreBatchReport on a batch with 137 snapshots:
    // - fetches at most <= 6 snapshot thumbnails
    // - uploads to the `reports` bucket
    // - inserts exact schema columns into `public.reports` (batch_id, storage_path, filename, params, created_by)
    const snapshots137: RawSnapshotRecord[] = Array.from({ length: 137 }, (_, idx) => {
      const ts = new Date(
        parsed.rows[idx % parsed.rows.length]!.snapshot_time.getTime() + (idx % 5) * 1000,
      );
      return {
        id: `snap-${idx + 1}`,
        batch_id: sample1Batch.id,
        filename: `20261019_0615${String(idx % 60).padStart(2, "0")}_SAMPLE_1_plate1_${idx + 1}.jpg`,
        storage_path: `${sample1Batch.id}/img_${idx + 1}.jpg`,
        thumb_path: `${sample1Batch.id}/thumbs/img_${idx + 1}.jpg`,
        plate_number: 1,
        captured_at: ts.toISOString(),
      };
    });

    const downloadedPaths: string[] = [];
    const uploadedReports: { bucket: string; path: string; bytes: number }[] = [];
    const insertedReportRows: Record<string, unknown>[] = [];

    const mockDb = {
      from(table: string) {
        if (table === "app_settings") {
          return {
            select: async () => ({
              data: [
                { key: "good_seed_weight_g", value: "0.31" },
                { key: "immature_seed_weight_g", value: "0.20" },
                { key: "sm_seed_weight_g", value: "0.25" },
                { key: "dc_seed_weight_g", value: "0.30" },
                { key: "report_footer_left", value: "SQAUD · Grain QC Report" },
                { key: "report_form_code", value: "FM-JJR" },
              ],
              error: null,
            }),
          };
        }
        if (table === "batches") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: sample1Batch, error: null }),
              }),
            }),
          };
        }
        if (table === "inspection_rows") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  order: () => ({
                    range: async (from: number) => ({
                      data: from === 0 ? rawRows : [],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "snapshots") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  order: () => ({
                    range: async (from: number) => ({
                      data: from === 0 ? snapshots137 : [],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "reports") {
          return {
            insert: (row: Record<string, unknown>) => {
              insertedReportRows.push(row);
              return {
                select: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "99999999-8888-4777-a666-555555555555",
                      created_at: "2026-10-29T04:00:00.000Z",
                    },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      storage: {
        from(bucket: string) {
          return {
            download: async (storagePath: string) => {
              downloadedPaths.push(storagePath);
              return { data: null, error: { message: "no mock image" } };
            },
            upload: async (storagePath: string, buf: Buffer) => {
              uploadedReports.push({ bucket, path: storagePath, bytes: buf.length });
              return { data: { path: storagePath }, error: null };
            },
            createSignedUrl: async (storagePath: string, expiresIn: number) => ({
              data: {
                signedUrl: `https://emqooadipseotdbzqtbd.supabase.co/storage/v1/object/sign/${bucket}/${storagePath}?token=mock&exp=${expiresIn}`,
              },
              error: null,
            }),
          };
        },
      },
    } as unknown as SupabaseClient;

    const stored = await generateAndStoreBatchReport(mockDb, sample1Batch.id, {
      maxSnapshots: 99, // even if caller asks for > 6, capped at <= 6
      now: new Date("2026-10-29T04:00:00.000Z"),
    });

    expect(stored).not.toBeNull();
    // 137 snapshots in batch -> at most 6 selected (1 primary thumbnail + 1 fallback attempt = max 6 selected entries)
    expect(downloadedPaths.length).toBeLessThanOrEqual(12);
    expect(uploadedReports).toHaveLength(1);
    expect(uploadedReports[0]?.bucket).toBe(REPORT_BUCKET);
    expect(uploadedReports[0]?.path).toBe(
      `${sample1Batch.id}/20261029T040000Z.pdf`,
    );
    expect(insertedReportRows[0]?.storage_path).toBe(uploadedReports[0]?.path);
    expect(stored?.storage_path).toBe(`${sample1Batch.id}/20261029T040000Z.pdf`);
    expect(stored?.signed_url).toContain(`/sign/${REPORT_BUCKET}/${sample1Batch.id}/`);
    expect(stored?.signed_url).not.toContain("/reports/reports/");
    expect(insertedReportRows).toHaveLength(1);
    expect(Object.keys(insertedReportRows[0]!).sort()).toEqual([
      "batch_id",
      "created_by",
      "filename",
      "params",
      "storage_path",
    ]);
  });
});
