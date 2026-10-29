"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AuthenticatedUser } from "@/lib/auth/session";
import {
  parseAdminImportResponse,
  WEB_IMPORT_CSV_LIMIT_MB,
  WEB_IMPORT_MAX_SNAPSHOTS,
  WEB_IMPORT_SNAPSHOT_LIMIT_MB,
  type AdminImportUiResult,
} from "@/lib/ingest/import-client";

export default function AdminImportPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [snapFiles, setSnapFiles] = useState<FileList | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminImportUiResult | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login?next=/admin/import");
          return null;
        }
        const data = (await res.json()) as {
          user?: AuthenticatedUser;
          message?: string;
        };
        if (!active) return null;
        if (!res.ok || !data.user) {
          setAuthError(data.message ?? "Authentication required.");
          return null;
        }
        if (data.user.role !== "admin") {
          setAuthError("Administrator privileges are required to access /admin/import.");
          return null;
        }
        setUser(data.user);
        return data.user;
      })
      .catch((e) => {
        if (active) setAuthError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!csvFile) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("csv", csvFile);
      if (deviceId.trim()) fd.append("device_id", deviceId.trim());
      if (snapFiles) {
        Array.from(snapFiles).forEach((f) => fd.append("snapshots", f));
      }
      const headers: Record<string, string> = {};
      if (adminToken.trim()) headers["x-admin-token"] = adminToken.trim();
      const res = await fetch("/api/admin/import", { method: "POST", body: fd, headers });
      setResult(await parseAdminImportResponse(res));
    } catch (err) {
      setResult({ error: "network_error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  if (authError) {
    return (
      <main className="hmi-shell">
        <div className="banner banner-danger">🔒 {authError}</div>
        <div style={{ marginTop: 12 }}>
          <Link href="/" className="hmi-btn">
            ⬅️ Return to Dashboard
          </Link>
        </div>
      </main>
    );
  }

  const r = result?.ingest;
  const w = r?.weight;
  const nonWeightWarnings = (r?.warnings ?? []).filter((msg) => msg !== w?.message);

  return (
    <main style={{ maxWidth: 860, margin: "32px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ background: "#ecfccb", border: "1px solid #d9f99d", borderRadius: 12, padding: "8px 12px", fontSize: 22 }}>🌾</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 20 }}>AgriVision QC · Admin CSV Importer</div>
            <div style={{ color: "#64748b", fontSize: 13 }}>Backfill legacy inspection CSVs and snapshot images (idempotent upsert)</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {user && (
            <span className="status-pill pill-good" style={{ fontSize: 12 }}>
              👤 {user.email} (ADMIN)
            </span>
          )}
          <Link href="/settings" className="hmi-btn">
            ⚙️ Settings
          </Link>
          <Link href="/" className="hmi-btn">
            ⬅️ Dashboard
          </Link>
        </div>
      </div>

      <div
        style={{
          marginBottom: 14,
          padding: "10px 14px",
          borderRadius: 12,
          border: "1px solid #cbd5e1",
          background: "#f8fafc",
          fontSize: 13,
          color: "#334155",
        }}
      >
        <strong>Upload limits:</strong> CSV &le; {WEB_IMPORT_CSV_LIMIT_MB} MB, up to {WEB_IMPORT_MAX_SNAPSHOTS} snapshot
        images per request (&le; {WEB_IMPORT_SNAPSHOT_LIMIT_MB} MB per image). For bulk snapshot folder imports, use the
        CLI importer: <code>pnpm import-csv &lt;file.csv&gt; --device &lt;name&gt;</code>.
      </div>

      <form
        onSubmit={onSubmit}
        style={{ border: "1px solid #e2e8f0", borderRadius: 15, padding: 20, background: "#ffffff", display: "grid", gap: 14 }}
      >
        <label style={{ display: "grid", gap: 4, fontSize: 14, fontWeight: 600 }}>
          Inspection CSV file (grain_*_rolling10s*.csv, &le; {WEB_IMPORT_CSV_LIMIT_MB} MB)
          <input type="file" accept=".csv,text/csv" required onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)} />
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 14, fontWeight: 600 }}>
          Snapshot images (optional, &le; {WEB_IMPORT_MAX_SNAPSHOTS} files, &le; {WEB_IMPORT_SNAPSHOT_LIMIT_MB} MB each; use CLI for bulk snapshots)
          <input type="file" accept=".jpg,.jpeg,.png,.bmp,.webp" multiple onChange={(e) => setSnapFiles(e.target.files)} />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 13, color: "#334155" }}>
            Device UUID (optional, must exist in devices)
            <input
              type="text"
              placeholder="leave blank for manual import"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 8 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 13, color: "#334155" }}>
            API Token (optional when signed in as Admin)
            <input
              type="password"
              placeholder="Uses Admin session by default (or enter ADMIN_IMPORT_TOKEN)"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 8 }}
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={busy || !csvFile}
          style={{
            padding: "10px 16px",
            borderRadius: 10,
            border: "none",
            background: busy ? "#94a3b8" : "#16a34a",
            color: "#fff",
            fontWeight: 700,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Importing…" : "Import CSV"}
        </button>
      </form>

      {result?.error && (
        <div
          role="alert"
          style={{ marginTop: 18, padding: 16, borderRadius: 14, border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b" }}
        >
          <strong>Import failed ({result.error}):</strong> {result.message ?? "check server logs"}
        </div>
      )}

      {r && (
        <section style={{ marginTop: 18, display: "grid", gap: 14 }}>
          {w?.weight_warning && (
            <div
              role="alert"
              style={{
                padding: 16,
                borderRadius: 14,
                border: "2px solid #dc2626",
                background: "#fef2f2",
                color: "#7f1d1d",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
                ⚠️ Weight Warning — Weight-Based Defect Alert INACTIVE
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.5 }}>{w.message}</div>
              <div style={{ fontSize: 12, marginTop: 6, color: "#991b1b" }}>
                Estimated seeds: <strong>{w.estimated_seeds.toLocaleString("en-US")}</strong> · Estimated good weight:{" "}
                <strong>{w.good_weight_g.toFixed(1)} g</strong> · Sample weight:{" "}
                <strong>{w.total_sample_weight_g} g</strong> (max plausible ~{w.max_plausible_seeds.toLocaleString("en-US")} seeds)
              </div>
            </div>
          )}

          {nonWeightWarnings.map((warnMsg, idx) => (
            <div
              key={idx}
              role="alert"
              style={{
                padding: 16,
                borderRadius: 14,
                border: "1px solid #f59e0b",
                background: "#fffbeb",
                color: "#78350f",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>⚠️ Import Warning</div>
              <div style={{ fontSize: 13 }}>{warnMsg}</div>
            </div>
          ))}

          {r.skipped > 0 && (
            <div
              role="status"
              style={{
                padding: 16,
                borderRadius: 14,
                border: "1px solid #f59e0b",
                background: "#fffbeb",
                color: "#78350f",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
                ⚠️ Skipped {r.skipped} unreadable row(s)
              </div>
              <div style={{ fontSize: 13 }}>
                Reasons:{" "}
                {Object.entries(r.skip_reasons)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")}
              </div>
              {r.skipped_samples.length > 0 && (
                <div style={{ fontSize: 12, marginTop: 6, fontFamily: "monospace" }}>
                  First skipped records: {r.skipped_samples.map((s) => `#${s.record} (${s.reason})`).join(", ")}
                </div>
              )}
            </div>
          )}

          <div style={{ padding: 16, borderRadius: 14, border: "1px solid #e2e8f0", background: "#f8fafc" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Import Report · {r.source_name}</div>
            <div style={{ fontSize: 14, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              <div>
                <div style={{ color: "#64748b", fontSize: 12 }}>RECEIVED</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{r.received}</div>
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: 12 }}>ACCEPTED</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#16a34a" }}>{r.accepted}</div>
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: 12 }}>SKIPPED</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: r.skipped ? "#d97706" : "#0f172a" }}>{r.skipped}</div>
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: 12 }}>DUPLICATES</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{r.duplicates_in_request}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 10 }}>
              Batch ID: <code>{r.batch_id ?? "none (no valid rows)"}</code>
              {result?.snapshots && (
                <>
                  {" "}
                  · Snapshots: stored {result.snapshots.stored}/{result.snapshots.found} (rejected {result.snapshots.rejected})
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
