import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMixSummary, parseCsv, parseInspectionCsv, formatSkipSummary } from "@/lib/qc/parse";
import { formatSeeds } from "@/lib/qc/format";
import { parseCsvTimestamp } from "@/lib/qc/time";
import {
  parseSnapshotMeta,
  matchSnapshot,
  matchSnapshotToRow,
  isImageFilename,
} from "@/lib/qc/snapshot-meta";

describe("parseMixSummary", () => {
  it("parses counts and ignores percentages", () => {
    expect(parseMixSummary("good=120 (60.0%), immature=30 (15.0%), sm=5 (2.5%), dc=2 (1.0%)")).toEqual({
      good: 120, immature: 30, sm: 5, dc: 2,
    });
  });
  it("sums duplicates, keeps unknown names, tolerates spaces", () => {
    expect(parseMixSummary("good = 5, good=7, weird-1_x=3")).toEqual({ good: 12, "weird-1_x": 3 });
  });
  it("non-string / empty -> {}", () => {
    expect(parseMixSummary(undefined)).toEqual({});
    expect(parseMixSummary("")).toEqual({});
  });
});

describe("parseCsvTimestamp", () => {
  it("naive = Asia/Bangkok wall clock", () => {
    expect(parseCsvTimestamp("2026-10-28 12:00:00")?.toISOString()).toBe("2026-10-28T05:00:00.000Z");
    expect(parseCsvTimestamp("2026-10-28T12:00:00.5")?.toISOString()).toBe("2026-10-28T05:00:00.500Z");
  });
  it("explicit offset is honoured", () => {
    expect(parseCsvTimestamp("2026-10-28 12:00:00+07:00")?.toISOString()).toBe("2026-10-28T05:00:00.000Z");
    expect(parseCsvTimestamp("2026-10-28 12:00:00Z")?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
  });
  it("invalid -> null", () => {
    expect(parseCsvTimestamp("garbage")).toBeNull();
    expect(parseCsvTimestamp("2026-13-40 00:00:00")).toBeNull();
    expect(parseCsvTimestamp(undefined)).toBeNull();
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded commas, CRLF, BOM", () => {
    const t = '\ufeffa,b\r\n"x,1","he said ""hi"""\r\n';
    expect(parseCsv(t)).toEqual([["a", "b"], ["x,1", 'he said "hi"']]);
  });
});

describe("parseInspectionCsv", () => {
  const header =
    "snapshot_time,truck_plate,qc_name,snapshot_mix_summary,plate_number,estimated_grain_count,snapshot_total,snapshot_type";

  it("parses, sorts ascending, skips bad rows", () => {
    const csv = [
      header,
      '2026-10-28 10:00:10,1กข234,Somchai,"good=90 (90.0%), immature=10 (10.0%)",2,800,100,last_frame',
      '2026-10-28 10:00:00,1กข234,Somchai,"good=80 (80.0%), sm=20 (20.0%)",1,700,100,plate_end',
      "not-a-time,x,y,good=1,1,1,1,last_frame",
      "2026-10-28 10:00:20,a,b,good=1,1,1,1,last_frame,EXTRA_FIELD",
    ].join("\n");
    const { rows, skipped } = parseInspectionCsv(csv);
    expect(skipped).toBe(2);
    expect(rows.map((r) => r.plate_number)).toEqual([1, 2]);
    expect(rows[0]!.mix).toEqual({ good: 80, sm: 20 });
    expect(rows[0]!.truck_plate).toBe("1กข234");
    expect(rows[1]!.estimated_grain_count).toBe(800);
  });

  it("legacy columns: bin_end_ts, farm_name, no plate/type/estimate columns", () => {
    const csv = "bin_end_ts,farm_name,snapshot_mix_summary,snapshot_total\n2026-10-28 10:00:00,Farm A,good=9,42\n";
    const { rows } = parseInspectionCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      truck_plate: "Farm A", qc_name: "", plate_number: 1, snapshot_type: "last_frame",
      snapshot_total: 42, estimated_grain_count: 42,
    });
  });

  it("truck_plate wins over farm_name; bad numerics coerce like pandas", () => {
    const csv =
      "snapshot_time,truck_plate,farm_name,snapshot_total,plate_number,estimated_grain_count\n" +
      "2026-10-28 10:00:00,T1,F1,12.9,abc,\n";
    const { rows } = parseInspectionCsv(csv);
    expect(rows[0]).toMatchObject({
      truck_plate: "T1", snapshot_total: 12, plate_number: 1, estimated_grain_count: 0,
    });
  });

  it("empty input and missing time column", () => {
    expect(parseInspectionCsv("")).toMatchObject({ rows: [], skipped: 0, skip_reasons: {} });
    const r = parseInspectionCsv("a,b\n1,2\n");
    expect(r.rows).toEqual([]);
    expect(r.skip_reasons).toEqual({ missing_time_column: 1 });
  });

  it("reports skip counts, reasons and sample records", () => {
    const csv = [
      "snapshot_time,snapshot_total",
      "bad,1",
      "2026-10-28 10:00:00,1",
      "also bad,2",
      "2026-10-28 10:00:01,1,extra",
    ].join("\n");
    const r = parseInspectionCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toBe(3);
    expect(r.skip_reasons).toEqual({ bad_timestamp: 2, too_many_fields: 1 });
    expect(r.skipped_samples).toEqual([
      { record: 1, reason: "bad_timestamp" },
      { record: 3, reason: "bad_timestamp" },
      { record: 4, reason: "too_many_fields" },
    ]);
    expect(formatSkipSummary(r)).toBe("skipped 3 row(s): bad_timestamp=2, too_many_fields=1");
    expect(formatSkipSummary({ skipped: 0, skip_reasons: {} })).toBe("skipped 0 row(s)");
  });
});

describe("formatSeeds", () => {
  it("null -> em dash", () => {
    expect(formatSeeds(null)).toBe("—");
    expect(formatSeeds(1600)).toBe("1,600");
  });
});

describe("parseSnapshotMeta", () => {
  it("YYYYMMDD_HHMMSS_<Truck>_plateN.jpg defaults to UTC and supports Asia/Bangkok override", () => {
    const mUtc = parseSnapshotMeta("20261028_120000_1กข234_plate3.jpg");
    expect(mUtc.ts?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(mUtc.plate).toBe(3);

    const mBkk = parseSnapshotMeta("20261028_120000_1กข234_plate3.jpg", "Asia/Bangkok");
    expect(mBkk.ts?.toISOString()).toBe("2026-10-28T05:00:00.000Z");
    expect(mBkk.plate).toBe(3);
  });
  it("snapshot_<Truck>_YYYYMMDD_HHMMSS_plateN.jpg, case-insensitive plate", () => {
    const m = parseSnapshotMeta("snapshot_ABC_20261028_120000_PLATE12.JPG");
    expect(m.ts?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(m.plate).toBe(12);
  });
  it("legacy name without plate", () => {
    expect(parseSnapshotMeta("snapshot_ABC_20261028_120000.jpg")).toMatchObject({ plate: null });
  });
  it("YYYY-MM-DD HH-MM-SS and underscore variant", () => {
    expect(parseSnapshotMeta("2026-10-28 12-00-00_plate1.png").ts?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(parseSnapshotMeta("x_2026-10-28_12-00-00.png").ts?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(parseSnapshotMeta("2026-10-28 12-00-00_plate1.png", "Asia/Bangkok").ts?.toISOString()).toBe(
      "2026-10-28T05:00:00.000Z",
    );
  });
  it("epoch ms then epoch s", () => {
    expect(parseSnapshotMeta("snap_1793163600000_plate1.jpg").ts?.getTime()).toBe(1793163600000);
    expect(parseSnapshotMeta("snap_1793163600.jpg").ts?.getTime()).toBe(1793163600000);
  });
  it("pattern order: YYYYMMDD_HHMMSS wins over digits elsewhere", () => {
    expect(parseSnapshotMeta("1793163600_20261028_120000.jpg").ts?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
  });
  it("invalid calendar date falls through; no timestamp -> null", () => {
    expect(parseSnapshotMeta("20261399_999999.jpg").ts).toBeNull();
    expect(parseSnapshotMeta("hello.jpg")).toEqual({ ts: null, plate: null });
  });
  it("image extensions", () => {
    for (const f of ["a.jpg", "a.JPEG", "a.png", "a.bmp", "a.webp"]) expect(isImageFilename(f)).toBe(true);
    expect(isImageFilename("a.gif")).toBe(false);
  });
  it("matches real fixture filenames against real_multiplate.csv with 0s diff under UTC and -7h diff under Asia/Bangkok", () => {
    const csvText = readFileSync(
      path.join(__dirname, "..", "parity", "fixtures", "real_multiplate.csv"),
      "utf8",
    );
    const { rows } = parseInspectionCsv(csvText);
    const realSnapshotFiles = [
      "snapshot_nj2_20260914_084811.jpg",
      "snapshot_nj2_20260914_084820.jpg",
      "snapshot_nj2_20260914_084830.jpg",
      "snapshot_nj2_20260914_084840.jpg",
      "snapshot_nj2_20260914_084850.jpg",
      "snapshot_nj2_20260914_084856_plate1.jpg",
      "snapshot_nj2_20260914_084930_plate2.jpg",
      "snapshot_nj2_20260914_085007_plate3.jpg",
      "snapshot_nj2_20260914_085103_plate4.jpg",
      "snapshot_nj2_20260914_085130.jpg",
    ];

    for (const fname of realSnapshotFiles) {
      // Under default "UTC", every real filename matches its exact CSV row with 0s delta
      const matchUtc = matchSnapshotToRow({ filename: fname }, rows, "UTC", 15);
      expect(matchUtc).not.toBeNull();
      expect(matchUtc!.deltaSeconds).toBe(0);

      // Under "Asia/Bangkok", the filename timestamp is shifted by -7 hours (25,200 s) and fails the ±15 s match
      const metaBkk = parseSnapshotMeta(fname, "Asia/Bangkok");
      const metaUtc = parseSnapshotMeta(fname, "UTC");
      expect((metaUtc.ts!.getTime() - metaBkk.ts!.getTime()) / 1000).toBe(7 * 3600);
      expect(matchSnapshotToRow({ filename: fname }, rows, "Asia/Bangkok", 15)).toBeNull();
    }
  });
});

describe("matchSnapshot", () => {
  const mk = (name: string) => ({ filename: name, ...parseSnapshotMeta(name, "UTC") });
  const imgs = [
    mk("20261028_120000_T_plate1.jpg"),
    mk("20261028_120010_T_plate2.jpg"),
    mk("snapshot_T_20261028_120012.jpg"), // no plate
  ];
  const rowTs = parseCsvTimestamp("2026-10-28 19:00:11+07:00")!; // 12:00:11Z

  it("prefers the closest image with matching plate, accepts plate-less", () => {
    expect(matchSnapshot(rowTs, imgs, 2)?.filename).toBe("20261028_120010_T_plate2.jpg");
    expect(matchSnapshot(rowTs, imgs, 1)?.filename).toBe("snapshot_T_20261028_120012.jpg");
  });
  it("respects ±15 s tolerance", () => {
    expect(matchSnapshot(parseCsvTimestamp("2026-10-28 19:05:00+07:00")!, imgs, null)).toBeNull();
  });
  it("null row time or no images -> null", () => {
    expect(matchSnapshot(null, imgs)).toBeNull();
    expect(matchSnapshot(rowTs, [])).toBeNull();
  });
});
