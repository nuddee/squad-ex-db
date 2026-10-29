"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  SNAPSHOTS_PER_PAGE,
  type BatchSnapshotsResponse,
  type SnapshotGalleryItem,
} from "@/lib/dashboard/queries";

export interface SnapshotsTabProps {
  batchId: string;
  snapshotCount: number;
  /** Incrementing signal when Realtime or periodic poll detects new data. */
  refreshSignal?: number;
}

export function formatSnapshotRowMatchLine(item: SnapshotGalleryItem): string {
  if (!item.row_match) {
    return "⚠️ No matching row";
  }
  const m = item.row_match;
  const plateStr = `Plate ${m.plate_number} · `;
  if (m.approximate) {
    return `⚠️ Row match (other plate · approximate): ${plateStr}${m.truck_plate || "—"} · QC: ${m.qc_name || "—"} (${m.snapshot_time_bangkok})`;
  }
  return `🔗 Row match: ${plateStr}${m.truck_plate || "—"} · QC: ${m.qc_name || "—"} (${m.snapshot_time_bangkok})`;
}

export function SnapshotsTab({
  batchId,
  snapshotCount,
  refreshSignal = 0,
}: SnapshotsTabProps) {
  const [page, setPage] = useState<number>(1);
  const [plateFilter, setPlateFilter] = useState<string>("all");
  const [data, setData] = useState<BatchSnapshotsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Selected index (0-based within the filtered list) for the "View larger" dialog
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // Pending global index when Previous/Next crosses a page boundary
  const [pendingSelectIndex, setPendingSelectIndex] = useState<number | null>(null);

  // Reset pagination/filter when switching batches
  useEffect(() => {
    setPage(1);
    setPlateFilter("all");
    setSelectedIndex(null);
    setPendingSelectIndex(null);
  }, [batchId]);

  const fetchSnapshotsPage = useCallback(
    async (targetPage: number, targetPlate: string) => {
      try {
        setLoading(true);
        const qs = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(SNAPSHOTS_PER_PAGE),
        });
        if (targetPlate !== "all") {
          qs.set("plate", targetPlate);
        }
        const res = await fetch(
          `/api/batches/${encodeURIComponent(batchId)}/snapshots?${qs.toString()}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = (await res.json()) as BatchSnapshotsResponse;
        setData(payload);
        setError(null);
        return payload;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [batchId],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      const payload = await fetchSnapshotsPage(page, plateFilter);
      if (!mounted || !payload) return;
      if (pendingSelectIndex !== null) {
        setSelectedIndex(pendingSelectIndex);
        setPendingSelectIndex(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [page, plateFilter, refreshSignal, snapshotCount, fetchSnapshotsPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalFiltered = data?.total_filtered ?? 0;
  const totalPages = data?.total_pages ?? 1;
  const safePage = data?.page ?? page;
  const items = data?.items ?? [];

  const selectedItem =
    selectedIndex !== null
      ? items.find((it) => it.index === selectedIndex) ?? null
      : null;

  const navigateLightbox = useCallback(
    (nextGlobalIndex: number) => {
      if (!data || nextGlobalIndex < 0 || nextGlobalIndex >= data.total_filtered) {
        return;
      }
      const targetPage = Math.floor(nextGlobalIndex / SNAPSHOTS_PER_PAGE) + 1;
      if (targetPage !== safePage) {
        setPendingSelectIndex(nextGlobalIndex);
        setPage(targetPage);
      } else {
        setSelectedIndex(nextGlobalIndex);
      }
    },
    [data, safePage],
  );

  // Keyboard navigation in "View larger" dialog: Escape to close, ArrowLeft / ArrowRight for Previous / Next
  useEffect(() => {
    if (selectedIndex === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedIndex(null);
        setPendingSelectIndex(null);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (selectedIndex > 0) {
          navigateLightbox(selectedIndex - 1);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (data && selectedIndex < data.total_filtered - 1) {
          navigateLightbox(selectedIndex + 1);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIndex, data, navigateLightbox]);

  const handlePlateChange = (nextPlate: string) => {
    setPlateFilter(nextPlate);
    setPage(1);
    setSelectedIndex(null);
    setPendingSelectIndex(null);
  };

  if (error) {
    return (
      <div className="banner banner-danger" role="alert" data-testid="snapshots-error">
        Failed to load snapshot gallery: {error}
      </div>
    );
  }

  if (!loading && data && data.total_snapshots === 0) {
    return (
      <div className="banner banner-info" data-testid="tab-snapshots-empty">
        No snapshot images found for this batch yet. Images will appear here automatically when{" "}
        <code>edge-sync</code> or the CSV importer uploads snapshots.
      </div>
    );
  }

  return (
    <div data-testid="tab-snapshots">
      <div className="section-title">Snapshot gallery</div>

      {/* Filter bar + Pagination controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label
            htmlFor="snapshot-plate-filter"
            style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}
          >
            Filter by Plate
          </label>
          <select
            id="snapshot-plate-filter"
            data-testid="snapshot-plate-filter"
            value={plateFilter}
            onChange={(e) => handlePlateChange(e.target.value)}
            style={{
              height: 38,
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              padding: "0 12px",
              fontSize: 13,
              fontWeight: 700,
              background: "#fff",
              color: "#0f172a",
            }}
          >
            <option value="all">All Plates</option>
            {(data?.available_plates ?? []).map((p) => (
              <option key={p} value={String(p)}>
                Plate {p}
              </option>
            ))}
          </select>

          {data && (
            <span
              style={{ fontSize: 12, color: "#64748b" }}
              data-testid="snapshot-gallery-caption"
            >
              {totalFiltered.toLocaleString("en-US")} snapshot(s) · Matched:{" "}
              <b>{data.matched_count.toLocaleString("en-US")}</b> /{" "}
              {totalFiltered.toLocaleString("en-US")} · Filename TZ:{" "}
              <code>{data.snapshot_filename_tz}</code> · Click &ldquo;View larger&rdquo; to preview.
            </span>
          )}
        </div>

        {totalPages > 1 && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 8 }}
            data-testid="snapshot-pagination"
          >
            <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>
              Page {safePage} of {totalPages}
            </span>
            <button
              type="button"
              className="hmi-btn"
              disabled={safePage <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="snapshot-page-prev"
            >
              ⬅️ Previous
            </button>
            <button
              type="button"
              className="hmi-btn"
              disabled={safePage >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              data-testid="snapshot-page-next"
            >
              Next ➡️
            </button>
          </div>
        )}
      </div>

      {/* 4-column Gallery Grid (16 per page, newest first) */}
      <div className="snapshot-gallery-grid" data-testid="snapshot-gallery-grid">
        {items.map((item) => {
          const plateBadge =
            item.plate_number !== null ? `🏷️ Plate ${item.plate_number} · ` : "";
          const headerText = `${plateBadge}${item.captured_bangkok}`;
          const rowMatchText = formatSnapshotRowMatchLine(item);

          return (
            <div
              key={item.id}
              className="snapshot-card"
              data-testid={`snapshot-card-${item.index}`}
            >
              <div>
                <div className="snapshot-thumb-wrap">
                  {item.thumb_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.thumb_url}
                      alt={item.filename}
                      className="snapshot-thumb-img"
                      loading="lazy"
                      onError={(e) => {
                        // Fall back to full_url if thumbnail fails to load in browser
                        const imgEl = e.currentTarget;
                        if (item.full_url && imgEl.src !== item.full_url) {
                          imgEl.src = item.full_url;
                        }
                      }}
                    />
                  ) : (
                    <div style={{ color: "#94a3b8", fontSize: 12 }}>
                      Image preview unavailable
                    </div>
                  )}
                </div>

                <div className="snapshot-card-body">
                  <button
                    type="button"
                    className="hmi-btn"
                    style={{ width: "100%" }}
                    onClick={() => setSelectedIndex(item.index)}
                    data-testid={`snapshot-view-larger-${item.index}`}
                  >
                    🔍 View larger
                  </button>

                  <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                    {headerText}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#64748b",
                      wordBreak: "break-all",
                      fontFamily: "monospace",
                    }}
                  >
                    {item.filename}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color:
                        item.row_match && !item.row_match.approximate
                          ? "#15803d"
                          : "#b45309",
                      fontWeight: 600,
                    }}
                    data-testid={`snapshot-row-match-${item.index}`}
                  >
                    {rowMatchText}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* "View larger" Modal Dialog (Esc to close, ArrowLeft / ArrowRight for Previous / Next) */}
      {selectedIndex !== null && (
        <div
          className="hmi-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Selected snapshot preview"
          data-testid="snapshot-lightbox-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedIndex(null);
              setPendingSelectIndex(null);
            }
          }}
        >
          <div className="hmi-modal" style={{ maxWidth: 1120 }}>
            <div className="hmi-modal-header">
              <div style={{ fontSize: 17, fontWeight: 800 }}>
                🔍 Selected snapshot preview
              </div>
              <button
                type="button"
                className="hmi-btn"
                onClick={() => {
                  setSelectedIndex(null);
                  setPendingSelectIndex(null);
                }}
                data-testid="snapshot-lightbox-close"
              >
                ✕ Close preview (Esc)
              </button>
            </div>

            <div className="hmi-modal-body">
              {selectedItem ? (
                <div className="snapshot-lightbox-layout">
                  <div
                    style={{
                      background: "#0f172a",
                      borderRadius: 12,
                      overflow: "hidden",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minHeight: 360,
                    }}
                  >
                    {selectedItem.full_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={selectedItem.full_url}
                        alt={selectedItem.filename}
                        style={{
                          maxWidth: "100%",
                          maxHeight: "70vh",
                          objectFit: "contain",
                          display: "block",
                        }}
                        data-testid="snapshot-lightbox-img"
                      />
                    ) : (
                      <div style={{ color: "#94a3b8", padding: 24 }}>
                        Full image URL unavailable
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div className="metric-card" style={{ minHeight: "auto" }}>
                      <div className="metric-label">Snapshot</div>
                      <div
                        className="metric-value"
                        data-testid="snapshot-lightbox-counter"
                      >
                        {selectedIndex + 1} / {totalFiltered}
                      </div>
                      <div className="metric-help">
                        Use ⬅️ / ➡️ keyboard arrows or buttons below
                      </div>
                    </div>

                    <button
                      type="button"
                      className="hmi-btn"
                      disabled={selectedIndex <= 0 || loading}
                      onClick={() => navigateLightbox(selectedIndex - 1)}
                      data-testid="snapshot-lightbox-prev"
                    >
                      ⬅️ Previous
                    </button>

                    <button
                      type="button"
                      className="hmi-btn"
                      disabled={selectedIndex >= totalFiltered - 1 || loading}
                      onClick={() => navigateLightbox(selectedIndex + 1)}
                      data-testid="snapshot-lightbox-next"
                    >
                      Next ➡️
                    </button>

                    <button
                      type="button"
                      className="hmi-btn"
                      onClick={() => {
                        setSelectedIndex(null);
                        setPendingSelectIndex(null);
                      }}
                    >
                      ✕ Close preview
                    </button>

                    <div
                      style={{
                        borderTop: "1px solid #e2e8f0",
                        paddingTop: 10,
                        fontSize: 12,
                        lineHeight: 1.55,
                        color: "#334155",
                      }}
                    >
                      <div>
                        <b>Captured (Bangkok):</b> {selectedItem.captured_bangkok}
                      </div>
                      {selectedItem.plate_number !== null && (
                        <div>
                          <b>Plate:</b> Plate {selectedItem.plate_number}
                        </div>
                      )}
                      <div style={{ wordBreak: "break-all" }}>
                        <b>File:</b> <code>{selectedItem.filename}</code>
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          color:
                            selectedItem.row_match && !selectedItem.row_match.approximate
                              ? "#15803d"
                              : "#b45309",
                          fontWeight: 700,
                        }}
                        data-testid="snapshot-lightbox-row-match"
                      >
                        {formatSnapshotRowMatchLine(selectedItem)}
                      </div>
                      {selectedItem.row_match?.mix_raw && (
                        <div style={{ marginTop: 4 }}>
                          <b>Row mix:</b>{" "}
                          <code style={{ fontSize: 11 }}>
                            {selectedItem.row_match.mix_raw}
                          </code>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: 24, color: "#64748b" }}>
                  Loading snapshot preview…
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
