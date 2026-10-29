"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import type { BatchSummaryItem } from "@/lib/dashboard/queries";

export const MRU_STORAGE_KEY = "agrivision_mru_batches_v1";
export const MAX_MRU_BATCHES = 8;
const ARCHIVE_PAGE_SIZE = 15;

export function readMruBatchIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MRU_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_MRU_BATCHES) : [];
  } catch {
    return [];
  }
}

export function recordMruBatchId(batchId: string): string[] {
  if (typeof window === "undefined") return [batchId];
  const current = readMruBatchIds().filter((id) => id !== batchId);
  const next = [batchId, ...current].slice(0, MAX_MRU_BATCHES);
  try {
    window.localStorage.setItem(MRU_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}

export function BatchRowCard({
  batch,
  onSelect,
  isCurrent = false,
}: {
  batch: BatchSummaryItem;
  onSelect: (id: string) => void;
  isCurrent?: boolean;
}) {
  return (
    <div className="batch-row" data-testid={`batch-row-${batch.id}`}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 14 }}>
          <span title={`Age: ${batch.age_label}`}>{batch.freshness}</span>
          <strong style={{ color: "#0f172a" }}>{batch.truck_plate || "—"}</strong>
          <span style={{ color: "#94a3b8" }}>·</span>
          <code
            style={{
              background: "#f1f5f9",
              padding: "2px 6px",
              borderRadius: 6,
              fontSize: 12,
              color: "#334155",
              wordBreak: "break-all",
            }}
          >
            {batch.source_name}
          </code>
          {isCurrent && (
            <span
              style={{
                background: "#dcfce7",
                color: "#166534",
                fontSize: 11,
                fontWeight: 700,
                padding: "1px 8px",
                borderRadius: 999,
              }}
            >
              Connected
            </span>
          )}
        </div>
        <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
          QC: {batch.qc_name || "—"} &nbsp;·&nbsp; {batch.row_count.toLocaleString("en-US")} rows &nbsp;·&nbsp;{" "}
          {batch.age_label}
        </div>
      </div>
      <div>
        <button
          type="button"
          className="hmi-btn hmi-btn-primary"
          onClick={() => onSelect(batch.id)}
        >
          Open
        </button>
      </div>
    </div>
  );
}

export function BatchPickerContent({
  batches,
  mruIds,
  currentBatchId,
  todayBangkok,
  onSelectBatch,
  onCancel,
}: {
  batches: readonly BatchSummaryItem[];
  mruIds: readonly string[];
  currentBatchId?: string | null;
  todayBangkok: string;
  onSelectBatch: (batchId: string) => void;
  onCancel?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState<string>("ALL");
  const [archivePage, setArchivePage] = useState(1);

  const byId = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);

  const mruBatches = useMemo(
    () => mruIds.map((id) => byId.get(id)).filter((b): b is BatchSummaryItem => Boolean(b)),
    [mruIds, byId],
  );

  const todayBatches = useMemo(
    () => batches.filter((b) => b.is_today),
    [batches],
  );

  const recentFallback = useMemo(
    () => batches.slice(0, 10),
    [batches],
  );

  // Group all batches by Bangkok date (newest date first)
  const dateGroups = useMemo(() => {
    const map = new Map<string, BatchSummaryItem[]>();
    for (const b of batches) {
      const list = map.get(b.bangkok_date);
      if (list) list.push(b);
      else map.set(b.bangkok_date, [b]);
    }
    return [...map.keys()].sort((a, b) => b.localeCompare(a)).map((date) => ({
      date,
      items: map.get(date)!,
    }));
  }, [batches]);

  const filteredArchive = useMemo(() => {
    const q = search.trim().toLowerCase();
    return batches.filter((b) => {
      if (selectedDate !== "ALL" && b.bangkok_date !== selectedDate) return false;
      if (!q) return true;
      return (
        b.truck_plate.toLowerCase().includes(q) ||
        b.qc_name.toLowerCase().includes(q) ||
        b.source_name.toLowerCase().includes(q)
      );
    });
  }, [batches, search, selectedDate]);

  const totalArchivePages = Math.max(1, Math.ceil(filteredArchive.length / ARCHIVE_PAGE_SIZE));
  const safePage = Math.min(archivePage, totalArchivePages);
  const pageItems = filteredArchive.slice(
    (safePage - 1) * ARCHIVE_PAGE_SIZE,
    safePage * ARCHIVE_PAGE_SIZE,
  );

  return (
    <div>
      {/* Layer 0: Recently opened (up to 8 from localStorage) */}
      {mruBatches.length > 0 && (
        <section style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
            🕐 Recently opened ({mruBatches.length})
          </div>
          {mruBatches.map((b) => (
            <BatchRowCard
              key={`mru-${b.id}`}
              batch={b}
              isCurrent={b.id === currentBatchId}
              onSelect={onSelectBatch}
            />
          ))}
        </section>
      )}

      {/* Layer 1: Today's batches (Asia/Bangkok day) or 10 most recent */}
      <section style={{ marginBottom: 20 }}>
        {todayBatches.length > 0 ? (
          <>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
              Today&apos;s batches ({todayBangkok}) · {todayBatches.length} batch(es)
            </div>
            {todayBatches.map((b) => (
              <BatchRowCard
                key={`today-${b.id}`}
                batch={b}
                isCurrent={b.id === currentBatchId}
                onSelect={onSelectBatch}
              />
            ))}
          </>
        ) : recentFallback.length > 0 ? (
          <>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>
              Recent batches · {recentFallback.length} batch(es)
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginBottom: 8 }}>
              No files recorded today ({todayBangkok}). Showing the most recent inspections:
            </div>
            {recentFallback.map((b) => (
              <BatchRowCard
                key={`recent-${b.id}`}
                batch={b}
                isCurrent={b.id === currentBatchId}
                onSelect={onSelectBatch}
              />
            ))}
          </>
        ) : (
          <div className="banner banner-info">
            No inspection batches found in Supabase yet. Start <code>edge-sync/sync.py</code> on the device or use{" "}
            <Link href="/admin/import" style={{ fontWeight: 700, color: "#1d4ed8" }}>
              Admin CSV Import
            </Link>{" "}
            to backfill historical CSVs.
          </div>
        )}
      </section>

      <hr style={{ border: 0, borderTop: "1px solid #e2e8f0", margin: "18px 0" }} />

      {/* Layer 2: Archive grouped by date + search by truck plate or QC */}
      <section style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>
          📅 Archive by date &amp; search ({filteredArchive.length} matching)
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 220px",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setArchivePage(1);
            }}
            placeholder="Search by truck plate, QC inspector, or CSV filename…"
            style={{
              padding: "9px 12px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              fontSize: 13,
              width: "100%",
            }}
          />
          <select
            value={selectedDate}
            onChange={(e) => {
              setSelectedDate(e.target.value);
              setArchivePage(1);
            }}
            aria-label="Filter archive by Bangkok date"
            style={{
              padding: "9px 12px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              fontSize: 13,
              background: "#fff",
            }}
          >
            <option value="ALL">All dates ({dateGroups.length} day(s))</option>
            {dateGroups.map((g) => (
              <option key={g.date} value={g.date}>
                {g.date} ({g.items.length})
              </option>
            ))}
          </select>
        </div>

        {pageItems.length > 0 ? (
          <>
            {pageItems.map((b) => (
              <BatchRowCard
                key={`arch-${b.id}`}
                batch={b}
                isCurrent={b.id === currentBatchId}
                onSelect={onSelectBatch}
              />
            ))}
            {totalArchivePages > 1 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 12,
                  fontSize: 13,
                  color: "#64748b",
                }}
              >
                <span>
                  Page <b>{safePage}</b> of <b>{totalArchivePages}</b> ({filteredArchive.length} batch(es), 15 per page)
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="hmi-btn"
                    disabled={safePage <= 1}
                    onClick={() => setArchivePage((p) => Math.max(1, p - 1))}
                  >
                    ⬅️ Previous
                  </button>
                  <button
                    type="button"
                    className="hmi-btn"
                    disabled={safePage >= totalArchivePages}
                    onClick={() => setArchivePage((p) => Math.min(totalArchivePages, p + 1))}
                  >
                    Next ➡️
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: "#64748b", fontSize: 13, padding: "12px 0" }}>
            No batches match your filter.
          </div>
        )}
      </section>

      {/* Footer actions: Admin import shortcut + Cancel */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 12,
          borderTop: "1px solid #e2e8f0",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Link href="/admin/import" className="hmi-btn">
          ⬆️ Backfill / Import CSV (Admin)
        </Link>
        {onCancel && (
          <button type="button" className="hmi-btn" onClick={onCancel}>
            ✕ Cancel
          </button>
        )}
      </div>
    </div>
  );
}
