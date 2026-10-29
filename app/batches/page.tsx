"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BatchPickerContent,
  readMruBatchIds,
  recordMruBatchId,
} from "@/components/dashboard/batch-picker";
import type { ListBatchesResponse } from "@/lib/dashboard/queries";

export default function BatchesPage() {
  const router = useRouter();
  const [data, setData] = useState<ListBatchesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mruIds, setMruIds] = useState<string[]>([]);

  useEffect(() => {
    setMruIds(readMruBatchIds());
    let active = true;
    fetch("/api/batches", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login?next=/batches");
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ListBatchesResponse;
      })
      .then((payload) => {
        if (active && payload) setData(payload);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [router]);

  const handleSelectBatch = (batchId: string) => {
    recordMruBatchId(batchId);
    router.push(`/?batch=${encodeURIComponent(batchId)}`);
  };

  return (
    <main className="hmi-shell">
      <div className="hmi-topbar">
        <Link href="/" className="app-brand">
          <div className="mark">🌾</div>
          <div>
            <div className="name">AgriVision QC</div>
            <div className="sub">Production Quality Control · HMI</div>
          </div>
        </Link>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/" className="hmi-btn">
            ⬅️ Back to Dashboard
          </Link>
          <Link href="/admin/import" className="hmi-btn">
            ⬆️ Admin Import
          </Link>
        </div>
      </div>

      <h1 className="page-title">Select inspection batch</h1>
      <div className="page-subtitle">
        Browse today&apos;s inspections, recently opened batches, or search the historical archive by date, truck plate, or QC inspector.
      </div>

      {error && (
        <div className="banner banner-danger">
          Could not load batches: {error}
        </div>
      )}

      {!data && !error && (
        <div className="metric-card" style={{ alignItems: "center", justifyContent: "center" }}>
          Loading inspection batches…
        </div>
      )}

      {data && (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 16,
            background: "#fff",
            padding: 20,
          }}
        >
          <BatchPickerContent
            batches={data.batches}
            mruIds={mruIds}
            todayBangkok={data.today_bangkok}
            onSelectBatch={handleSelectBatch}
            onCancel={() => router.push("/?dismissed=1")}
          />
        </div>
      )}
    </main>
  );
}
