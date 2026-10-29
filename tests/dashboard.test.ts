import { describe, expect, it } from "vitest";
import { formatRealtimeIndicator } from "@/components/dashboard/dashboard-client";
import {
  constantTimeEqual,
  enforceDashboardBasicAuth,
  evaluateDashboardBasicAuth,
  shouldProtectWithDashboardGate,
} from "@/lib/auth/basic-auth";
import {
  buildBatchDetailPayload,
  buildBatchSnapshotsPayload,
  buildBatchSummaryItem,
  selectAutoConnectBatchId,
  SNAPSHOTS_PER_PAGE,
  type RawBatchRecord,
  type RawSnapshotRecord,
} from "@/lib/dashboard/queries";
import { formatSnapshotRowMatchLine } from "@/components/dashboard/snapshots-tab";
import { applyAppSettingsRows, DEFAULT_SETTINGS } from "@/lib/qc/config";
import { formatSeeds } from "@/lib/qc/format";
import { round1 } from "@/lib/qc/metrics";
import {
  formatAgeLabel,
  formatBangkokDateKey,
  formatBangkokTimestamp,
  freshnessDot,
} from "@/lib/qc/time";

const SAMPLE_BATCH: RawBatchRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  mode: "grain",
  device_id: null,
  source_name: "grain_83-4501_rolling10s_100000.csv",
  truck_plate: "83-4501",
  qc_name: "Somchai",
  started_at: "2026-10-28T03:00:00.000Z",
  last_data_at: "2026-10-28T03:05:12.000Z", // 10:05:12 Asia/Bangkok
  row_count: 2,
  created_at: "2026-10-28T03:00:00.000Z",
};

describe("Phase 4 dashboard helpers & payload builders", () => {
  it("formats timestamps and date keys in Asia/Bangkok (UTC+7)", () => {
    // 2026-10-27 18:30:05 UTC is 2026-10-28 01:30:05 in Asia/Bangkok
    const iso = "2026-10-27T18:30:05.000Z";
    expect(formatBangkokTimestamp(iso)).toBe("01:30:05 · 28/10/2026");
    expect(formatBangkokDateKey(iso)).toBe("2026-10-28");
    expect(formatBangkokTimestamp(null)).toBe("—");
  });

  it("computes freshness dot and age labels matching legacy rules", () => {
    expect(freshnessDot(0)).toBe("🟢");
    expect(freshnessDot(59.9)).toBe("🟢");
    expect(freshnessDot(60)).toBe("🟡");
    expect(freshnessDot(299)).toBe("🟡");
    expect(freshnessDot(300)).toBe("🔴");

    expect(formatAgeLabel(12.8)).toBe("12s ago");
    expect(formatAgeLabel(300)).toBe("5m ago");
    expect(formatAgeLabel(10800)).toBe("3h ago");
  });

  it("selects auto-connect batch only when newest batch is within active_ttl_s", () => {
    const nowMs = new Date("2026-10-28T03:05:30.000Z").getTime(); // 18s after SAMPLE_BATCH.last_data_at
    const liveItem = buildBatchSummaryItem(SAMPLE_BATCH, nowMs, "2026-10-28");
    expect(liveItem.age_s).toBe(18);
    expect(liveItem.freshness).toBe("🟢");
    expect(liveItem.is_today).toBe(true);
    expect(selectAutoConnectBatchId([liveItem], 60)).toBe(SAMPLE_BATCH.id);

    const staleNowMs = new Date("2026-10-28T03:10:00.000Z").getTime(); // 288s old
    const staleItem = buildBatchSummaryItem(SAMPLE_BATCH, staleNowMs, "2026-10-28");
    expect(staleItem.freshness).toBe("🟡");
    expect(selectAutoConnectBatchId([staleItem], 60)).toBeNull();
  });

  it("builds full batch detail payload for the golden 2-plate case + filters tracing rows", () => {
    const detail = buildBatchDetailPayload({
      batch: SAMPLE_BATCH,
      snapshotCount: 4,
      settings: DEFAULT_SETTINGS,
      nowMs: new Date("2026-10-28T03:05:20.000Z").getTime(),
      rows: [
        {
          snapshot_time: "2026-10-28T03:01:00.000Z",
          plate_number: 1,
          snapshot_type: "last_frame",
          snapshot_total: 100,
          estimated_grain_count: 800,
          mix: { good: 90, immature: 6, sm: 2, dc: 2 },
          mix_raw: "good=90, immature=6, sm=2, dc=2",
        },
        // mid_frame row: included in total_rows/windowed_rows, excluded from kept_rows_count & tracing_rows
        {
          snapshot_time: "2026-10-28T03:02:00.000Z",
          plate_number: 1,
          snapshot_type: "mid_frame",
          snapshot_total: 100,
          estimated_grain_count: 800,
          mix: { good: 50, immature: 50 },
          mix_raw: "good=50, immature=50",
        },
        // plate 2 with 0 estimated_grain_count -> seeds is null ("—") while good_seeds_est falls back to snapshot_total
        {
          snapshot_time: "2026-10-28T03:05:12.000Z",
          plate_number: 2,
          snapshot_type: "plate_end",
          snapshot_total: 100,
          estimated_grain_count: 0,
          mix: { good: 80, immature: 10, sm: 5, dc: 5 },
          mix_raw: "good=80, immature=10, sm=5, dc=5",
        },
      ],
    });

    expect(detail.total_rows).toBe(3);
    expect(detail.windowed_rows).toBe(3);
    expect(detail.kept_rows_count).toBe(2);
    expect(detail.snapshot_count).toBe(4);
    expect(detail.latest_time_bangkok).toBe("10:05:12 · 28/10/2026");

    expect(detail.tracing_rows).toHaveLength(2);
    expect(detail.tracing_rows[0]?.row_index).toBe(0);
    expect(detail.tracing_rows[1]?.row_index).toBe(1);

    expect(detail.metrics.empty).toBe(false);
    if (!detail.metrics.empty) {
      // Plate 1 has 800 seeds (90% good = 720, 10% defect = 80)
      // Plate 2 has 0 estimated_grain_count -> falls back to snapshot_total=100 (80% good = 80, 20% defect = 20)
      // Batch total = 900 seeds -> 800 good / 900 = 88.9% good, 11.1% defect
      expect(round1(detail.metrics.pct.good ?? 0)).toBe(88.9);
      expect(round1(detail.metrics.total_defect_pct)).toBe(11.1);
      expect(detail.metrics.has_high_variance).toBe(true);
      expect(detail.metrics.plates[0]?.seeds).toBe(800);
      expect(formatSeeds(detail.metrics.plates[0]?.seeds)).toBe("800");
      expect(detail.metrics.plates[1]?.seeds).toBe(100);
      expect(formatSeeds(detail.metrics.plates[1]?.seeds)).toBe("100");
      // Plate 2 good_seeds_est falls back to median snapshot_total (100 * 0.80 = 80)
      expect(round1(detail.metrics.plates[1]?.good_seeds_est ?? 0)).toBe(80.0);
    }
  });

  it("disables obsolete ±25% 500 g weight_warning by default while keeping weight alert active, and allows opt-in via weight_sanity_tol", () => {
    const fivePlateRows = [1, 2, 3, 4, 5].map((plate_number) => ({
      snapshot_time: `2026-10-28T03:05:1${plate_number}.000Z`,
      plate_number,
      snapshot_type: "last_frame",
      snapshot_total: 400,
      estimated_grain_count: 4458,
      mix: { good: 320, immature: 20, sm: 30, dc: 30 },
      mix_raw: "good=320, immature=20, sm=30, dc=30",
    }));

    const detailDefault = buildBatchDetailPayload({
      batch: SAMPLE_BATCH,
      snapshotCount: 0,
      settings: DEFAULT_SETTINGS,
      rows: fivePlateRows,
    });

    expect(detailDefault.metrics.empty).toBe(false);
    if (!detailDefault.metrics.empty) {
      expect(detailDefault.metrics.weight_warning).toBe(false);
      expect(detailDefault.metrics.total_defect_pct_wt).toBeGreaterThan(10);
      expect(detailDefault.metrics.is_defect_high).toBe(true);
    }
    expect(detailDefault.weight?.weight_warning).toBe(false);
    expect(detailDefault.weight?.weight_alert_active).toBe(true);
    expect(detailDefault.weight?.message).toBeNull();

    const detailOptIn = buildBatchDetailPayload({
      batch: SAMPLE_BATCH,
      snapshotCount: 0,
      settings: { ...DEFAULT_SETTINGS, weight_sanity_tol: 0.25 },
      rows: fivePlateRows,
    });
    expect(detailOptIn.weight?.weight_warning).toBe(true);
    expect(detailOptIn.weight?.message).toContain("WEIGHT WARNING");
  });

  it("Phase 5: builds Snapshots gallery payload (16 per page, newest first, plate filter, same-plate ±15s row matching, bulk signed URLs only for current page, thumb fallback)", async () => {
    // Create 20 snapshots across plates 1 and 2, plus 1 unmatched snapshot >15s away
    const snapshots: RawSnapshotRecord[] = Array.from({ length: 20 }, (_, i) => {
      const sec = String(10 + i).padStart(2, "0");
      const plate = i % 2 === 0 ? 1 : 2;
      const hasThumb = i % 3 !== 0;
      const filename = `20261019_0615${sec}_SAMPLE 1_plate${plate}.jpg`;
      return {
        id: `snap-${i}`,
        batch_id: SAMPLE_BATCH.id,
        filename,
        storage_path: `${SAMPLE_BATCH.id}/${filename}`,
        thumb_path: hasThumb ? `${SAMPLE_BATCH.id}/thumbs/${filename}` : null,
        plate_number: plate,
        captured_at: `2026-10-19T06:15:${sec}.000Z`,
      };
    });
    // Add one snapshot on plate 4 at 06:15:20 UTC (within ±15s of plate 2's row at 06:15:19 UTC, but plate 4 has NO rows) -> approximate fallback
    snapshots.push({
      id: "snap-approx-other-plate",
      batch_id: SAMPLE_BATCH.id,
      filename: "20261019_061520_SAMPLE 1_plate4.jpg",
      storage_path: `${SAMPLE_BATCH.id}/20261019_061520_SAMPLE 1_plate4.jpg`,
      thumb_path: null,
      plate_number: 4,
      captured_at: "2026-10-19T06:15:20.000Z",
    });
    // Add one snapshot at 06:30:00 UTC with no close row
    snapshots.push({
      id: "snap-unmatched",
      batch_id: SAMPLE_BATCH.id,
      filename: "20261019_063000_SAMPLE 1_plate3.jpg",
      storage_path: `${SAMPLE_BATCH.id}/20261019_063000_SAMPLE 1_plate3.jpg`,
      thumb_path: null,
      plate_number: 3,
      captured_at: "2026-10-19T06:30:00.000Z",
    });

    const rows = [
      // Plate 1 row at 06:15:18Z (13:15:18+07:00)
      {
        id: 101,
        snapshot_time: "2026-10-19T06:15:18.000Z",
        plate_number: 1,
        snapshot_type: "last_frame",
        snapshot_total: 120,
        estimated_grain_count: 300,
        mix: { good: 100, immature: 20 },
        mix_raw: "good=100, immature=20",
      },
      // Plate 2 row at 06:15:19Z (13:15:19+07:00)
      {
        id: 102,
        snapshot_time: "2026-10-19T06:15:19.000Z",
        plate_number: 2,
        snapshot_type: "last_frame",
        snapshot_total: 115,
        estimated_grain_count: 290,
        mix: { good: 95, immature: 20 },
        mix_raw: "good=95, immature=20",
      },
    ];

    const signedCalls: { paths: readonly string[]; expiresInSec: number }[] = [];
    const signUrls = async (paths: readonly string[], expiresInSec: number) => {
      signedCalls.push({ paths, expiresInSec });
      const m = new Map<string, string>();
      for (const p of paths) {
        m.set(p, `https://signed.example/${encodeURIComponent(p)}?exp=${expiresInSec}`);
      }
      return m;
    };

    const settings = applyAppSettingsRows([{ key: "snapshot_filename_tz", value: "UTC" }]);
    expect(settings.snapshot_filename_tz).toBe("UTC");

    // Page 1 (16 items out of 22 total)
    const page1 = await buildBatchSnapshotsPayload({
      batch: SAMPLE_BATCH,
      snapshots,
      rows,
      settings,
      page: 1,
      pageSize: SNAPSHOTS_PER_PAGE,
      signUrls,
    });

    expect(page1.total_snapshots).toBe(22);
    expect(page1.total_filtered).toBe(22);
    expect(page1.matched_count).toBe(21);
    expect(page1.unmatched_count).toBe(1);
    expect(page1.available_plates).toEqual([1, 2, 3, 4]);
    expect(page1.page).toBe(1);
    expect(page1.total_pages).toBe(2);
    expect(page1.items).toHaveLength(16);

    // Newest first: index 0 is the 06:30:00 unmatched plate 3 snapshot
    expect(page1.items[0]?.filename).toBe("20261019_063000_SAMPLE 1_plate3.jpg");
    expect(page1.items[0]?.row_match).toBeNull();
    expect(formatSnapshotRowMatchLine(page1.items[0]!)).toBe("⚠️ No matching row");
    // Thumbnail fallback when thumb_path is null
    expect(page1.items[0]?.thumb_url).toBe(page1.items[0]?.full_url);

    // Next item is 06:15:29 plate 2 -> exact match to Plate 2 row (id=102, approximate=false, same_plate=true)
    expect(page1.items[1]?.filename).toBe("20261019_061529_SAMPLE 1_plate2.jpg");
    expect(page1.items[1]?.row_match?.plate_number).toBe(2);
    expect(page1.items[1]?.row_match?.row_id).toBe(102);
    expect(page1.items[1]?.row_match?.same_plate).toBe(true);
    expect(page1.items[1]?.row_match?.approximate).toBe(false);
    expect(formatSnapshotRowMatchLine(page1.items[1]!)).toContain("🔗 Row match: Plate 2 · 83-4501 · QC: Somchai");

    // Plate 4 snapshot (no rows on plate 4) falls back to Plate 2 row and is marked approximate=true, same_plate=false
    const approxItem = page1.items.find((it) => it.id === "snap-approx-other-plate")!;
    expect(approxItem).toBeDefined();
    expect(approxItem.plate_number).toBe(4);
    expect(approxItem.row_match?.plate_number).toBe(2);
    expect(approxItem.row_match?.same_plate).toBe(false);
    expect(approxItem.row_match?.approximate).toBe(true);
    expect(formatSnapshotRowMatchLine(approxItem)).toContain(
      "⚠️ Row match (other plate · approximate): Plate 2 · 83-4501 · QC: Somchai",
    );

    // Bulk signing called ONCE for page 1, only for page 1 items
    expect(signedCalls).toHaveLength(1);
    expect(signedCalls[0]!.paths.length).toBeLessThanOrEqual(32);

    // Plate filter = 1 -> only Plate 1 snapshots (10 items)
    const plate1Only = await buildBatchSnapshotsPayload({
      batch: SAMPLE_BATCH,
      snapshots,
      rows,
      settings,
      page: 1,
      plateFilter: 1,
      signUrls,
    });
    expect(plate1Only.total_filtered).toBe(10);
    expect(plate1Only.items.every((it) => it.plate_number === 1)).toBe(true);
    expect(plate1Only.items.every((it) => it.row_match?.plate_number === 1)).toBe(true);
  });

  it("enforces Dashboard Basic Auth gate: 503 fail-closed in prod when unset, dev bypass, 401 on missing/wrong credentials, 200 on valid credentials", async () => {
    // 1. Unset in production -> 503 fail closed
    const prodUnsetReq = new Request("https://example.com/api/batches");
    const res503 = enforceDashboardBasicAuth(prodUnsetReq, {
      NODE_ENV: "production",
    });
    expect(res503).not.toBeNull();
    expect(res503?.status).toBe(503);
    const body503 = await res503!.json();
    expect(body503.error).toBe("access_gate_unconfigured");

    // 2. Unset in development -> allowed (null response)
    const devRes = enforceDashboardBasicAuth(prodUnsetReq, {
      NODE_ENV: "development",
    });
    expect(devRes).toBeNull();

    // 3. Configured credentials: missing header -> 401 with WWW-Authenticate
    const configuredEnv = {
      NODE_ENV: "production",
      DASHBOARD_BASIC_AUTH_USER: "qc-operator",
      DASHBOARD_BASIC_AUTH_PASSWORD: "correct-horse-battery-staple",
    };
    const res401Missing = enforceDashboardBasicAuth(
      new Request("https://example.com/batches"),
      configuredEnv,
    );
    expect(res401Missing?.status).toBe(401);
    expect(res401Missing?.headers.get("WWW-Authenticate")).toContain("Basic");

    // 4. Configured credentials: wrong password or wrong user -> 401
    const wrongPassHeader = `Basic ${Buffer.from("qc-operator:wrong-password").toString("base64")}`;
    const res401WrongPass = enforceDashboardBasicAuth(
      new Request("https://example.com/api/batches", {
        headers: { Authorization: wrongPassHeader },
      }),
      configuredEnv,
    );
    expect(res401WrongPass?.status).toBe(401);

    const wrongUserHeader = `Basic ${Buffer.from("intruder:correct-horse-battery-staple").toString("base64")}`;
    expect(evaluateDashboardBasicAuth(wrongUserHeader, configuredEnv).status).toBe(401);

    // 5. Configured credentials: valid user + pass -> 200 (null denial response)
    const validHeader = `Basic ${Buffer.from("qc-operator:correct-horse-battery-staple").toString("base64")}`;
    const resOk = enforceDashboardBasicAuth(
      new Request("https://example.com/api/batches", {
        headers: { Authorization: validHeader },
      }),
      configuredEnv,
    );
    expect(resOk).toBeNull();
    expect(constantTimeEqual("same-val", "same-val")).toBe(true);
    expect(constantTimeEqual("same-val", "diff-val")).toBe(false);
    expect(constantTimeEqual("short", "longer-string")).toBe(false);
  });

  it("protects UI pages and /api/batches* while bypassing device ingest, /api/admin/import, and /api/health", () => {
    expect(shouldProtectWithDashboardGate("/")).toBe(true);
    expect(shouldProtectWithDashboardGate("/batches")).toBe(true);
    expect(shouldProtectWithDashboardGate("/admin/import")).toBe(true);
    expect(shouldProtectWithDashboardGate("/api/batches")).toBe(true);
    expect(shouldProtectWithDashboardGate("/api/batches/11111111-2222-3333-4444-555555555555")).toBe(true);

    expect(shouldProtectWithDashboardGate("/api/ingest/rows")).toBe(false);
    expect(shouldProtectWithDashboardGate("/api/ingest/snapshots/sign")).toBe(false);
    expect(shouldProtectWithDashboardGate("/api/admin/import")).toBe(false);
    expect(shouldProtectWithDashboardGate("/api/health")).toBe(false);
    expect(shouldProtectWithDashboardGate("/_next/static/chunks/main.js")).toBe(false);
  });

  it("formats the live Realtime indicator for SUBSCRIBED (0 events vs arrived events), ERROR, POLLING_ONLY, and paused states", () => {
    const subZero = formatRealtimeIndicator({
      paused: false,
      channelState: "SUBSCRIBED",
      eventsReceived: 0,
      lastEventBangkok: null,
      refreshSec: 5,
    });
    expect(subZero.label).toContain("SUBSCRIBED (0 events)");
    expect(subZero.title).toContain("RLS = authenticated only");

    const subEvents = formatRealtimeIndicator({
      paused: false,
      channelState: "SUBSCRIBED",
      eventsReceived: 3,
      lastEventBangkok: "10:15:30 · 28/10/2026",
      refreshSec: 5,
    });
    expect(subEvents.label).toContain("SUBSCRIBED (3 events (10:15:30))");

    const errState = formatRealtimeIndicator({
      paused: false,
      channelState: "ERROR",
      eventsReceived: 0,
      lastEventBangkok: null,
      refreshSec: 5,
    });
    expect(errState.label).toContain("ERROR");

    const pollOnly = formatRealtimeIndicator({
      paused: false,
      channelState: "POLLING_ONLY",
      eventsReceived: 0,
      lastEventBangkok: null,
      refreshSec: 5,
    });
    expect(pollOnly.label).toContain("POLLING-ONLY");

    const pausedState = formatRealtimeIndicator({
      paused: true,
      channelState: "SUBSCRIBED",
      eventsReceived: 2,
      lastEventBangkok: null,
      refreshSec: 5,
    });
    expect(pausedState.label).toContain("paused");
  });
});
