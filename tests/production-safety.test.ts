import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkAdminHeader } from "@/app/api/admin/import/route";
import { evaluateDashboardBasicAuth } from "@/lib/auth/basic-auth";
import { assertProductionEnv, isDevBypassAllowed } from "@/lib/env";
import { sanitizeLogFields } from "@/lib/log";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from "@/lib/security-headers";
import nextConfig from "../next.config";
import { formatSmokeTable, runSmokeSuite } from "../scripts/smoke";

const PROJECT_ROOT = path.resolve(__dirname, "..");

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === ".git" ||
      entry === "dist"
    ) {
      continue;
    }
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const VALID_PROD_ENV = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://emqooadipseotdbzqtbd.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_real_prod_key_1234567890",
  SUPABASE_SERVICE_ROLE_KEY: "sb" + "_secret_real_prod_secret_key_1234567890",
  ADMIN_IMPORT_TOKEN: "0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("Phase 8 production safety & hardening", () => {
  it("assertProductionEnv passes with valid production env and fails closed when any required var is missing", () => {
    expect(() => assertProductionEnv(VALID_PROD_ENV)).not.toThrow();

    // Non-production environments do not throw
    expect(() => assertProductionEnv({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertProductionEnv({ NODE_ENV: "test" })).not.toThrow();

    for (const requiredKey of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ADMIN_IMPORT_TOKEN",
    ] as const) {
      const missingEnv = { ...VALID_PROD_ENV, [requiredKey]: "" };
      expect(() => assertProductionEnv(missingEnv)).toThrow(requiredKey);
    }

    // Service role key accidentally set to publishable key fails closed
    expect(() =>
      assertProductionEnv({
        ...VALID_PROD_ENV,
        SUPABASE_SERVICE_ROLE_KEY: VALID_PROD_ENV.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      }),
    ).toThrow("SUPABASE_SERVICE_ROLE_KEY");

    // Short ADMIN_IMPORT_TOKEN (< 32 chars) fails closed
    expect(() =>
      assertProductionEnv({
        ...VALID_PROD_ENV,
        ADMIN_IMPORT_TOKEN: "too-short-token",
      }),
    ).toThrow("ADMIN_IMPORT_TOKEN");
  });

  it("disables all dev-only bypasses (ALLOW_INSECURE_ADMIN_IMPORT and Basic Auth defaults) when NODE_ENV=production", () => {
    expect(isDevBypassAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(isDevBypassAllowed({ NODE_ENV: "test" })).toBe(false);
    expect(isDevBypassAllowed({ NODE_ENV: "development" })).toBe(true);

    expect(() =>
      assertProductionEnv({
        ...VALID_PROD_ENV,
        ALLOW_INSECURE_ADMIN_IMPORT: "1",
      }),
    ).toThrow("ALLOW_INSECURE_ADMIN_IMPORT");

    // checkAdminHeader never allows ALLOW_INSECURE_ADMIN_IMPORT=1 in production
    const req = new Request("https://example.com/api/admin/import", {
      method: "POST",
    });
    expect(
      checkAdminHeader(req, {
        configuredToken: "",
        nodeEnv: "production",
        allowInsecure: "1",
      }),
    ).toBe("disabled");

    // Basic Auth gate fails closed (503) in production if enabled without credentials, and rejects weak default passwords
    const basicDecision = evaluateDashboardBasicAuth(null, {
      NODE_ENV: "production",
      DASHBOARD_BASIC_AUTH_USER: "",
      DASHBOARD_BASIC_AUTH_PASSWORD: "",
    });
    expect(basicDecision.ok).toBe(false);
    if (!basicDecision.ok) {
      expect(basicDecision.status).toBe(503);
    }

    expect(() =>
      assertProductionEnv({
        ...VALID_PROD_ENV,
        DASHBOARD_BASIC_AUTH_ENABLED: "1",
        DASHBOARD_BASIC_AUTH_USER: "admin",
        DASHBOARD_BASIC_AUTH_PASSWORD: "password",
      }),
    ).toThrow("DASHBOARD_BASIC_AUTH_PASSWORD");
  });

  it("ensures only URL and publishable/anon key use NEXT_PUBLIC_, and client components never import secrets or serviceClient", () => {
    const allowedNextPublic = new Set([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]);

    const dirsToScan = ["app", "components", "lib", "scripts"].map((d) =>
      path.join(PROJECT_ROOT, d),
    );
    const files = [
      ...dirsToScan.flatMap((d) => walkSourceFiles(d)),
      path.join(PROJECT_ROOT, "proxy.ts"),
      path.join(PROJECT_ROOT, "instrumentation.ts"),
    ];

    const forbiddenInClientRe =
      /(?:process\.env\.(?:SUPABASE_SERVICE_ROLE_KEY|ADMIN_IMPORT_TOKEN|AGRIVISION_DEVICE_KEY|BOOTSTRAP_ADMIN_PASSWORD|DASHBOARD_BASIC_AUTH_PASSWORD)|\b(?:SUPABASE_SERVICE_ROLE_KEY|getServiceRoleKey|getAdminImportToken|serviceClient|store-supabase)\b)/;

    let clientFileCount = 0;
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(PROJECT_ROOT, file).replace(/\\/g, "/");

      // 1. Check all NEXT_PUBLIC_* tokens
      const matches = content.match(/\bNEXT_PUBLIC_[A-Z0-9_]+\b/g) ?? [];
      for (const m of matches) {
        expect(
          allowedNextPublic.has(m),
          `Disallowed NEXT_PUBLIC_ variable "${m}" found in ${rel}`,
        ).toBe(true);
      }

      // 2. Check client components and browser modules never reference server secrets or serviceClient
      const isClientFile =
        /^\s*["']use client["']/m.test(content) ||
        rel.startsWith("components/") ||
        rel === "lib/supabase/browser.ts";

      if (isClientFile) {
        clientFileCount++;
        const badMatch = forbiddenInClientRe.exec(content);
        expect(
          badMatch,
          `Client file ${rel} must never reference server-only secret/helper "${badMatch?.[0] ?? ""}"`,
        ).toBeNull();
      }
    }

    expect(clientFileCount).toBeGreaterThan(5);
  });

  it("configures CSP and security headers in next.config.ts allowing Supabase HTTPS + WSS Realtime and data: images", async () => {
    const csp = buildContentSecurityPolicy({
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: "https://emqooadipseotdbzqtbd.supabase.co",
    });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://*.supabase.co");
    expect(csp).toContain("wss://*.supabase.co");
    expect(csp).toContain("https://emqooadipseotdbzqtbd.supabase.co");
    expect(csp).toContain("wss://emqooadipseotdbzqtbd.supabase.co");
    expect(csp).toContain("img-src 'self' data: blob: https://*.supabase.co");
    expect(csp).toContain("frame-ancestors 'none'");

    const headers = buildSecurityHeaders(VALID_PROD_ENV);
    const byKey = new Map(headers.map((h) => [h.key, h.value]));
    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("Permissions-Policy")).toContain("camera=()");
    expect(byKey.get("X-Frame-Options")).toBe("DENY");
    expect(byKey.get("Strict-Transport-Security")).toContain("max-age=63072000");

    expect(typeof nextConfig.headers).toBe("function");
    const routeHeaders = await nextConfig.headers!();
    expect(routeHeaders.length).toBeGreaterThan(0);
    expect(routeHeaders[0]?.source).toBe("/:path*");
  });

  it("scrubs keys, tokens, passwords, and signed URLs in structured server logs (lib/log.ts)", () => {
    const raw = {
      batch_id: "6fa6c9cb-706e-4671-8425-090da07cfe1d",
      api_key: "agv_secretDeviceKey123456789",
      admin_token: "0123456789abcdef0123456789abcdef0123456789abcdef",
      signed_url:
        "https://emqooadipseotdbzqtbd.supabase.co/storage/v1/object/sign/reports/6fa6c9cb/2026.pdf?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJyZXBvcnRzIn0.sig",
      nested: {
        message:
          "Failed with key sb" + "_secret_superSecretValue999 and device agv_devKey999 at https://emqooadipseotdbzqtbd.supabase.co/storage/v1/object/sign/snapshots/img.jpg?token=abc123secret",
      },
    };

    const sanitized = sanitizeLogFields(raw);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.batch_id).toBe("6fa6c9cb-706e-4671-8425-090da07cfe1d");
    expect(sanitized.api_key).toBe("[REDACTED]");
    expect(sanitized.admin_token).toBe("[REDACTED]");
    expect(sanitized.signed_url).toBe("[REDACTED]");
    expect(serialized).not.toContain("agv_secretDeviceKey123456789");
    expect(serialized).not.toContain("sb" + "_secret_superSecretValue999");
    expect(serialized).not.toContain("agv_devKey999");
    expect(serialized).not.toContain("abc123secret");
    expect(serialized).not.toContain("/storage/v1/object/sign/");
  });

  it("runs smoke test suite for both unauthenticated and authenticated flows and cleans up test report", async () => {
    const cleanedReports: { id: string; path: string }[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(url);
      const headers = new Headers(init?.headers);
      const hasCookie = headers.get("cookie")?.includes("sb-test-auth-token");

      if (u.pathname === "/api/health") {
        return new Response(JSON.stringify({ ok: true, db: true }), { status: 200 });
      }
      if (u.pathname === "/") {
        return new Response(null, {
          status: 307,
          headers: { Location: "/login?next=%2F" },
        });
      }
      if (u.pathname === "/api/ingest/rows") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      if (u.pathname === "/api/batches") {
        if (!hasCookie) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            batches: [
              {
                id: "6fa6c9cb-706e-4671-8425-090da07cfe1d",
                source_name: "grain_SAMPLE 1_20261019_061517_rolling10s.csv",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.pathname === "/api/batches/6fa6c9cb-706e-4671-8425-090da07cfe1d") {
        return new Response(
          JSON.stringify({
            batch: { id: "6fa6c9cb-706e-4671-8425-090da07cfe1d", truck_plate: "SAMPLE 1" },
            total_rows: 55,
          }),
          { status: 200 },
        );
      }
      if (u.pathname === "/api/batches/6fa6c9cb-706e-4671-8425-090da07cfe1d/snapshots") {
        return new Response(
          JSON.stringify({
            batch_id: "6fa6c9cb-706e-4671-8425-090da07cfe1d",
            total_snapshots: 137,
            items: [{ id: "s-1" }],
          }),
          { status: 200 },
        );
      }
      if (u.pathname === "/api/batches/6fa6c9cb-706e-4671-8425-090da07cfe1d/report") {
        return new Response(
          JSON.stringify({
            report_id: "rep-smoke-1",
            storage_path: "6fa6c9cb-706e-4671-8425-090da07cfe1d/20261029T060000Z.pdf",
            signed_url: "https://example.test/signed.pdf",
            filename: "QC_Report_SAMPLE_1.pdf",
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const res = await runSmokeSuite("https://agrivision.example.test", {
      env: {
        SMOKE_ADMIN_EMAIL: "admin@example.com",
        SMOKE_ADMIN_PASSWORD: "StrongPassword123!",
      },
      fetchImpl: mockFetch,
      signInAndGetCookie: async () => "sb-test-auth-token=base64-xyz",
      cleanupReport: async (id, p) => {
        cleanedReports.push({ id, path: p });
      },
    });

    expect(res.ok).toBe(true);
    expect(cleanedReports).toEqual([
      {
        id: "rep-smoke-1",
        path: "6fa6c9cb-706e-4671-8425-090da07cfe1d/20261029T060000Z.pdf",
      },
    ]);
    const table = formatSmokeTable("https://agrivision.example.test", res.results);
    expect(table).toContain("GET /api/health");
    expect(table).toContain("Cleanup generated test report");
  });
});
