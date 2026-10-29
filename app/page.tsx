import React, { Suspense } from "react";
import { DashboardClient } from "@/components/dashboard/dashboard-client";

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <main className="hmi-shell">
          <div className="app-brand">
            <div className="mark">🌾</div>
            <div>
              <div className="name">AgriVision QC</div>
              <div className="sub">Production Quality Control · HMI</div>
            </div>
          </div>
          <div className="page-title">Grain Analysis</div>
          <div className="page-subtitle">Loading dashboard…</div>
        </main>
      }
    >
      <DashboardClient />
    </Suspense>
  );
}
