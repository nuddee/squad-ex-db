#!/usr/bin/env tsx
/**
 * End-to-end smoke test script (`pnpm smoke [base-url]`).
 *
 * Unauthenticated checks (always run):
 *   1. GET  /api/health       -> 200 ({ ok: true, db: true })
 *   2. GET  /                 -> 302/307 redirect to /login when logged out
 *   3. GET  /api/batches      -> 401 without session
 *   4. POST /api/ingest/rows  -> 401 with a bad device key
 *
 * Optional authenticated checks (run when SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD are set):
 *   5. Sign in via @supabase/ssr
 *   6. GET  /api/batches                 -> 200 (lists batches)
 *   7. GET  /api/batches/[id]            -> 200 (fetches one batch + metrics)
 *   8. GET  /api/batches/[id]/snapshots  -> 200 (fetches paginated snapshots)
 *   9. POST /api/batches/[id]/report     -> 200 (generates PDF report & verifies signed URL)
 *  10. Clean up the generated test report (DB row + Storage object)
 */
import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
import {
  getPublicSupabaseUrl,
  getSupabasePublishableKey,
  loadEnvLocalIfNeeded,
  type EnvMap,
} from "../lib/env";
import { serviceClient } from "../lib/ingest/store-supabase";
import { normalizeReportKey, REPORT_BUCKET } from "../lib/report/pdf";

export interface SmokeCheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  httpStatus: string;
  detail: string;
}

export interface SmokeSuiteOptions {
  env?: EnvMap;
  fetchImpl?: typeof fetch;
  signInAndGetCookie?: (email: string, password: string) => Promise<string>;
  cleanupReport?: (reportId: string, storagePath: string) => Promise<void>;
}

async function defaultSignInAndGetCookie(
  email: string,
  password: string,
  env: EnvMap,
): Promise<string> {
  const url = getPublicSupabaseUrl(env);
  const key = getSupabasePublishableKey(env);
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required for SMOKE_ADMIN_EMAIL sign-in",
    );
  }
  const cookieJar = new Map<string, string>();
  const ssr = createServerClient(url, key, {
    cookies: {
      getAll() {
        return [...cookieJar.entries()].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          if (value) {
            cookieJar.set(name, value);
          } else {
            cookieJar.delete(name);
          }
        }
      },
    },
  });

  const { error } = await ssr.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Supabase signInWithPassword failed: ${error.message}`);
  }

  return [...cookieJar.entries()]
    .map(([name, value]) => serializeCookieHeader(name, value, {}).split(";")[0]!)
    .join("; ");
}

async function defaultCleanupReport(
  reportId: string,
  storagePath: string,
): Promise<void> {
  const db = serviceClient();
  const keys = new Set<string>([normalizeReportKey(storagePath), storagePath]);
  await db.storage.from(REPORT_BUCKET).remove([...keys]);
  const { error } = await db.from("reports").delete().eq("id", reportId);
  if (error) {
    throw new Error(`reports delete (${reportId}): ${error.message}`);
  }
}

export async function runSmokeSuite(
  rawBaseUrl: string,
  opts: SmokeSuiteOptions = {},
): Promise<{ ok: boolean; results: SmokeCheckResult[] }> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
  const results: SmokeCheckResult[] = [];

  // 1. GET /api/health -> 200
  try {
    const res = await fetchFn(`${baseUrl}/api/health`, {
      method: "GET",
      redirect: "manual",
    });
    let body: { ok?: boolean; db?: boolean } = {};
    try {
      body = (await res.json()) as { ok?: boolean; db?: boolean };
    } catch {
      // ignore non-json
    }
    const ok = res.status === 200 && body.ok === true;
    results.push({
      name: "GET /api/health",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok ? "ok=true, db=true" : `expected 200 ok=true, got ${res.status}`,
    });
  } catch (e) {
    results.push({
      name: "GET /api/health",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. GET / -> redirects to /login when logged out
  try {
    const res = await fetchFn(`${baseUrl}/`, {
      method: "GET",
      redirect: "manual",
    });
    const loc = res.headers.get("location") ?? "";
    const isRedirect =
      (res.status === 302 || res.status === 307 || res.status === 303 || res.status === 308) &&
      loc.includes("/login");
    results.push({
      name: "GET / (logged out -> /login)",
      status: isRedirect ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: isRedirect
        ? `Location: ${loc}`
        : `expected 302/307 to /login, got ${res.status} (${loc || "no Location"})`,
    });
  } catch (e) {
    results.push({
      name: "GET / (logged out -> /login)",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. GET /api/batches -> 401 without session
  try {
    const res = await fetchFn(`${baseUrl}/api/batches`, {
      method: "GET",
      redirect: "manual",
    });
    const ok = res.status === 401;
    results.push({
      name: "GET /api/batches (no session)",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok ? "401 unauthorized as expected" : `expected 401, got ${res.status}`,
    });
  } catch (e) {
    results.push({
      name: "GET /api/batches (no session)",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 4. POST /api/ingest/rows with bad key -> 401
  try {
    const res = await fetchFn(`${baseUrl}/api/ingest/rows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer agv_invalid_smoke_test_device_key_000000",
      },
      body: JSON.stringify({
        source_name: "grain_smoke_20261028_000000_rolling10s.csv",
        columns: ["snapshot_time", "snapshot_total"],
        rows: [],
      }),
    });
    const ok = res.status === 401;
    results.push({
      name: "POST /api/ingest/rows (bad key)",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok ? "401 unauthorized as expected" : `expected 401, got ${res.status}`,
    });
  } catch (e) {
    results.push({
      name: "POST /api/ingest/rows (bad key)",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 5. Optional authenticated flow when SMOKE_ADMIN_EMAIL + SMOKE_ADMIN_PASSWORD are set
  const adminEmail = (env.SMOKE_ADMIN_EMAIL ?? "").trim();
  const adminPassword = env.SMOKE_ADMIN_PASSWORD ?? "";

  if (!adminEmail || !adminPassword) {
    results.push({
      name: "Authenticated flow (SMOKE_ADMIN_EMAIL)",
      status: "SKIP",
      httpStatus: "-",
      detail: "Set SMOKE_ADMIN_EMAIL & SMOKE_ADMIN_PASSWORD to run authenticated checks",
    });
    return {
      ok: results.every((r) => r.status !== "FAIL"),
      results,
    };
  }

  let cookieHeader = "";
  try {
    const signIn =
      opts.signInAndGetCookie ??
      ((e: string, p: string) => defaultSignInAndGetCookie(e, p, env));
    cookieHeader = await signIn(adminEmail, adminPassword);
    results.push({
      name: "Auth sign-in (SMOKE_ADMIN_EMAIL)",
      status: "PASS",
      httpStatus: "200",
      detail: `Signed in as ${adminEmail}`,
    });
  } catch (e) {
    results.push({
      name: "Auth sign-in (SMOKE_ADMIN_EMAIL)",
      status: "FAIL",
      httpStatus: "401",
      detail: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, results };
  }

  const authHeaders = {
    Cookie: cookieHeader,
    Origin: baseUrl,
  };

  let targetBatchId: string | null = null;
  // 6. GET /api/batches (authenticated)
  try {
    const res = await fetchFn(`${baseUrl}/api/batches`, {
      method: "GET",
      headers: authHeaders,
    });
    const body = (await res.json()) as { batches?: { id: string; source_name: string }[] };
    const batches = body.batches ?? [];
    targetBatchId = batches[0]?.id ?? null;
    const ok = res.status === 200 && Array.isArray(body.batches);
    results.push({
      name: "GET /api/batches (authenticated)",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok
        ? `loaded ${batches.length} batch(es)${targetBatchId ? ` (first=${targetBatchId})` : ""}`
        : `expected 200, got ${res.status}`,
    });
  } catch (e) {
    results.push({
      name: "GET /api/batches (authenticated)",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  if (!targetBatchId) {
    results.push({
      name: "Batch detail / snapshots / report",
      status: "SKIP",
      httpStatus: "-",
      detail: "No batches present in DB to test /api/batches/[id] routes",
    });
    return {
      ok: results.every((r) => r.status !== "FAIL"),
      results,
    };
  }

  // 7. GET /api/batches/[id]
  try {
    const res = await fetchFn(`${baseUrl}/api/batches/${targetBatchId}`, {
      method: "GET",
      headers: authHeaders,
    });
    const body = (await res.json()) as {
      batch?: { id: string; truck_plate: string };
      total_rows?: number;
    };
    const ok = res.status === 200 && body.batch?.id === targetBatchId;
    results.push({
      name: "GET /api/batches/[id]",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok
        ? `plate=${body.batch?.truck_plate} total_rows=${body.total_rows}`
        : `expected 200 for ${targetBatchId}, got ${res.status}`,
    });
  } catch (e) {
    results.push({
      name: "GET /api/batches/[id]",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 8. GET /api/batches/[id]/snapshots
  try {
    const res = await fetchFn(`${baseUrl}/api/batches/${targetBatchId}/snapshots`, {
      method: "GET",
      headers: authHeaders,
    });
    const body = (await res.json()) as {
      batch_id?: string;
      total_snapshots?: number;
      items?: unknown[];
    };
    const ok = res.status === 200 && body.batch_id === targetBatchId;
    results.push({
      name: "GET /api/batches/[id]/snapshots",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok
        ? `total_snapshots=${body.total_snapshots} page_items=${body.items?.length ?? 0}`
        : `expected 200, got ${res.status}`,
    });
  } catch (e) {
    results.push({
      name: "GET /api/batches/[id]/snapshots",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 9. POST /api/batches/[id]/report + 10. Cleanup test report
  try {
    const res = await fetchFn(`${baseUrl}/api/batches/${targetBatchId}/report`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_snapshots: 2 }),
    });
    const body = (await res.json()) as {
      report_id?: string | null;
      storage_path?: string;
      signed_url?: string;
      filename?: string;
    };
    const ok =
      res.status === 200 &&
      typeof body.signed_url === "string" &&
      body.signed_url.length > 0 &&
      typeof body.storage_path === "string" &&
      !body.storage_path.startsWith("reports/");

    results.push({
      name: "POST /api/batches/[id]/report",
      status: ok ? "PASS" : "FAIL",
      httpStatus: String(res.status),
      detail: ok
        ? `report_id=${body.report_id ?? "n/a"} path=${body.storage_path}`
        : `expected 200 with unprefixed storage_path & signed_url, got ${res.status}`,
    });

    if (ok && body.report_id && body.storage_path) {
      const cleanup = opts.cleanupReport ?? defaultCleanupReport;
      try {
        await cleanup(body.report_id, body.storage_path);
        results.push({
          name: "Cleanup generated test report",
          status: "PASS",
          httpStatus: "OK",
          detail: `Deleted report ${body.report_id} (${body.storage_path})`,
        });
      } catch (ce) {
        results.push({
          name: "Cleanup generated test report",
          status: "FAIL",
          httpStatus: "ERR",
          detail: ce instanceof Error ? ce.message : String(ce),
        });
      }
    }
  } catch (e) {
    results.push({
      name: "POST /api/batches/[id]/report",
      status: "FAIL",
      httpStatus: "ERR",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    ok: results.every((r) => r.status !== "FAIL"),
    results,
  };
}

export function formatSmokeTable(
  baseUrl: string,
  results: readonly SmokeCheckResult[],
): string {
  const nameWidth = Math.max(34, ...results.map((r) => r.name.length));
  const statusWidth = 6;
  const codeWidth = 6;
  const sep = `${"-".repeat(nameWidth)}-+-${"-".repeat(statusWidth)}-+-${"-".repeat(codeWidth)}-+-${"-".repeat(42)}`;
  const lines: string[] = [
    `Smoke Test Target: ${baseUrl}`,
    sep,
    `${"Check".padEnd(nameWidth)} | ${"Status".padEnd(statusWidth)} | ${"HTTP".padEnd(codeWidth)} | Detail`,
    sep,
  ];
  for (const r of results) {
    lines.push(
      `${r.name.padEnd(nameWidth)} | ${r.status.padEnd(statusWidth)} | ${r.httpStatus.padEnd(codeWidth)} | ${r.detail}`,
    );
  }
  lines.push(sep);
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadEnvLocalIfNeeded();
  const baseUrl =
    process.argv[2]?.trim() ||
    process.env.SMOKE_BASE_URL?.trim() ||
    "http://localhost:3000";

  const { ok, results } = await runSmokeSuite(baseUrl);
  console.log(formatSmokeTable(baseUrl, results));

  if (!ok) {
    process.exit(1);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /smoke(?:\.ts|\.js)?$/i.test(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error("[smoke] Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
