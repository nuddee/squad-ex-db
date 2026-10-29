"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DeviceAdminItem } from "@/lib/admin/devices";
import {
  EDITABLE_SETTINGS_SPEC,
  type EditableSettingKey,
  type SettingsAuditItem,
} from "@/lib/admin/settings";
import type { AdminUserItem } from "@/app/api/admin/users/route";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/qc/config";
import { formatBangkokTimestamp } from "@/lib/qc/time";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser";

type AdminTab = "settings" | "devices" | "users";

export default function AdminSettingsPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
  const [activeTab, setActiveTab] = useState<AdminTab>("settings");
  const [authError, setAuthError] = useState<string | null>(null);

  // Settings tab state
  const [formValues, setFormValues] = useState<Record<EditableSettingKey, string>>({
    good_seed_weight_g: String(DEFAULT_SETTINGS.good_seed_weight_g),
    immature_seed_weight_g: String(DEFAULT_SETTINGS.immature_seed_weight_g),
    sm_seed_weight_g: String(DEFAULT_SETTINGS.sm_seed_weight_g),
    dc_seed_weight_g: String(DEFAULT_SETTINGS.dc_seed_weight_g),
    defect_warn_threshold_pct: String(DEFAULT_SETTINGS.defect_warn_threshold_pct),
    plate_variance_spread_pct: String(DEFAULT_SETTINGS.plate_variance_spread_pct),
    metrics_window_rows: String(DEFAULT_SETTINGS.metrics_window_rows),
    expected_plates: String(DEFAULT_SETTINGS.expected_plates),
    active_ttl_s: String(DEFAULT_SETTINGS.active_ttl_s),
    refresh_sec: String(DEFAULT_SETTINGS.refresh_sec),
    snapshot_filename_tz: DEFAULT_SETTINGS.snapshot_filename_tz,
    report_footer_left: DEFAULT_SETTINGS.report_footer_left,
    report_form_code: DEFAULT_SETTINGS.report_form_code,
  });
  const [auditLog, setAuditLog] = useState<SettingsAuditItem[]>([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);

  // Devices tab state
  const [devices, setDevices] = useState<DeviceAdminItem[]>([]);
  const [newDeviceName, setNewDeviceName] = useState("");
  const [createdKeyOnce, setCreatedKeyOnce] = useState<{
    name: string;
    apiKey: string;
  } | null>(null);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [devicesErr, setDevicesErr] = useState<string | null>(null);

  // Users tab state
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<"viewer" | "admin">("viewer");
  const [newUserMode, setNewUserMode] = useState<"create" | "invite">("create");
  const [usersBusy, setUsersBusy] = useState(false);
  const [usersMsg, setUsersMsg] = useState<string | null>(null);
  const [usersErr, setUsersErr] = useState<string | null>(null);

  const applySettingsToForm = useCallback((s: Settings) => {
    setFormValues({
      good_seed_weight_g: String(s.good_seed_weight_g),
      immature_seed_weight_g: String(s.immature_seed_weight_g),
      sm_seed_weight_g: String(s.sm_seed_weight_g),
      dc_seed_weight_g: String(s.dc_seed_weight_g),
      defect_warn_threshold_pct: String(s.defect_warn_threshold_pct),
      plate_variance_spread_pct: String(s.plate_variance_spread_pct),
      metrics_window_rows: String(s.metrics_window_rows),
      expected_plates: String(s.expected_plates),
      active_ttl_s: String(s.active_ttl_s),
      refresh_sec: String(s.refresh_sec),
      snapshot_filename_tz: s.snapshot_filename_tz,
      report_footer_left: s.report_footer_left,
      report_form_code: s.report_form_code,
    });
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsErr(null);
    const res = await fetch("/api/admin/settings", { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/login?next=/settings");
      return;
    }
    if (res.status === 403) {
      setAuthError("Administrator privileges are required to view /settings.");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setSettingsErr(body?.message ?? `Failed to load settings (HTTP ${res.status})`);
      return;
    }
    const data = (await res.json()) as {
      settings: Settings;
      audit_log: SettingsAuditItem[];
    };
    applySettingsToForm(data.settings);
    setAuditLog(data.audit_log ?? []);
  }, [applySettingsToForm, router]);

  const loadDevices = useCallback(async () => {
    setDevicesErr(null);
    const res = await fetch("/api/admin/devices", { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setDevicesErr(body?.message ?? `Failed to load devices (HTTP ${res.status})`);
      return;
    }
    const data = (await res.json()) as { devices: DeviceAdminItem[] };
    setDevices(data.devices ?? []);
  }, []);

  const loadUsers = useCallback(async () => {
    setUsersErr(null);
    const res = await fetch("/api/admin/users", { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setUsersErr(body?.message ?? `Failed to load users (HTTP ${res.status})`);
      return;
    }
    const data = (await res.json()) as { users: AdminUserItem[] };
    setUsers(data.users ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me", { cache: "no-store" });
        if (meRes.status === 401) {
          router.replace("/login?next=/settings");
          return;
        }
        const meData = (await meRes.json()) as { user?: AuthenticatedUser; message?: string };
        if (!active) return;
        if (!meRes.ok || !meData.user) {
          setAuthError(meData.message ?? "Authentication required.");
          return;
        }
        setCurrentUser(meData.user);
        if (meData.user.role !== "admin") {
          setAuthError("Administrator privileges are required to access /settings.");
          return;
        }
        await Promise.all([loadSettings(), loadDevices(), loadUsers()]);
      } catch (e) {
        if (active) {
          setAuthError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [loadDevices, loadSettings, loadUsers, router]);

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    await getBrowserSupabaseClient()?.auth.signOut().catch(() => null);
    router.replace("/login");
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsBusy(true);
    setSettingsMsg(null);
    setSettingsErr(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formValues),
      });
      const body = (await res.json().catch(() => null)) as {
        settings?: Settings;
        audit_log?: SettingsAuditItem[];
        changes?: { key: string; old_value: string | null; new_value: string }[];
        message?: string;
      } | null;

      if (!res.ok || !body?.settings) {
        setSettingsErr(body?.message ?? `Failed to save settings (HTTP ${res.status})`);
        return;
      }
      applySettingsToForm(body.settings);
      setAuditLog(body.audit_log ?? []);
      const count = body.changes?.length ?? 0;
      setSettingsMsg(
        count > 0
          ? `Saved ${count} setting change(s) and recorded in the audit log.`
          : "Settings saved (no values changed).",
      );
    } catch (err) {
      setSettingsErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleCreateDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceName.trim()) return;
    setDevicesBusy(true);
    setDevicesErr(null);
    setCreatedKeyOnce(null);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newDeviceName.trim() }),
      });
      const body = (await res.json().catch(() => null)) as {
        device?: DeviceAdminItem;
        api_key?: string;
        message?: string;
      } | null;

      if (!res.ok || !body?.device || !body?.api_key) {
        setDevicesErr(body?.message ?? `Failed to create device (HTTP ${res.status})`);
        return;
      }
      setCreatedKeyOnce({ name: body.device.name, apiKey: body.api_key });
      setNewDeviceName("");
      await loadDevices();
    } catch (err) {
      setDevicesErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDevicesBusy(false);
    }
  };

  const handleRevokeDevice = async (id: string) => {
    setDevicesBusy(true);
    setDevicesErr(null);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "revoke" }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setDevicesErr(body?.message ?? `Failed to revoke device (HTTP ${res.status})`);
        return;
      }
      await loadDevices();
    } catch (err) {
      setDevicesErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDevicesBusy(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUsersBusy(true);
    setUsersMsg(null);
    setUsersErr(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newUserEmail.trim(),
          password: newUserPassword,
          role: newUserRole,
          mode: newUserMode,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        user?: { email: string; role: string; mode: string };
        message?: string;
      } | null;
      if (!res.ok || !body?.user) {
        setUsersErr(body?.message ?? `Failed to provision user (HTTP ${res.status})`);
        return;
      }
      setUsersMsg(
        body.user.mode === "invite"
          ? `Invitation sent to ${body.user.email} (${body.user.role}).`
          : `Created account for ${body.user.email} (${body.user.role}).`,
      );
      setNewUserEmail("");
      setNewUserPassword("");
      await loadUsers();
    } catch (err) {
      setUsersErr(err instanceof Error ? err.message : String(err));
    } finally {
      setUsersBusy(false);
    }
  };

  const handleUpdateUser = async (
    userId: string,
    patch: { role?: "admin" | "viewer"; disabled?: boolean },
  ) => {
    setUsersBusy(true);
    setUsersMsg(null);
    setUsersErr(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, ...patch }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setUsersErr(body?.message ?? `Failed to update user (HTTP ${res.status})`);
        return;
      }
      setUsersMsg("User updated.");
      await loadUsers();
    } catch (err) {
      setUsersErr(err instanceof Error ? err.message : String(err));
    } finally {
      setUsersBusy(false);
    }
  };

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

  return (
    <main className="hmi-shell">
      <div className="hmi-topbar">
        <Link href="/" className="app-brand">
          <div className="mark">🌾</div>
          <div>
            <div className="name">AgriVision QC</div>
            <div className="sub">Administration · Settings, Devices &amp; Users</div>
          </div>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {currentUser && (
            <span className="status-pill pill-good" style={{ fontSize: 12 }}>
              👤 {currentUser.email} ({currentUser.role.toUpperCase()})
            </span>
          )}
          <Link href="/" className="hmi-btn">
            ⬅️ Back to Dashboard
          </Link>
          <Link href="/admin/import" className="hmi-btn">
            ⬆️ CSV Importer
          </Link>
          <button type="button" className="hmi-btn" onClick={handleSignOut}>
            🚪 Sign out
          </button>
        </div>
      </div>

      <h1 className="page-title">System Administration</h1>
      <div className="page-subtitle">
        Configure QC thresholds and assumed seed weights, manage Jetson edge device keys, and provision operator or administrator accounts.
      </div>

      <div className="tabs-header">
        <button
          type="button"
          className={`tab-btn ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          ⚙️ App Settings
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "devices" ? "active" : ""}`}
          onClick={() => setActiveTab("devices")}
        >
          📡 Edge Devices ({devices.length})
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === "users" ? "active" : ""}`}
          onClick={() => setActiveTab("users")}
        >
          👥 Users &amp; Roles ({users.length})
        </button>
      </div>

      {/* ── TAB 1: APP SETTINGS ── */}
      {activeTab === "settings" && (
        <section style={{ display: "grid", gap: 18 }}>
          <div className="banner banner-warn" style={{ fontSize: 13 }}>
            ⚠️ <strong>Seed Weight Model Note:</strong> The four per-class single-seed weights (
            <code>good</code>, <code>immature</code>, <code>sm</code>, <code>dc</code>) are{" "}
            <strong>ASSUMED, not measured</strong>. All gram and weight-percentage metrics on the dashboard and PDF reports are estimates derived from seed counts.
          </div>

          {settingsErr && <div className="banner banner-danger">⚠️ {settingsErr}</div>}
          {settingsMsg && (
            <div
              className="banner"
              style={{
                background: "#f0fdf4",
                border: "1px solid #86efac",
                color: "#14532d",
              }}
            >
              ✅ {settingsMsg}
            </div>
          )}

          <form
            onSubmit={handleSaveSettings}
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 15,
              padding: 20,
              display: "grid",
              gap: 16,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 14,
              }}
            >
              {EDITABLE_SETTINGS_SPEC.map((spec) => (
                <label
                  key={spec.key}
                  style={{
                    display: "grid",
                    gap: 4,
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid #e2e8f0",
                    background: spec.assumedWeightNote ? "#fffbeb" : "#f8fafc",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>
                      {spec.label}
                    </span>
                    {spec.assumedWeightNote && (
                      <span
                        className="status-pill pill-warn"
                        style={{ fontSize: 10, padding: "2px 7px" }}
                      >
                        ASSUMED, not measured
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11.5, color: "#64748b" }}>
                    <code>{spec.key}</code> · {spec.description}
                  </span>

                  {spec.kind === "timezone" ? (
                    <select
                      value={formValues[spec.key]}
                      onChange={(e) =>
                        setFormValues((prev) => ({
                          ...prev,
                          [spec.key]: e.target.value,
                        }))
                      }
                      style={{
                        marginTop: 4,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #cbd5e1",
                        fontSize: 13.5,
                        background: "#fff",
                      }}
                    >
                      <option value="UTC">UTC</option>
                      <option value="Asia/Bangkok">Asia/Bangkok</option>
                    </select>
                  ) : (
                    <input
                      type={spec.kind === "string" ? "text" : "number"}
                      step={spec.kind === "number" ? "any" : spec.kind === "integer" ? "1" : undefined}
                      min={spec.min}
                      max={spec.max}
                      maxLength={spec.maxLength}
                      required
                      value={formValues[spec.key]}
                      onChange={(e) =>
                        setFormValues((prev) => ({
                          ...prev,
                          [spec.key]: e.target.value,
                        }))
                      }
                      style={{
                        marginTop: 4,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid #cbd5e1",
                        fontSize: 13.5,
                        background: "#fff",
                      }}
                    />
                  )}
                </label>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="submit"
                disabled={settingsBusy}
                className="hmi-btn hmi-btn-primary"
              >
                {settingsBusy ? "Saving…" : "💾 Save App Settings"}
              </button>
            </div>
          </form>

          {/* Settings Audit Log */}
          <div>
            <div className="section-title">Settings Audit Log (Recent Changes)</div>
            <div className="table-wrap">
              <table className="hmi-table">
                <thead>
                  <tr>
                    <th>When (Asia/Bangkok)</th>
                    <th>Setting Key</th>
                    <th>Previous Value</th>
                    <th>New Value</th>
                    <th>Changed By</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ color: "#64748b", textAlign: "center", padding: 16 }}>
                        No setting changes recorded yet.
                      </td>
                    </tr>
                  ) : (
                    auditLog.map((item) => (
                      <tr key={item.id}>
                        <td>{formatBangkokTimestamp(item.changed_at)}</td>
                        <td>
                          <code>{item.setting_key}</code>
                        </td>
                        <td>
                          <code>{item.old_value ?? "—"}</code>
                        </td>
                        <td>
                          <strong>
                            <code>{item.new_value}</code>
                          </strong>
                        </td>
                        <td>{item.changed_by_email || item.changed_by || "admin"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ── TAB 2: EDGE DEVICES ── */}
      {activeTab === "devices" && (
        <section style={{ display: "grid", gap: 18 }}>
          {devicesErr && <div className="banner banner-danger">⚠️ {devicesErr}</div>}

          {createdKeyOnce && (
            <div
              role="alert"
              style={{
                padding: 18,
                borderRadius: 14,
                border: "2px solid #16a34a",
                background: "#f0fdf4",
                color: "#14532d",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 15 }}>
                🔑 Device &ldquo;{createdKeyOnce.name}&rdquo; Created — Save This Key Now (Shown ONCE)
              </div>
              <div style={{ fontSize: 13 }}>
                Only the SHA-256 hash of this key is stored in the database. Once you dismiss this notice or leave the page, the plaintext key can never be viewed again.
              </div>
              <div
                style={{
                  padding: "10px 12px",
                  background: "#ffffff",
                  border: "1px solid #86efac",
                  borderRadius: 8,
                  fontFamily: "monospace",
                  fontSize: 13.5,
                  wordBreak: "break-all",
                }}
              >
                AGRIVISION_DEVICE_KEY={createdKeyOnce.apiKey}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="hmi-btn hmi-btn-primary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(createdKeyOnce.apiKey);
                  }}
                >
                  📋 Copy Key
                </button>
                <button
                  type="button"
                  className="hmi-btn"
                  onClick={() => setCreatedKeyOnce(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <form
            onSubmit={handleCreateDevice}
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 15,
              padding: 18,
              display: "flex",
              gap: 10,
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <label style={{ display: "grid", gap: 4, flex: "1 1 260px", fontSize: 13, fontWeight: 700 }}>
              New edge device name (e.g. jetson-line-1)
              <input
                type="text"
                required
                maxLength={80}
                placeholder="jetson-line-1"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #cbd5e1",
                  fontSize: 14,
                }}
              />
            </label>
            <button
              type="submit"
              disabled={devicesBusy || !newDeviceName.trim()}
              className="hmi-btn hmi-btn-primary"
            >
              ➕ Create Device &amp; Generate Key
            </button>
          </form>

          <div className="table-wrap">
            <table className="hmi-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Device UUID</th>
                  <th>Status</th>
                  <th>Last Seen (Asia/Bangkok)</th>
                  <th>Created (Asia/Bangkok)</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {devices.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "#64748b", padding: 18 }}>
                      No devices registered yet.
                    </td>
                  </tr>
                ) : (
                  devices.map((d) => {
                    const isRevoked = Boolean(d.revoked_at);
                    return (
                      <tr key={d.id}>
                        <td style={{ fontWeight: 700 }}>{d.name}</td>
                        <td>
                          <code>{d.id}</code>
                        </td>
                        <td>
                          <span className={`status-pill ${isRevoked ? "pill-bad" : "pill-good"}`}>
                            {isRevoked ? "🔴 Revoked" : "🟢 Active"}
                          </span>
                        </td>
                        <td>
                          {d.last_seen_at ? formatBangkokTimestamp(d.last_seen_at) : "Never"}
                        </td>
                        <td>{formatBangkokTimestamp(d.created_at)}</td>
                        <td>
                          {isRevoked ? (
                            <span style={{ fontSize: 12, color: "#64748b" }}>
                              Revoked {formatBangkokTimestamp(d.revoked_at)}
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={devicesBusy}
                              className="hmi-btn"
                              style={{ color: "#991b1b", borderColor: "#fecaca" }}
                              onClick={() => handleRevokeDevice(d.id)}
                            >
                              🚫 Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── TAB 3: USERS & ROLES ── */}
      {activeTab === "users" && (
        <section style={{ display: "grid", gap: 18 }}>
          {usersErr && <div className="banner banner-danger">⚠️ {usersErr}</div>}
          {usersMsg && (
            <div
              className="banner"
              style={{
                background: "#f0fdf4",
                border: "1px solid #86efac",
                color: "#14532d",
              }}
            >
              ✅ {usersMsg}
            </div>
          )}

          <form
            onSubmit={handleCreateUser}
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 15,
              padding: 18,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              alignItems: "end",
            }}
          >
            <label style={{ display: "grid", gap: 4, fontSize: 13, fontWeight: 700 }}>
              Email
              <input
                type="email"
                required
                placeholder="operator@example.com"
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
              />
            </label>

            <label style={{ display: "grid", gap: 4, fontSize: 13, fontWeight: 700 }}>
              Provisioning Mode
              <select
                value={newUserMode}
                onChange={(e) => setNewUserMode(e.target.value as "create" | "invite")}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff" }}
              >
                <option value="create">Create with password</option>
                <option value="invite">Send email invite</option>
              </select>
            </label>

            {newUserMode === "create" && (
              <label style={{ display: "grid", gap: 4, fontSize: 13, fontWeight: 700 }}>
                Initial Password (&ge; 12 chars)
                <input
                  type="password"
                  required
                  minLength={12}
                  placeholder="Minimum 12 characters"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                />
              </label>
            )}

            <label style={{ display: "grid", gap: 4, fontSize: 13, fontWeight: 700 }}>
              Role
              <select
                value={newUserRole}
                onChange={(e) => setNewUserRole(e.target.value as "viewer" | "admin")}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff" }}
              >
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>

            <button
              type="submit"
              disabled={usersBusy}
              className="hmi-btn hmi-btn-primary"
              style={{ justifyContent: "center" }}
            >
              ➕ {newUserMode === "invite" ? "Invite User" : "Create User"}
            </button>
          </form>

          <div className="table-wrap">
            <table className="hmi-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last Sign-In</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "#64748b", padding: 18 }}>
                      No users found.
                    </td>
                  </tr>
                ) : (
                  users.map((u) => {
                    const isSelf = currentUser?.id === u.id;
                    return (
                      <tr key={u.id}>
                        <td style={{ fontWeight: 700 }}>
                          {u.email}{" "}
                          {isSelf && (
                            <span style={{ fontSize: 11, color: "#16a34a" }}>(You)</span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`status-pill ${u.role === "admin" ? "pill-warn" : "pill-neutral"}`}
                          >
                            {u.role.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <span className={`status-pill ${u.disabled ? "pill-bad" : "pill-good"}`}>
                            {u.disabled ? "🔴 Disabled" : "🟢 Active"}
                          </span>
                        </td>
                        <td>
                          {u.last_sign_in_at
                            ? formatBangkokTimestamp(u.last_sign_in_at)
                            : "Never"}
                        </td>
                        <td>{formatBangkokTimestamp(u.created_at)}</td>
                        <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <select
                            disabled={usersBusy || isSelf}
                            value={u.role}
                            onChange={(e) =>
                              handleUpdateUser(u.id, {
                                role: e.target.value as "admin" | "viewer",
                              })
                            }
                            style={{
                              padding: "4px 8px",
                              borderRadius: 6,
                              border: "1px solid #cbd5e1",
                              fontSize: 12,
                              background: "#fff",
                            }}
                          >
                            <option value="viewer">Viewer</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button
                            type="button"
                            disabled={usersBusy || isSelf}
                            className="hmi-btn"
                            style={{ padding: "4px 10px", fontSize: 12 }}
                            onClick={() =>
                              handleUpdateUser(u.id, { disabled: !u.disabled })
                            }
                          >
                            {u.disabled ? "✅ Enable" : "🚫 Disable"}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
