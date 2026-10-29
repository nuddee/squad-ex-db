"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BatchPickerContent,
  BatchRowCard,
  readMruBatchIds,
  recordMruBatchId,
} from "./batch-picker";
import { QualityMixChart } from "./quality-mix-chart";
import { SnapshotsTab } from "./snapshots-tab";
import type {
  BatchDetailResponse,
  BatchSummaryItem,
  ListBatchesResponse,
} from "@/lib/dashboard/queries";
import type { AuthenticatedUser } from "@/lib/auth/session";
import {
  DEFAULT_SETTINGS,
  GOOD_KEY,
  MODES,
  SEED_WEIGHT_G,
  WEIGHT_VALUES_MEASURED,
} from "@/lib/qc/config";
import { formatSeeds } from "@/lib/qc/format";
import { round1 } from "@/lib/qc/metrics";
import { formatBangkokTimestamp } from "@/lib/qc/time";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser";

const TRACING_PAGE_SIZE = 25;

export type RealtimeChannelState = "SUBSCRIBED" | "ERROR" | "POLLING_ONLY";

export function formatRealtimeIndicator(params: {
  paused: boolean;
  channelState: RealtimeChannelState;
  eventsReceived: number;
  lastEventBangkok: string | null;
  refreshSec: number;
}): { label: string; color: string; title: string } {
  const { paused, channelState, eventsReceived, lastEventBangkok, refreshSec } = params;
  if (paused) {
    return {
      label: "⏸ Auto-refresh paused",
      color: "#d97706",
      title: "Both Realtime updates and periodic polling are paused.",
    };
  }
  const evText =
    eventsReceived > 0
      ? `${eventsReceived} event${eventsReceived === 1 ? "" : "s"}${lastEventBangkok ? ` (${lastEventBangkok.split(" · ")[0]})` : ""}`
      : "0 events";

  if (channelState === "SUBSCRIBED") {
    return {
      label: `🟢 Realtime: SUBSCRIBED (${evText}) · ${refreshSec}s poll`,
      color: "#16a34a",
      title:
        eventsReceived > 0
          ? `Supabase Realtime channel is SUBSCRIBED and has delivered ${eventsReceived} event(s).`
          : "Supabase Realtime channel is SUBSCRIBED. Note: with RLS = authenticated only, unauthenticated browsers receive 0 events until Phase 7 login; periodic server polling keeps data fresh.",
    };
  }
  if (channelState === "ERROR") {
    return {
      label: `⚠️ Realtime: ERROR (${evText}) · polling every ${refreshSec}s`,
      color: "#dc2626",
      title: "Supabase Realtime channel reported an error or timed out; relying on server polling.",
    };
  }
  return {
    label: `⏱ Realtime: POLLING-ONLY · every ${refreshSec}s`,
    color: "#475569",
    title: "Polling server every refresh_sec seconds.",
  };
}

export function DualMetricCard({
  label,
  pctCount,
  pctWeight,
  helpText,
  alert = false,
  threshold,
  testId,
}: {
  label: string;
  pctCount: number;
  pctWeight: number;
  helpText: string;
  alert?: boolean;
  threshold?: number;
  testId?: string;
}) {
  return (
    <div
      className={`metric-card dual-card${alert ? " alert" : ""}`}
      data-testid={testId}
    >
      <div>
        <div className="metric-label">{label}</div>
        <div className="dual-row">
          <div className="dual-col">
            <div className="dual-sub">By count</div>
            <div className="dual-val">{round1(pctCount).toFixed(1)}%</div>
          </div>
          <div className="dual-col wt">
            <div className="dual-sub">By weight</div>
            <div className="dual-val">{round1(pctWeight).toFixed(1)}%</div>
            {alert && threshold !== undefined && (
              <div className="dual-tag" data-testid="defect-alert-tag">
                ALERT &ge; {round1(threshold).toFixed(1)}%
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="metric-help">{helpText}</div>
    </div>
  );
}

export function DashboardClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = MODES.grain!;

  const urlBatchId = searchParams.get("batch");
  const urlDismissed = searchParams.get("dismissed") === "1";

  const [batchesData, setBatchesData] = useState<ListBatchesResponse | null>(null);
  const [batchDetail, setBatchDetail] = useState<BatchDetailResponse | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(urlBatchId);
  const [autoConnected, setAutoConnected] = useState<boolean>(
    searchParams.get("auto") === "1",
  );
  const [pickerDismissed, setPickerDismissed] = useState<boolean>(urlDismissed);
  const [showPickerModal, setShowPickerModal] = useState<boolean>(false);
  const [staleBatchWarning, setStaleBatchWarning] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean>(false);
  const [realtimeChannelState, setRealtimeChannelState] =
    useState<RealtimeChannelState>("POLLING_ONLY");
  const [realtimeEventsReceived, setRealtimeEventsReceived] = useState<number>(0);
  const [lastRealtimeEventBangkok, setLastRealtimeEventBangkok] = useState<string | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<"details" | "snapshots" | "report">(
    "details",
  );
  const [tracingPage, setTracingPage] = useState<number>(1);
  const [mruIds, setMruIds] = useState<string[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pdfGenerating, setPdfGenerating] = useState<boolean>(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfResult, setPdfResult] = useState<{
    filename: string;
    signed_url: string;
    storage_path: string;
    created_at: string;
  } | null>(null);

  const selectedBatchIdRef = useRef<string | null>(selectedBatchId);
  selectedBatchIdRef.current = selectedBatchId;

  useEffect(() => {
    setMruIds(readMruBatchIds());
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return null;
        }
        const body = (await res.json().catch(() => null)) as {
          user?: AuthenticatedUser;
        } | null;
        if (active && body?.user) {
          setCurrentUser(body.user);
        }
        return null;
      })
      .catch(() => null);
    return () => {
      active = false;
    };
  }, [router]);

  const handleSignOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    await getBrowserSupabaseClient()?.auth.signOut().catch(() => null);
    router.replace("/login");
  }, [router]);

  // Sync URL ?batch param changes (e.g. browser back/forward)
  useEffect(() => {
    if (urlBatchId !== selectedBatchId) {
      setSelectedBatchId(urlBatchId);
    }
    if (urlDismissed) {
      setPickerDismissed(true);
    }
  }, [urlBatchId, urlDismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBatchesList = useCallback(async () => {
    try {
      const res = await fetch("/api/batches", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login");
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ListBatchesResponse;
      setBatchesData(payload);
      return payload;
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [router]);

  const fetchBatchDetail = useCallback(
    async (batchId: string) => {
      try {
        const res = await fetch(`/api/batches/${encodeURIComponent(batchId)}`, {
          cache: "no-store",
        });
        if (res.status === 401) {
          router.replace("/login");
          return null;
        }
        if (res.status === 404) {
          // Stale-path guard: previously selected batch disappeared
          setStaleBatchWarning(batchId);
          setSelectedBatchId(null);
          setBatchDetail(null);
          setAutoConnected(false);
          router.replace("/");
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = (await res.json()) as BatchDetailResponse;
        setBatchDetail(detail);
        setErrorMsg(null);
        return detail;
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [router],
  );

  // Initial load + auto-connect (zero-click for normal operation)
  useEffect(() => {
    let mounted = true;
    (async () => {
      const list = await fetchBatchesList();
      if (!mounted || !list) return;

      if (selectedBatchId) {
        await fetchBatchDetail(selectedBatchId);
      } else if (!pickerDismissed && list.active_batch_id) {
        const liveId = list.active_batch_id;
        setSelectedBatchId(liveId);
        setAutoConnected(true);
        router.replace(`/?batch=${encodeURIComponent(liveId)}&auto=1`);
        await fetchBatchDetail(liveId);
      } else {
        setBatchDetail(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [selectedBatchId, pickerDismissed, fetchBatchesList, fetchBatchDetail, router]);

  // Fallback polling every `refresh_sec` seconds when not paused
  const settings = batchDetail?.settings ?? batchesData?.settings ?? DEFAULT_SETTINGS;
  const refreshSec = Math.max(1, Math.round(settings.refresh_sec || 5));

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(async () => {
      const list = await fetchBatchesList();
      const curId = selectedBatchIdRef.current;
      if (curId) {
        await fetchBatchDetail(curId);
      } else if (!pickerDismissed && list?.active_batch_id) {
        const liveId = list.active_batch_id;
        setSelectedBatchId(liveId);
        setAutoConnected(true);
        router.replace(`/?batch=${encodeURIComponent(liveId)}&auto=1`);
        await fetchBatchDetail(liveId);
      }
    }, refreshSec * 1000);
    return () => window.clearInterval(id);
  }, [paused, refreshSec, pickerDismissed, fetchBatchesList, fetchBatchDetail, router]);

  // Supabase Realtime subscription on `inspection_rows` and `snapshots` for the open batch
  useEffect(() => {
    if (paused || !selectedBatchId) {
      setRealtimeChannelState("POLLING_ONLY");
      return;
    }
    const sb = getBrowserSupabaseClient();
    if (!sb) {
      setRealtimeChannelState("POLLING_ONLY");
      return;
    }

    let cancelled = false;
    let activeChannel: ReturnType<typeof sb.channel> | null = null;

    const onRealtimeEvent = () => {
      if (cancelled) return;
      setRealtimeEventsReceived((c) => c + 1);
      setLastRealtimeEventBangkok(formatBangkokTimestamp(new Date()));
      void fetchBatchDetail(selectedBatchId);
      void fetchBatchesList();
    };

    void (async () => {
      try {
        const { data } = await sb.auth.getSession();
        if (data.session?.access_token) {
          sb.realtime.setAuth(data.session.access_token);
        }
      } catch {
        // Proceed with existing realtime auth state
      }
      if (cancelled) return;

      activeChannel = sb
        .channel(`batch-live-${selectedBatchId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "inspection_rows",
            filter: `batch_id=eq.${selectedBatchId}`,
          },
          onRealtimeEvent,
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "snapshots",
            filter: `batch_id=eq.${selectedBatchId}`,
          },
          onRealtimeEvent,
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setRealtimeChannelState("SUBSCRIBED");
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            setRealtimeChannelState("ERROR");
          } else {
            setRealtimeChannelState("POLLING_ONLY");
          }
        });
    })();

    return () => {
      cancelled = true;
      if (activeChannel) {
        void sb.removeChannel(activeChannel);
      }
    };
  }, [paused, selectedBatchId, fetchBatchDetail, fetchBatchesList]);

  const handleOpenBatch = (batchId: string) => {
    const nextMru = recordMruBatchId(batchId);
    setMruIds(nextMru);
    setStaleBatchWarning(null);
    setShowPickerModal(false);
    setAutoConnected(false);
    setPickerDismissed(true);
    setTracingPage(1);
    setRealtimeEventsReceived(0);
    setLastRealtimeEventBangkok(null);
    setPdfError(null);
    setPdfResult(null);
    setSelectedBatchId(batchId);
    router.push(`/?batch=${encodeURIComponent(batchId)}`);
  };

  const handleGeneratePdfReport = async () => {
    if (!selectedBatchId || !batchDetail || batchDetail.kept_rows_count === 0 || pdfGenerating) {
      return;
    }
    setPdfGenerating(true);
    setPdfError(null);
    try {
      const res = await fetch(`/api/batches/${encodeURIComponent(selectedBatchId)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_snapshots: 6 }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(errBody?.message ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as {
        filename: string;
        signed_url: string;
        storage_path: string;
        created_at: string;
      };
      setPdfResult(payload);
      if (typeof window !== "undefined" && payload.signed_url) {
        window.open(payload.signed_url, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfGenerating(false);
    }
  };

  const handleDismissPicker = () => {
    setShowPickerModal(false);
    setPickerDismissed(true);
  };

  const handleDisconnectBatch = () => {
    setSelectedBatchId(null);
    setBatchDetail(null);
    setAutoConnected(false);
    setPickerDismissed(true);
    setRealtimeEventsReceived(0);
    setLastRealtimeEventBangkok(null);
    router.push("/?dismissed=1");
  };

  const handleResetAutoConnect = () => {
    setPickerDismissed(false);
    router.push("/");
  };

  const mruQuickBatches = useMemo(() => {
    if (!batchesData) return [];
    const byId = new Map(batchesData.batches.map((b) => [b.id, b]));
    return mruIds
      .map((id) => byId.get(id))
      .filter((b): b is BatchSummaryItem => Boolean(b))
      .slice(0, 4);
  }, [batchesData, mruIds]);

  // Operation state (STANDBY / WAITING / RUNNING)
  const opState = useMemo(() => {
    if (!selectedBatchId || !batchDetail) {
      return {
        code: "STANDBY" as const,
        msg: "Select an inspection source",
        color: "#64748B",
      };
    }
    if (batchDetail.metrics.empty) {
      return {
        code: "WAITING" as const,
        msg: "Source connected · waiting for inspection data",
        color: "#D97706",
      };
    }
    return {
      code: "RUNNING" as const,
      msg: "Inspection data connected",
      color: "#16A34A",
    };
  }, [selectedBatchId, batchDetail]);

  const metrics = batchDetail?.metrics;
  const activeMetrics = metrics && !metrics.empty ? metrics : null;
  const weightInfo = batchDetail?.weight ?? null;

  // Tracing pagination
  const tracingRows = batchDetail?.tracing_rows ?? [];
  const totalTracingPages = Math.max(
    1,
    Math.ceil(tracingRows.length / TRACING_PAGE_SIZE),
  );
  const safeTracingPage = Math.min(tracingPage, totalTracingPages);
  const visibleTracingRows = tracingRows.slice(
    (safeTracingPage - 1) * TRACING_PAGE_SIZE,
    safeTracingPage * TRACING_PAGE_SIZE,
  );

  const rtIndicator = formatRealtimeIndicator({
    paused,
    channelState: realtimeChannelState,
    eventsReceived: realtimeEventsReceived,
    lastEventBangkok: lastRealtimeEventBangkok,
    refreshSec,
  });

  return (
    <main className="hmi-shell">
      {/* Top Bar: Brand + Live Controls */}
      <div className="hmi-topbar">
        <div className="app-brand">
          <div className="mark">🌾</div>
          <div>
            <div className="name">AgriVision QC</div>
            <div className="sub">Production Quality Control · HMI</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            title={rtIndicator.title}
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: rtIndicator.color,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 999,
              padding: "6px 12px",
            }}
            data-testid="refresh-status-pill"
          >
            {rtIndicator.label}
          </span>

          <button
            type="button"
            className="hmi-btn"
            onClick={() => setPaused((p) => !p)}
            data-testid="pause-toggle-btn"
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>

          <Link href="/batches" className="hmi-btn">
            📁 Batches
          </Link>

          {currentUser?.role === "admin" && (
            <>
              <Link href="/settings" className="hmi-btn">
                ⚙️ Admin
              </Link>
              <Link href="/admin/import" className="hmi-btn">
                ⬆️ Import CSV
              </Link>
            </>
          )}

          {currentUser && (
            <span
              className="status-pill pill-neutral"
              style={{ fontSize: 11.5 }}
              title={`Signed in as ${currentUser.email} (${currentUser.role})`}
            >
              👤 {currentUser.email} ({currentUser.role.toUpperCase()})
            </span>
          )}

          <button
            type="button"
            className="hmi-btn"
            onClick={handleSignOut}
            data-testid="sign-out-btn"
          >
            🚪 Sign out
          </button>
        </div>
      </div>

      {/* Page Title */}
      <h1 className="page-title">{mode.label}</h1>
      <div className="page-subtitle">
        Live inspection status, measured defect analysis, snapshots, history, and QC reporting.
      </div>

      {/* Stale-batch warning if previously selected batch disappeared */}
      {staleBatchWarning && (
        <div className="banner banner-warn" data-testid="stale-batch-warning">
          ⚠ The previously selected batch no longer exists and was disconnected:{" "}
          <code>{staleBatchWarning}</code>
        </div>
      )}

      {errorMsg && (
        <div className="banner banner-danger" role="alert">
          Error communicating with server: {errorMsg}
        </div>
      )}

      {/* Connection Strip */}
      {selectedBatchId && batchDetail ? (
        <div className="status-row">
          <div className="status-strip" data-testid="connection-strip">
            <span className="status-dot" />
            <b>Connected</b>
            <span>·</span>
            <span>
              {batchDetail.batch.freshness} <code>{batchDetail.batch.source_name}</code>
            </span>
            <span>·</span>
            <span>
              Plate: <b>{batchDetail.batch.truck_plate}</b>
            </span>
            <span>·</span>
            <span>📷 {batchDetail.snapshot_count.toLocaleString("en-US")} snapshot(s)</span>
            <span>·</span>
            <span style={{ color: "#64748b" }}>
              {batchDetail.batch.age_label}
              {autoConnected ? " · 🤖 auto-connected" : ""}
            </span>
          </div>
          <button
            type="button"
            className="hmi-btn"
            onClick={() => setShowPickerModal(true)}
            data-testid="change-batch-btn"
          >
            ↩ Change
          </button>
          <button
            type="button"
            className="hmi-btn"
            onClick={handleDisconnectBatch}
            title="Disconnect current batch"
          >
            ✕ Disconnect
          </button>
        </div>
      ) : (
        <div className="status-row">
          <div className="status-strip" data-testid="connection-strip-empty">
            <span style={{ color: "#64748b" }}>●</span>
            <b>No inspection file connected</b>
            <span>·</span>
            <span>Select a batch below to begin.</span>
          </div>
          {pickerDismissed && (
            <button
              type="button"
              className="hmi-btn"
              onClick={handleResetAutoConnect}
              data-testid="reset-autoconnect-btn"
            >
              🤖 Resume auto-connect
            </button>
          )}
        </div>
      )}

      {/* Empty State when no batch is connected */}
      {!selectedBatchId && (
        <div>
          {/* Recently opened quick list (matches legacy lines 1687-1693) */}
          {mruQuickBatches.length > 0 && (
            <section style={{ margin: "14px 0 18px 0" }}>
              <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
                🕐 Recently opened
              </div>
              {mruQuickBatches.map((b) => (
                <BatchRowCard
                  key={`empty-mru-${b.id}`}
                  batch={b}
                  onSelect={handleOpenBatch}
                />
              ))}
              <hr style={{ border: 0, borderTop: "1px solid #e2e8f0", margin: "16px 0" }} />
            </section>
          )}

          <div style={{ margin: "10px 0 14px 0", display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="hmi-btn hmi-btn-primary"
              onClick={() => setShowPickerModal(true)}
              data-testid="browse-batches-btn"
            >
              📁 Browse inspection files
            </button>
            <Link href="/batches" className="hmi-btn">
              📅 Full Batch Archive
            </Link>
          </div>

          <div className="hero" data-testid="empty-hero">
            <div className="hero-empty">
              <div className="emoji">📊</div>
              <h3>Ready for inspection</h3>
              <p>
                Select an inspection batch to monitor measured material quality, defect mix,
                inspection history, snapshots, and QC reports.
              </p>
            </div>
          </div>

          <div className="banner banner-info">
            💡 <b>Make sure <code>shf-core-v2-4.py</code> and <code>edge-sync/sync.py</code> are running</b>{" "}
            and an inspection session has been started (enter Truck Plate + QC name, then press ▶ Start).
            <br />
            Batches will appear here and auto-connect automatically once <code>edge-sync</code> pushes
            data within the last {settings.active_ttl_s}s.
          </div>

          <div className="cards-grid-3">
            <div className="metric-card">
              <div className="metric-label">Step 1</div>
              <div className="metric-value">📁 Select</div>
              <div className="metric-help">Choose an inspection batch.</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Step 2</div>
              <div className="metric-value">🔎 Monitor</div>
              <div className="metric-help">Review measured defects and inspection data.</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Step 3</div>
              <div className="metric-value">📄 Report</div>
              <div className="metric-help">Generate a shareable QC report.</div>
            </div>
          </div>
        </div>
      )}

      {/* WAITING state: batch connected, but no valid rows yet */}
      {selectedBatchId && batchDetail && !activeMetrics && (
        <div>
          <div className="status-strip" data-testid="operation-status-strip" style={{ marginBottom: 12 }}>
            <span className="status-dot" style={{ background: opState.color }} />
            <b>{opState.code}</b>
            <span>·</span>
            <span>{opState.msg}</span>
          </div>
          <button
            type="button"
            className="hmi-btn hmi-btn-primary"
            disabled
            title="Cannot generate a PDF report while the batch has no valid inspection rows"
            data-testid="waiting-pdf-btn"
          >
            📄 Generate PDF report (waiting for inspection rows)
          </button>
        </div>
      )}

      {/* RUNNING state: Full Dashboard Body */}
      {selectedBatchId && batchDetail && activeMetrics && (
        <div>
          {/* 1. Operation Status Strip */}
          <div className="status-strip" data-testid="operation-status-strip" style={{ marginBottom: 18 }}>
            <span className="status-dot" style={{ background: opState.color }} />
            <b>{opState.code}</b>
            <span>·</span>
            <span>{opState.msg}</span>
            <span>·</span>
            <span>Last data: {batchDetail.latest_time_bangkok}</span>
            <span>·</span>
            {activeMetrics.total_plates > 1 ? (
              <span style={{ color: "#16a34a", fontWeight: 700 }} data-testid="plate-badge">
                ✅ Multi-Plate Batch: {activeMetrics.total_plates} Plates
              </span>
            ) : (
              <span style={{ color: "#64748b" }} data-testid="plate-badge">
                Plate 1 (Single Plate)
              </span>
            )}
            {activeMetrics.has_high_variance && (
              <>
                <span>·</span>
                <span style={{ color: "#d97706", fontWeight: 700 }} data-testid="variance-badge">
                  ⚠️ High Plate Variance (Spread: {round1(activeMetrics.defect_spread).toFixed(1)}%)
                </span>
              </>
            )}
            {activeMetrics.is_defect_high && (
              <>
                <span>·</span>
                <span style={{ color: "#dc2626", fontWeight: 700 }} data-testid="alert-badge">
                  ⚠️ Defect rate exceeds threshold
                </span>
              </>
            )}
          </div>

          {/* 2. Current Inspection (4 cards) */}
          <div className="section-title">Current inspection</div>
          <div className="cards-grid-4">
            <DualMetricCard
              label="Good material"
              pctCount={activeMetrics.pct[GOOD_KEY] ?? 0}
              pctWeight={activeMetrics.good_pct_wt}
              helpText={`${activeMetrics.good_weight_g.toFixed(0)} g of ${activeMetrics.total_weight_g.toFixed(0)} g est. · ${activeMetrics.total_plates} plate(s)`}
              testId="card-good-material"
            />
            <DualMetricCard
              label="Total defect"
              pctCount={activeMetrics.total_defect_pct}
              pctWeight={activeMetrics.total_defect_pct_wt}
              helpText={`${activeMetrics.defect_weight_g.toFixed(0)} g of ${activeMetrics.total_weight_g.toFixed(0)} g est. · Immature + Spoiled/Mold + Discolor`}
              alert={activeMetrics.is_defect_high}
              threshold={settings.defect_warn_threshold_pct}
              testId="card-total-defect"
            />
            <div className="metric-card" data-testid="card-sample-count">
              <div>
                <div className="metric-label">Sample count</div>
                <div className="metric-value">
                  {activeMetrics.estimated_seeds.toLocaleString("en-US")}
                </div>
              </div>
              <div className="metric-help">
                Est. seeds ({activeMetrics.total_plates} plate
                {activeMetrics.total_plates > 1 ? "s" : ""})
              </div>
            </div>
            <div className="metric-card" data-testid="card-inspection-time">
              <div>
                <div className="metric-label">Inspection time</div>
                <div className="metric-value" style={{ fontSize: 20 }}>
                  {batchDetail.latest_time_bangkok}
                </div>
              </div>
              <div className="metric-help">
                Plate: {batchDetail.batch.truck_plate} · QC: {batchDetail.batch.qc_name}
              </div>
            </div>
          </div>

          <div
            style={{ color: "#64748b", fontSize: 12, marginTop: 4, marginBottom: 14 }}
            data-testid="weight-calc-caption"
          >
            How weight is calculated: estimated seeds per class × seed weight (good{" "}
            {settings.good_seed_weight_g ?? SEED_WEIGHT_G.good} g, immature{" "}
            {settings.immature_seed_weight_g ?? SEED_WEIGHT_G.immature} g, spoiled/mold{" "}
            {settings.sm_seed_weight_g ?? SEED_WEIGHT_G.sm} g, discolor{" "}
            {settings.dc_seed_weight_g ?? SEED_WEIGHT_G.dc} g). Seed weights are{" "}
            {WEIGHT_VALUES_MEASURED ? "measured" : "ASSUMED, not measured"}; by-weight % is an
            estimate.
          </div>

          {/* Prominent weight_warning banner */}
          {activeMetrics.weight_warning && (
            <div className="banner banner-warn" role="alert" data-testid="weight-warning-banner">
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                ⚠️ Weight Sanity Warning
              </div>
              <div>
                Estimated total weight ({activeMetrics.total_weight_g.toFixed(0)} g) differs from
                the expected sample weight ({settings.total_sample_weight_g.toFixed(0)} g) by more
                than 25%. Check seed count or seed weights.
              </div>
            </div>
          )}

          {/* 3. Defect Analysis (3 count cards + 1 dual total card, matching x-26-10.py) */}
          <div className="section-title">Defect analysis</div>
          <div className="cards-grid-4">
            {mode.classes
              .filter((c) => c.key !== GOOD_KEY)
              .map((cls) => (
                <div
                  key={cls.key}
                  className="metric-card"
                  data-testid={`card-defect-${cls.key}`}
                >
                  <div>
                    <div className="metric-label">{cls.label}</div>
                    <div className="metric-value">
                      {round1(activeMetrics.pct[cls.key] ?? 0).toFixed(1)}%
                    </div>
                  </div>
                  <div className="metric-help">By count</div>
                </div>
              ))}
            <DualMetricCard
              label="Total defect"
              pctCount={activeMetrics.total_defect_pct}
              pctWeight={activeMetrics.total_defect_pct_wt}
              helpText="100% − Good material"
              testId="card-defect-total"
            />
          </div>

          {/* 4. Two Columns: Left = Quality Mix Chart, Right = Inspection Info + Quick PDF */}
          <div className="two-col-layout">
            <div>
              <div className="section-title">Quality mix</div>
              <QualityMixChart classes={mode.classes} pctByClass={activeMetrics.pct} />
            </div>

            <div>
              <div className="section-title">Inspection information</div>
              <div className="hmi-table-wrap" style={{ marginBottom: 14 }}>
                <table className="hmi-table" data-testid="inspection-info-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Source file</td>
                      <td>
                        <code>{batchDetail.batch.source_name}</code>
                      </td>
                    </tr>
                    <tr>
                      <td>Inspection rows</td>
                      <td>{batchDetail.kept_rows_count.toLocaleString("en-US")}</td>
                    </tr>
                    <tr>
                      <td>Snapshots</td>
                      <td>{batchDetail.snapshot_count.toLocaleString("en-US")}</td>
                    </tr>
                    <tr>
                      <td>Truck / Plate</td>
                      <td>{batchDetail.batch.truck_plate}</td>
                    </tr>
                    <tr>
                      <td>QC / Inspector</td>
                      <td>{batchDetail.batch.qc_name}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <button
                type="button"
                className="hmi-btn hmi-btn-primary"
                style={{ width: "100%" }}
                disabled={pdfGenerating || batchDetail.kept_rows_count === 0}
                onClick={handleGeneratePdfReport}
                title="Generate Thai/English QC PDF report and open signed download link"
                data-testid="quick-pdf-btn"
              >
                {pdfGenerating
                  ? "⏳ Generating PDF report…"
                  : "📄 Generate PDF report"}
              </button>

              {pdfError && (
                <div
                  className="banner banner-danger"
                  style={{ marginTop: 10, marginBottom: 0 }}
                  role="alert"
                  data-testid="pdf-error-banner"
                >
                  Failed to generate PDF report: {pdfError}
                </div>
              )}

              {pdfResult && (
                <div
                  className="banner banner-info"
                  style={{ marginTop: 10, marginBottom: 0 }}
                  data-testid="pdf-ready-banner"
                >
                  <div>
                    <b>✅ PDF Report ready:</b> <code>{pdfResult.filename}</code>
                  </div>
                  <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <a
                      href={pdfResult.signed_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hmi-btn hmi-btn-green"
                      data-testid="pdf-download-link"
                    >
                      ⬇️ Download / Open PDF (10 min signed URL)
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 5. Tabs: Details, Snapshots, Report */}
          <div className="hmi-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "details"}
              className={`hmi-tab${activeTab === "details" ? " active" : ""}`}
              onClick={() => setActiveTab("details")}
            >
              📋 Details
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "snapshots"}
              className={`hmi-tab${activeTab === "snapshots" ? " active" : ""}`}
              onClick={() => setActiveTab("snapshots")}
            >
              📷 Snapshots ({batchDetail.snapshot_count})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "report"}
              className={`hmi-tab${activeTab === "report" ? " active" : ""}`}
              onClick={() => setActiveTab("report")}
            >
              📄 Report
            </button>
          </div>

          {/* Tab 1: Details (Per-plate breakdown + Plate tracing) */}
          {activeTab === "details" && (
            <div data-testid="tab-details">
              <div className="section-title">Per-plate breakdown</div>
              <div style={{ color: "#64748b", fontSize: 12, marginBottom: 10 }}>
                Grand average prevents rounding distortion and captures all sample plates.
              </div>

              {activeMetrics.has_high_variance && (
                <div className="banner banner-warn" data-testid="plate-variance-banner">
                  ⚠️ Notice: Defect spread across plates is{" "}
                  <b>{round1(activeMetrics.defect_spread).toFixed(1)}%</b>. Plate variance detected
                  (Min: <b>{round1(activeMetrics.min_defect).toFixed(1)}%</b>, Max:{" "}
                  <b>{round1(activeMetrics.max_defect).toFixed(1)}%</b>).
                </div>
              )}

              <div className="hmi-table-wrap" style={{ marginBottom: 24 }}>
                <table className="hmi-table" data-testid="per-plate-table">
                  <thead>
                    <tr>
                      <th>Plate</th>
                      <th>Seeds</th>
                      {mode.classes.map((c) => (
                        <th key={c.key}>{c.label} %</th>
                      ))}
                      <th>Defect %</th>
                      <th>Good seeds (est.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeMetrics.plates.map((p) => {
                      const defRounded = round1(p.defect_pct);
                      const isMin =
                        activeMetrics.plates.length > 1 &&
                        defRounded === round1(activeMetrics.min_defect);
                      const isMax =
                        activeMetrics.plates.length > 1 &&
                        defRounded === round1(activeMetrics.max_defect) &&
                        round1(activeMetrics.max_defect) > round1(activeMetrics.min_defect);
                      const rowClass = isMax
                        ? "row-max-defect"
                        : isMin
                          ? "row-min-defect"
                          : "";
                      return (
                        <tr
                          key={p.plate}
                          className={rowClass}
                          data-testid={`plate-row-${p.plate}`}
                        >
                          <td>
                            <b>Plate {p.plate}</b>{" "}
                            <span style={{ color: "#64748b", fontSize: 12 }}>
                              (จานที่ {p.plate})
                            </span>
                          </td>
                          <td data-testid={`plate-seeds-${p.plate}`}>
                            {formatSeeds(p.seeds)}
                          </td>
                          {mode.classes.map((c) => (
                            <td key={c.key}>
                              {round1(p.pct[c.key] ?? 0).toFixed(1)}%
                            </td>
                          ))}
                          <td>
                            <b>{defRounded.toFixed(1)}%</b>
                            {isMax && (
                              <span
                                style={{
                                  marginLeft: 6,
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: "#b45309",
                                  background: "#fef3c7",
                                  padding: "1px 6px",
                                  borderRadius: 999,
                                }}
                              >
                                MAX
                              </span>
                            )}
                            {isMin && (
                              <span
                                style={{
                                  marginLeft: 6,
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: "#15803d",
                                  background: "#dcfce7",
                                  padding: "1px 6px",
                                  borderRadius: 999,
                                }}
                              >
                                MIN
                              </span>
                            )}
                          </td>
                          <td>{round1(p.good_seeds_est).toFixed(1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="section-title">Plate tracing</div>
              <div className="hmi-table-wrap">
                <table className="hmi-table" data-testid="plate-tracing-table">
                  <thead>
                    <tr>
                      <th>row_index</th>
                      <th>snapshot_time</th>
                      <th>truck_plate</th>
                      <th>qc_name</th>
                      <th>snapshot_mix_summary</th>
                      <th>plate_number</th>
                      <th>snapshot_total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTracingRows.map((r) => (
                      <tr key={r.row_index}>
                        <td>{r.row_index}</td>
                        <td>{r.snapshot_time}</td>
                        <td>{r.truck_plate}</td>
                        <td>{r.qc_name}</td>
                        <td>
                          <code style={{ fontSize: 12 }}>{r.snapshot_mix_summary}</code>
                        </td>
                        <td>{r.plate_number}</td>
                        <td>{r.snapshot_total.toLocaleString("en-US")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalTracingPages > 1 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 10,
                    fontSize: 12,
                    color: "#64748b",
                  }}
                >
                  <span>
                    Showing rows {(safeTracingPage - 1) * TRACING_PAGE_SIZE}–
                    {Math.min(
                      safeTracingPage * TRACING_PAGE_SIZE - 1,
                      tracingRows.length - 1,
                    )}{" "}
                    of {tracingRows.length.toLocaleString("en-US")} (Page {safeTracingPage} of{" "}
                    {totalTracingPages})
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="hmi-btn"
                      disabled={safeTracingPage <= 1}
                      onClick={() => setTracingPage((p) => Math.max(1, p - 1))}
                    >
                      ⬅️ Previous
                    </button>
                    <button
                      type="button"
                      className="hmi-btn"
                      disabled={safeTracingPage >= totalTracingPages}
                      onClick={() =>
                        setTracingPage((p) => Math.min(totalTracingPages, p + 1))
                      }
                    >
                      Next ➡️
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Snapshots (Phase 5) */}
          {activeTab === "snapshots" && (
            <SnapshotsTab
              batchId={selectedBatchId}
              snapshotCount={batchDetail.snapshot_count}
              refreshSignal={realtimeEventsReceived}
            />
          )}

          {/* Tab 3: Report (Phase 6) */}
          {activeTab === "report" && (
            <div data-testid="tab-report">
              <div className="section-title">QC report</div>
              <div style={{ color: "#64748b", fontSize: 13, marginBottom: 12 }}>
                Generate a Thai/English PDF report containing measured QC data, defect percentages
                (by count and by weight), quality mix chart, per-plate breakdown, and representative
                snapshots. Stored in private Supabase Storage (<code>reports/</code>) with a
                10-minute signed download URL.
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  className="hmi-btn hmi-btn-primary"
                  disabled={pdfGenerating || batchDetail.kept_rows_count === 0}
                  onClick={handleGeneratePdfReport}
                  data-testid="tab-report-pdf-btn"
                >
                  {pdfGenerating
                    ? "⏳ Generating PDF report…"
                    : "📄 Generate PDF report"}
                </button>

                {pdfResult && (
                  <>
                    <a
                      href={pdfResult.signed_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hmi-btn hmi-btn-green"
                      data-testid="tab-report-download-link"
                    >
                      ⬇️ Download / Open {pdfResult.filename}
                    </a>
                    <button
                      type="button"
                      className="hmi-btn"
                      onClick={() => setPdfResult(null)}
                    >
                      🗑️ Clear
                    </button>
                  </>
                )}
              </div>

              {pdfError && (
                <div
                  className="banner banner-danger"
                  style={{ marginTop: 12 }}
                  role="alert"
                  data-testid="tab-report-error"
                >
                  PDF generation failed: {pdfError}
                </div>
              )}

              {pdfResult && (
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                  Stored at <code>{pdfResult.storage_path}</code> · Signed URL valid for 10 minutes.
                </div>
              )}
            </div>
          )}

          {/* 6. Footer Caption */}
          <div
            style={{ color: "#64748b", fontSize: 12, marginTop: 22 }}
            data-testid="dashboard-footer"
          >
            Source: {batchDetail.batch.source_name} · Showing up to{" "}
            {batchDetail.windowed_rows.toLocaleString("en-US")} recent rows · Auto-refresh:{" "}
            {paused ? "paused" : `every ${refreshSec}s`}
          </div>
        </div>
      )}

      {/* Batch Picker Modal Dialog */}
      {showPickerModal && batchesData && (
        <div
          className="hmi-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Select inspection file"
          data-testid="batch-picker-modal"
        >
          <div className="hmi-modal">
            <div className="hmi-modal-header">
              <div style={{ fontSize: 18, fontWeight: 800 }}>Select inspection file</div>
              <button
                type="button"
                className="hmi-btn"
                onClick={handleDismissPicker}
              >
                ✕ Close
              </button>
            </div>
            <div className="hmi-modal-body">
              <BatchPickerContent
                batches={batchesData.batches}
                mruIds={mruIds}
                currentBatchId={selectedBatchId}
                todayBangkok={batchesData.today_bangkok}
                onSelectBatch={handleOpenBatch}
                onCancel={handleDismissPicker}
              />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
