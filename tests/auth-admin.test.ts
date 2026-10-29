import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleAdminImport } from "@/app/api/admin/import/route";
import {
  createAdminDevice,
  listAdminDevices,
  revokeAdminDevice,
} from "@/lib/admin/devices";
import {
  EDITABLE_SETTINGS_SPEC,
  updateAdminSettings,
  validateSettingsUpdate,
} from "@/lib/admin/settings";
import {
  buildSessionCandidate,
  requireAdmin,
  requireUser,
  verifySameOrigin,
} from "@/lib/auth/session";
import { MIN_PASSWORD_LENGTH, validatePassword } from "@/lib/auth/password";
import { DISABLE_BAN_DURATION, setUserDisabled } from "@/lib/admin/users";
import { sha256Hex } from "@/lib/ingest/auth";
import { MemoryStore } from "@/lib/ingest/memory-store";

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("Phase 7: Auth, Settings, Devices, Users & Security", () => {
  it("1. requireUser / requireAdmin: no session -> 401, viewer on admin route -> 403, disabled -> 403, admin -> ok", async () => {
    const getReq = new Request("https://qc.example.com/api/batches", {
      method: "GET",
    });

    // No session -> 401
    const noSessionUser = await requireUser(getReq, {
      resolveUser: async () => null,
    });
    expect(noSessionUser.ok).toBe(false);
    if (!noSessionUser.ok) {
      expect(noSessionUser.response.status).toBe(401);
      const body = await noSessionUser.response.json();
      expect(body.error).toBe("unauthorized");
    }

    const noSessionAdmin = await requireAdmin(getReq, {
      resolveUser: async () => null,
    });
    expect(noSessionAdmin.ok).toBe(false);
    if (!noSessionAdmin.ok) {
      expect(noSessionAdmin.response.status).toBe(401);
    }

    // Viewer ('viewer' or legacy 'operator') passes requireUser, fails requireAdmin with 403
    for (const rawRole of ["viewer", "operator"]) {
      const viewerOnUserRoute = await requireUser(getReq, {
        resolveUser: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          email: "viewer@example.com",
          rawRole,
          disabled: false,
        }),
      });
      expect(viewerOnUserRoute.ok).toBe(true);
      if (viewerOnUserRoute.ok) {
        expect(viewerOnUserRoute.user.role).toBe("viewer");
      }

      const viewerOnAdminRoute = await requireAdmin(getReq, {
        resolveUser: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          email: "viewer@example.com",
          rawRole,
          disabled: false,
        }),
      });
      expect(viewerOnAdminRoute.ok).toBe(false);
      if (!viewerOnAdminRoute.ok) {
        expect(viewerOnAdminRoute.response.status).toBe(403);
        const body = await viewerOnAdminRoute.response.json();
        expect(body.error).toBe("forbidden");
      }
    }

    // Disabled user -> 403 account_disabled even if role is admin
    const disabledAdmin = await requireAdmin(getReq, {
      resolveUser: async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        email: "disabled@example.com",
        rawRole: "admin",
        disabled: true,
      }),
    });
    expect(disabledAdmin.ok).toBe(false);
    if (!disabledAdmin.ok) {
      expect(disabledAdmin.response.status).toBe(403);
      const body = await disabledAdmin.response.json();
      expect(body.error).toBe("account_disabled");
    }

    // Active admin -> passes both requireUser and requireAdmin
    const okAdmin = await requireAdmin(getReq, {
      resolveUser: async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        email: "admin@example.com",
        rawRole: "admin",
        disabled: false,
      }),
    });
    expect(okAdmin.ok).toBe(true);
    if (okAdmin.ok) {
      expect(okAdmin.user.role).toBe("admin");
      expect(okAdmin.user.email).toBe("admin@example.com");
    }
  });

  it("2. enforces CSRF same-origin check on state-changing requests (POST/PUT/PATCH/DELETE)", async () => {
    const resolveAdmin = async () => ({
      id: "33333333-3333-4333-8333-333333333333",
      email: "admin@example.com",
      rawRole: "admin",
      disabled: false,
    });

    // Missing Origin/Referer on POST -> 403
    const missingOriginReq = new Request("https://qc.example.com/api/admin/settings", {
      method: "PUT",
    });
    const resMissing = await requireAdmin(missingOriginReq, {
      resolveUser: resolveAdmin,
    });
    expect(resMissing.ok).toBe(false);
    if (!resMissing.ok) {
      expect(resMissing.response.status).toBe(403);
    }

    // Cross-origin Origin -> 403
    const crossOriginReq = new Request("https://qc.example.com/api/admin/settings", {
      method: "PUT",
      headers: { Origin: "https://evil.example.org" },
    });
    expect(verifySameOrigin(crossOriginReq)?.status).toBe(403);

    // Matching Origin -> allowed
    const sameOriginReq = new Request("https://qc.example.com/api/admin/settings", {
      method: "PUT",
      headers: { Origin: "https://qc.example.com" },
    });
    expect(verifySameOrigin(sameOriginReq)).toBeNull();
    const resOk = await requireAdmin(sameOriginReq, {
      resolveUser: resolveAdmin,
    });
    expect(resOk.ok).toBe(true);
  });

  it("3. validates app_settings updates server-side (types, ranges, ASSUMED seed weight flags) and records audit log entries", async () => {
    // All 4 seed weight specs carry assumedWeightNote = true
    const weightSpecs = EDITABLE_SETTINGS_SPEC.filter((s) =>
      s.key.endsWith("_seed_weight_g"),
    );
    expect(weightSpecs).toHaveLength(4);
    expect(weightSpecs.every((s) => s.assumedWeightNote === true)).toBe(true);

    // Valid update
    const valid = validateSettingsUpdate({
      good_seed_weight_g: 0.31,
      immature_seed_weight_g: "0.2",
      sm_seed_weight_g: 0.25,
      dc_seed_weight_g: 0.3,
      defect_warn_threshold_pct: 10.0,
      plate_variance_spread_pct: 8.0,
      metrics_window_rows: 0,
      expected_plates: 5,
      snapshot_filename_tz: "UTC",
      report_footer_left: "SQAUD Â· Grain QC Report",
      report_form_code: "FM-JJR",
    });
    expect(valid.ok).toBe(true);
    expect(valid.errors).toHaveLength(0);
    expect(valid.rowsToUpsert).toHaveLength(11);

    // Invalid updates: out-of-range weight, non-integer window, invalid tz, empty footer, unknown key
    const invalid = validateSettingsUpdate({
      good_seed_weight_g: -0.1,
      defect_warn_threshold_pct: 120,
      metrics_window_rows: 12.5,
      snapshot_filename_tz: "Mars/Olympus",
      report_footer_left: "   ",
      not_a_real_setting: 42,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.map((e) => e.key)).toEqual([
      "good_seed_weight_g",
      "defect_warn_threshold_pct",
      "metrics_window_rows",
      "snapshot_filename_tz",
      "report_footer_left",
      "not_a_real_setting",
    ]);

    // Verify updateAdminSettings records audit trail (who changed what)
    const settingStore = new Map<string, string>([
      ["defect_warn_threshold_pct", "10.0"],
      ["report_form_code", "FM-JJR"],
    ]);
    const auditInserted: Record<string, unknown>[] = [];

    const mockDb = {
      from(table: string) {
        if (table === "app_settings") {
          return {
            select: async () => ({
              data: Array.from(settingStore.entries()).map(([key, value]) => ({
                key,
                value,
              })),
              error: null,
            }),
            upsert: async (rows: { key: string; value: string }[]) => {
              for (const r of rows) {
                settingStore.set(r.key, r.value);
              }
              return { error: null };
            },
          };
        }
        if (table === "settings_audit_log") {
          return {
            insert: async (rows: Record<string, unknown>[]) => {
              auditInserted.push(...rows);
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const checked = validateSettingsUpdate({
      defect_warn_threshold_pct: 12.5,
      report_form_code: "FM-JJR", // unchanged -> should not create duplicate audit entry
    });
    expect(checked.ok).toBe(true);

    const updated = await updateAdminSettings(mockDb, checked.rowsToUpsert, {
      id: "33333333-3333-4333-8333-333333333333",
      email: "admin@example.com",
    });

    expect(updated.settings.defect_warn_threshold_pct).toBe(12.5);
    expect(updated.changes).toEqual([
      {
        key: "defect_warn_threshold_pct",
        old_value: "10.0",
        new_value: "12.5",
      },
    ]);
    expect(auditInserted).toHaveLength(1);
    expect(auditInserted[0]).toMatchObject({
      setting_key: "defect_warn_threshold_pct",
      old_value: "10.0",
      new_value: "12.5",
      changed_by: "33333333-3333-4333-8333-333333333333",
      changed_by_email: "admin@example.com",
    });
  });

  it("4. device management: creates device returning plaintext key ONCE, stores only SHA-256 hash, lists without key, and revokes", async () => {
    const dbRows: {
      id: string;
      name: string;
      api_key_hash: string;
      created_at: string;
      revoked_at: string | null;
      last_seen_at: string | null;
    }[] = [];

    const mockDb = {
      from(table: string) {
        expect(table).toBe("devices");
        return {
          insert: (row: { name: string; api_key_hash: string }) => ({
            select: () => ({
              single: async () => {
                const created = {
                  id: "44444444-4444-4444-8444-444444444444",
                  name: row.name,
                  api_key_hash: row.api_key_hash,
                  created_at: "2026-10-29T04:00:00.000Z",
                  revoked_at: null,
                  last_seen_at: null,
                };
                dbRows.push(created);
                return {
                  data: {
                    id: created.id,
                    name: created.name,
                    created_at: created.created_at,
                    revoked_at: created.revoked_at,
                  },
                  error: null,
                };
              },
            }),
          }),
          select: (cols: string) => {
            expect(cols).not.toContain("api_key_hash");
            return {
              order: async () => ({
                data: dbRows.map(({ api_key_hash: _omit, ...rest }) => rest),
                error: null,
              }),
            };
          },
          update: (patch: { revoked_at: string }) => ({
            eq: (col: string, id: string) => ({
              select: () => ({
                maybeSingle: async () => {
                  const found = dbRows.find((r) => col === "id" && r.id === id);
                  if (!found) return { data: null, error: null };
                  found.revoked_at = patch.revoked_at;
                  return {
                    data: {
                      id: found.id,
                      name: found.name,
                      created_at: found.created_at,
                      revoked_at: found.revoked_at,
                    },
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;

    // 1. Create device: returns plaintext api_key ONCE
    const created = await createAdminDevice(mockDb, "jetson-line-2");
    expect(created.api_key).toMatch(/^agv_/);
    expect(created.device.name).toBe("jetson-line-2");

    // Stored row in DB has ONLY the SHA-256 hash, never the plaintext key
    expect(dbRows[0]?.api_key_hash).toBe(sha256Hex(created.api_key));
    expect(dbRows[0]?.api_key_hash).not.toBe(created.api_key);

    // 2. Listing devices NEVER returns api_key or api_key_hash
    const listed = await listAdminDevices(mockDb);
    expect(listed).toHaveLength(1);
    expect("api_key" in listed[0]!).toBe(false);
    expect("api_key_hash" in listed[0]!).toBe(false);

    // 3. Revoking sets revoked_at
    const revoked = await revokeAdminDevice(mockDb, created.device.id);
    expect(revoked?.revoked_at).toBeTruthy();
  });

  it("5. /api/admin/import supports both ADMIN_IMPORT_TOKEN and logged-in admin session (rejecting viewer session with 403)", async () => {
    const csvContent =
      "snapshot_time,truck_plate,qc_name,snapshot_mix_summary,plate_number,estimated_grain_count,snapshot_total,snapshot_type\n" +
      "2026-10-28 10:00:10,83-4501,Somchai,good=90,1,100,100,last_frame\n";

    const makeFormRequest = (headers: Record<string, string>) => {
      const fd = new FormData();
      fd.append(
        "csv",
        new File([csvContent], "grain_83-4501_20261028_100000_rolling10s.csv", {
          type: "text/csv",
        }),
      );
      return new Request("https://qc.example.com/api/admin/import", {
        method: "POST",
        headers,
        body: fd,
      });
    };

    // Viewer session -> 403 Forbidden
    const viewerRes = await handleAdminImport(
      makeFormRequest({
        Origin: "https://qc.example.com",
        Cookie: "sb-access-token=mock",
      }),
      {
        store: () => new MemoryStore(),
        resolveUser: async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          email: "viewer@example.com",
          rawRole: "viewer",
          disabled: false,
        }),
      },
    );
    expect(viewerRes.status).toBe(403);

    // Admin session + matching Origin -> 200 OK
    const adminRes = await handleAdminImport(
      makeFormRequest({
        Origin: "https://qc.example.com",
        Cookie: "sb-access-token=mock",
      }),
      {
        store: () => new MemoryStore(),
        resolveUser: async () => ({
          id: "33333333-3333-4333-8333-333333333333",
          email: "admin@example.com",
          rawRole: "admin",
          disabled: false,
        }),
      },
    );
    expect(adminRes.status).toBe(200);
  });

  it("6. client bundle security check: NEXT_PUBLIC_ only exposes URL and publishable/anon key; no client component touches service role or admin tokens", () => {
    const roots = ["app", "components", "lib"].map((d) =>
      path.join(process.cwd(), d),
    );
    const files = roots.flatMap((r) => walkSourceFiles(r));
    expect(files.length).toBeGreaterThan(15);

    const allowedNextPublic = new Set([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const matches = content.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? [];
      for (const m of matches) {
        expect(allowedNextPublic.has(m)).toBe(true);
      }

      const isClientFile =
        content.startsWith('"use client"') || content.startsWith("'use client'");
      if (isClientFile) {
        expect(content).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
        expect(content).not.toContain("serviceClient(");
        expect(content).not.toContain("getServiceRoleKey");
        expect(content).not.toContain("getAdminImportToken");
      }
    }
  });

  it("7. requireUser with a disabled / missing profile -> 403 account_disabled (fail closed)", async () => {
    const req = new Request("https://qc.example.com/api/batches");
    const base = {
      id: "55555555-5555-4555-8555-555555555555",
      email: "u@example.com",
      isBanned: false,
      metaDisabled: false,
      metaRole: "admin" as string | null,
    };

    const cases = [
      { name: "profile.disabled_at set", c: buildSessionCandidate({ ...base, profile: { role: "admin", disabled_at: "2026-10-29T00:00:00Z" } }) },
      { name: "no profile row (RLS hides a disabled user's own row)", c: buildSessionCandidate({ ...base, profile: null }) },
      { name: "auth ban active", c: buildSessionCandidate({ ...base, isBanned: true, profile: { role: "viewer", disabled_at: null } }) },
      { name: "app_metadata.disabled", c: buildSessionCandidate({ ...base, metaDisabled: true, profile: { role: "viewer", disabled_at: null } }) },
    ];
    for (const { name, c } of cases) {
      expect(c.disabled, name).toBe(true);
      const res = await requireUser(req, { resolveUser: async () => c });
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.response.status, name).toBe(403);
        expect((await res.response.json()).error).toBe("account_disabled");
      }
    }

    // Active profile: allowed, and the profile role is authoritative over app_metadata
    const active = buildSessionCandidate({ ...base, profile: { role: "viewer", disabled_at: null } });
    expect(active.disabled).toBe(false);
    expect(active.rawRole).toBe("viewer");
    const ok = await requireUser(req, { resolveUser: async () => active });
    expect(ok.ok).toBe(true);
  });

  it("8. disable flow: Auth ban + profiles.disabled_at + session revoke; re-enable lifts the ban and does not revoke", async () => {
    const calls: string[] = [];
    let banArgs: Record<string, unknown> | null = null;
    let profileRow: Record<string, unknown> | null = null;
    let rpcArgs: Record<string, unknown> | null = null;

    const mockDb = {
      auth: {
        admin: {
          updateUserById: async (_id: string, attrs: Record<string, unknown>) => {
            calls.push("ban");
            banArgs = attrs;
            return { error: null };
          },
        },
      },
      from: (table: string) => ({
        upsert: async (row: Record<string, unknown>) => {
          expect(table).toBe("profiles");
          calls.push("profile");
          profileRow = row;
          return { error: null };
        },
      }),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        expect(fn).toBe("revoke_user_sessions");
        calls.push("revoke");
        rpcArgs = args;
        return { data: 2, error: null };
      },
    } as unknown as SupabaseClient;

    const uid = "66666666-6666-4666-8666-666666666666";
    const res = await setUserDisabled(mockDb, uid, true, "2026-10-29T05:00:00.000Z");
    expect(calls).toEqual(["ban", "profile", "revoke"]);
    expect(banArgs).toMatchObject({ ban_duration: DISABLE_BAN_DURATION, app_metadata: { disabled: true } });
    expect(profileRow).toEqual({ user_id: uid, disabled_at: "2026-10-29T05:00:00.000Z" });
    expect(rpcArgs).toEqual({ p_user_id: uid });
    expect(res).toEqual({ sessionsRevoked: 2, revokeError: null });

    calls.length = 0;
    const re = await setUserDisabled(mockDb, uid, false);
    expect(calls).toEqual(["ban", "profile"]);
    expect(banArgs).toMatchObject({ ban_duration: "none", app_metadata: { disabled: false } });
    expect(profileRow).toEqual({ user_id: uid, disabled_at: null });
    expect(re.sessionsRevoked).toBeNull();

    // A failing revoke is reported, never silently swallowed
    const failing = {
      ...mockDb,
      rpc: async () => ({ data: null, error: { message: "function revoke_user_sessions does not exist" } }),
    } as unknown as SupabaseClient;
    const bad = await setUserDisabled(failing, uid, true);
    expect(bad.revokeError).toContain("revoke_user_sessions");
  });

  it("9. passwords need >= 12 chars (server-side validator)", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(validatePassword("short-pass1").ok).toBe(false); // 11 chars
    expect(validatePassword("exactly-12-ch").ok).toBe(true);
    expect(validatePassword(undefined).ok).toBe(false);
  });

  it("10. migrations 009/010 contain the expected guards and policies", () => {
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const m10 = readFileSync(path.join(dir, "20261028000010_disabled_users_rls.sql"), "utf8");
    for (const policy of [
      "read_batches",
      "read_rows",
      "read_snapshots",
      "read_reports",
      "read_settings",
      "read_own_profile",
      "read_snapshot_files",
      "read_report_files",
    ]) {
      const re = new RegExp(`create policy ${policy}[\\s\\S]*?;`);
      expect(re.exec(m10)?.[0], policy).toMatch(/is_active_user\(\)|disabled_at is null/);
    }
    expect(m10).toContain("alter column role set default 'viewer'");
    expect(m10).not.toMatch(/updated_at/);

    const m9 = readFileSync(path.join(dir, "20261028000009_repair_migration_003_objects.sql"), "utf8");
    for (const g of [
      "add column if not exists last_seen_at",
      "batches_device_id_source_name_key",
      "create unique index if not exists batches_manual_source_name_idx",
      "create or replace function public.refresh_batch_stats()",
      "drop trigger if exists rows_stats_ins",
      "drop trigger if exists rows_stats_upd",
    ]) {
      expect(m9).toContain(g);
    }
    expect(m9).not.toMatch(/updated_at/);
  });
});
