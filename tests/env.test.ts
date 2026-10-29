import { describe, expect, it } from "vitest";
import {
  explainSupabaseError,
  formatEnvCheckReport,
  generateAdminToken,
  getSupabasePublishableKey,
  getSupabaseUrl,
  redactSecret,
  runEnvCheck,
  validateEnvShape,
} from "@/lib/env";

const VALID_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://emqooadipseotdbzqtbd.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_valid_key_123456",
  SUPABASE_URL: "https://emqooadipseotdbzqtbd.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test_valid_secret_key_987654",
  ADMIN_IMPORT_TOKEN: "a".repeat(48),
};

describe("env helpers and check-env validation", () => {
  it("prefers NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and falls back to NEXT_PUBLIC_SUPABASE_ANON_KEY", () => {
    expect(
      getSupabasePublishableKey({
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_primary",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_fallback",
      }),
    ).toBe("sb_publishable_primary");

    expect(
      getSupabasePublishableKey({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_fallback",
      }),
    ).toBe("sb_publishable_fallback");
  });

  it("falls back from SUPABASE_URL to NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(
      getSupabaseUrl({
        NEXT_PUBLIC_SUPABASE_URL: "https://emqooadipseotdbzqtbd.supabase.co/",
      }),
    ).toBe("https://emqooadipseotdbzqtbd.supabase.co");
  });

  it("redacts secrets to show only prefix and length without exposing secret material", () => {
    const pub = redactSecret("sb_publishable_SUPER_SECRET_SUFFIX_12345");
    expect(pub).toBe("sb_publishable_… (len=40)");
    expect(pub).not.toContain("SUPER_SECRET");

    const sec = redactSecret("sb_secret_SUPER_SECRET_SUFFIX_1234567890");
    expect(sec).toBe("sb_secret_… (len=40)");
    expect(sec).not.toContain("SUPER_SECRET");

    const tok = redactSecret("abcd_SUPER_SECRET_ADMIN_TOKEN_VALUE_1234567890");
    expect(tok).toBe("abcd… (len=46)");
    expect(tok).not.toContain("SUPER_SECRET");
  });

  it("generates a 48-char random token for ADMIN_IMPORT_TOKEN", () => {
    const t1 = generateAdminToken();
    const t2 = generateAdminToken();
    expect(t1).toHaveLength(48);
    expect(t2).toHaveLength(48);
    expect(t1).not.toBe(t2);
  });

  it("validates shape errors with actionable hints", () => {
    const bad = validateEnvShape({
      NEXT_PUBLIC_SUPABASE_URL: "http://example.com",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "wrong_prefix_key",
      SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_same_as_anon",
      ADMIN_IMPORT_TOKEN: "short-token",
    });
    const byName = Object.fromEntries(bad.map((i) => [i.name, i]));
    expect(byName.NEXT_PUBLIC_SUPABASE_URL?.ok).toBe(false);
    expect(byName.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.ok).toBe(false);
    expect(byName.SUPABASE_SERVICE_ROLE_KEY?.ok).toBe(false);
    expect(byName.ADMIN_IMPORT_TOKEN?.ok).toBe(false);
    expect(byName.ADMIN_IMPORT_TOKEN?.hint).toContain("pnpm gen-token");
  });

  it("passes runEnvCheck when shape, devices table, and private buckets are valid", async () => {
    const res = await runEnvCheck({
      env: VALID_ENV,
      probe: {
        async selectDevices() {
          return { count: 0, error: null };
        },
        async listBuckets() {
          return {
            buckets: [
              { id: "snapshots", name: "snapshots", public: false },
              { id: "reports", name: "reports", public: false },
            ],
            error: null,
          };
        },
      },
    });
    expect(res.ok).toBe(true);
    const report = formatEnvCheckReport(res.items);
    expect(report).toContain("[OK  ] db: select from devices");
    expect(report).toContain("[OK  ] storage bucket: snapshots");
    expect(report).toContain("[OK  ] storage bucket: reports");
    expect(report).not.toContain("test_valid_secret_key");
  });

  it("reports migrations-not-applied and missing-bucket hints when Supabase probes fail", async () => {
    const res = await runEnvCheck({
      env: VALID_ENV,
      probe: {
        async selectDevices() {
          return {
            count: 0,
            error: { code: "42P01", message: 'relation "public.devices" does not exist' },
          };
        },
        async listBuckets() {
          return {
            buckets: [{ id: "snapshots", name: "snapshots", public: false }],
            error: null,
          };
        },
      },
    });
    expect(res.ok).toBe(false);
    const devItem = res.items.find((i) => i.name === "db: select from devices");
    const repItem = res.items.find((i) => i.name === "storage bucket: reports");
    expect(devItem?.ok).toBe(false);
    expect(devItem?.hint).toContain("supabase db push");
    expect(repItem?.ok).toBe(false);
    expect(repItem?.hint).toContain('Bucket "reports" does not exist');
  });

  it("classifies wrong service key errors clearly", () => {
    const info = explainSupabaseError({ status: 401, message: "Invalid API key" });
    expect(info.reason).toBe("wrong_key");
    expect(info.hint).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
