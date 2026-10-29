import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type EnvMap = Record<string, string | undefined>;

const SUPABASE_HTTPS_URL_RE = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i;

const PLACEHOLDER_VALUES = new Set([
  "sb_publishable_your_key",
  "your-anon-key",
  "sb_secret_your_key",
  "your-service-role-key",
  "generate-a-random-secret",
  "run-pnpm-gen-token-to-generate-48-char-secret",
]);

/**
 * Load `.env.local` into `targetEnv` (default `process.env`) if the file exists.
 * Existing variables in `targetEnv` are preserved. Never logs or prints values.
 */
export function loadEnvLocalIfNeeded(
  filePath?: string,
  targetEnv: EnvMap = process.env,
): boolean {
  // Dynamically require node:fs and node:path only when invoked in CLI scripts (Node.js runtime)
  // so lib/env.ts stays 100% compatible with both Node.js and Edge instrumentation/middleware bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require(/*turbopackIgnore: true*/ "node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require(/*turbopackIgnore: true*/ "node:path") as typeof import("node:path");
  const resolvedPath = filePath ?? nodePath.resolve(".env.local");
  if (!fs.existsSync(resolvedPath)) return false;
  const content = fs.readFileSync(resolvedPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim().replace(/^export\s+/, "");
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (targetEnv[key] === undefined) {
      targetEnv[key] = val;
    }
  }
  return true;
}

/** Server URL: `SUPABASE_URL` (optional) falls back to `NEXT_PUBLIC_SUPABASE_URL`. */
export function getSupabaseUrl(env: EnvMap = process.env): string {
  return (env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "").replace(/\/+$/, "");
}

/** Browser/public URL: `NEXT_PUBLIC_SUPABASE_URL` falls back to `SUPABASE_URL`. */
export function getPublicSupabaseUrl(env: EnvMap = process.env): string {
  return (env.NEXT_PUBLIC_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim() || "").replace(/\/+$/, "");
}

/**
 * Public anon/publishable key: checks `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` first,
 * then `NEXT_PUBLIC_SUPABASE_ANON_KEY` as a fallback.
 */
export function getSupabasePublishableKey(env: EnvMap = process.env): string {
  return (
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    ""
  );
}

/** Server-only secret key (`sb_secret_...` or legacy `service_role` JWT). */
export function getServiceRoleKey(env: EnvMap = process.env): string {
  return env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
}

/** Admin import bearer/header token. */
export function getAdminImportToken(env: EnvMap = process.env): string {
  return env.ADMIN_IMPORT_TOKEN?.trim() || "";
}

/**
 * Redact a secret so its value is never printed: shows only a short prefix and character length.
 */
export function redactSecret(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "(unset, len=0)";
  if (v.startsWith("sb_publishable_")) {
    return `sb_publishable_… (len=${v.length})`;
  }
  if (v.startsWith("sb_secret_")) {
    return `sb_secret_… (len=${v.length})`;
  }
  const prefix = v.slice(0, Math.min(4, v.length));
  return `${prefix}… (len=${v.length})`;
}

/** Generate a cryptographically random 48-character hex token for `ADMIN_IMPORT_TOKEN`. */
export function generateAdminToken(length = 48): string {
  const byteCount = Math.ceil(length / 2);
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex.slice(0, length);
}

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export function isPlaceholder(val: string): boolean {
  return PLACEHOLDER_VALUES.has(val.toLowerCase()) || val.includes("YOUR_KEY") || val.includes("YOUR-PROJECT");
}

const INSECURE_BASIC_PASSWORDS = new Set(["password", "admin", "changeme", "123456"]);

/**
* Returns true ONLY when `NODE_ENV === "development"`.
* Guarantees that dev-only bypasses (`ALLOW_INSECURE_ADMIN_IMPORT`, Basic Auth dev bypass)
* can NEVER be active when `NODE_ENV === "production"`.
*/
export function isDevBypassAllowed(env: EnvMap = process.env): boolean {
  const nodeEnv = (env.NODE_ENV ?? "production").trim();
  if (nodeEnv === "production") return false;
  return nodeEnv === "development";
}

/**
* Fail-closed startup validation for production (`NODE_ENV === "production"`).
* Throws an Error listing missing/invalid variables (never printing secret values) if any of:
* - `NEXT_PUBLIC_SUPABASE_URL`
* - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
* - `SUPABASE_SERVICE_ROLE_KEY`
* - `ADMIN_IMPORT_TOKEN`
* is missing or invalid, or if any dev-only bypass (`ALLOW_INSECURE_ADMIN_IMPORT`, weak Basic Auth defaults)
* is enabled in production.
*/
export function assertProductionEnv(env: EnvMap = process.env): void {
  const nodeEnv = (env.NODE_ENV ?? "").trim();
  if (nodeEnv !== "production") return;

  const errors: string[] = [];

  const pubUrl = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (!pubUrl || isPlaceholder(pubUrl) || !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(pubUrl)) {
    errors.push("NEXT_PUBLIC_SUPABASE_URL is missing or invalid");
  }

  const pubKey = (env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (!pubKey || isPlaceholder(pubKey)) {
    errors.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing or placeholder");
  }

  const srvKey = getServiceRoleKey(env);
  if (!srvKey || isPlaceholder(srvKey)) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY is missing or placeholder");
  } else if (srvKey === pubKey || srvKey.startsWith("sb_publishable_")) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY must not be a publishable key");
  }

  const adminToken = getAdminImportToken(env);
  if (!adminToken || isPlaceholder(adminToken) || adminToken.length < 32) {
    errors.push("ADMIN_IMPORT_TOKEN is missing, placeholder, or shorter than 32 characters");
  }

  const allowInsecure = (env.ALLOW_INSECURE_ADMIN_IMPORT ?? "").trim().toLowerCase();
  if (allowInsecure === "1" || allowInsecure === "true") {
    errors.push("ALLOW_INSECURE_ADMIN_IMPORT cannot be enabled when NODE_ENV=production");
  }

  const basicEnabled = (env.DASHBOARD_BASIC_AUTH_ENABLED ?? "").trim().toLowerCase();
  if (basicEnabled === "1" || basicEnabled === "true") {
    const basicUser = (env.DASHBOARD_BASIC_AUTH_USER ?? "").trim();
    const basicPass = env.DASHBOARD_BASIC_AUTH_PASSWORD ?? "";
    if (!basicUser || !basicPass) {
      errors.push(
        "DASHBOARD_BASIC_AUTH_USER and DASHBOARD_BASIC_AUTH_PASSWORD are required when DASHBOARD_BASIC_AUTH_ENABLED=1",
      );
    } else if (INSECURE_BASIC_PASSWORDS.has(basicPass.trim().toLowerCase())) {
      errors.push("DASHBOARD_BASIC_AUTH_PASSWORD cannot use a default/weak password in production");
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[env] Production environment validation failed (fail-closed): ${errors.join("; ")}`,
    );
  }
}

/**
 * Validate environment variable presence and shape without making network calls.
 */
export function validateEnvShape(env: EnvMap = process.env): CheckItem[] {
  const items: CheckItem[] = [];

  // 1. NEXT_PUBLIC_SUPABASE_URL
  const pubUrl = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const srvUrl = (env.SUPABASE_URL ?? "").trim();
  const effectiveUrl = getSupabaseUrl(env);
  if (!pubUrl) {
    items.push({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      ok: false,
      detail: "(unset)",
      hint: "Set NEXT_PUBLIC_SUPABASE_URL=https://emqooadipseotdbzqtbd.supabase.co in .env.local",
    });
  } else if (!SUPABASE_HTTPS_URL_RE.test(pubUrl) || isPlaceholder(pubUrl)) {
    items.push({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      ok: false,
      detail: pubUrl,
      hint: "URL must match https://<ref>.supabase.co (e.g. https://emqooadipseotdbzqtbd.supabase.co)",
    });
  } else {
    items.push({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      ok: true,
      detail: pubUrl.replace(/\/+$/, ""),
    });
  }

  // 2. SUPABASE_URL (optional, falls back to NEXT_PUBLIC_SUPABASE_URL)
  if (!srvUrl) {
    items.push({
      name: "SUPABASE_URL",
      ok: Boolean(effectiveUrl && SUPABASE_HTTPS_URL_RE.test(effectiveUrl)),
      detail: effectiveUrl ? `fallback -> ${effectiveUrl}` : "(unset, no fallback)",
      hint: effectiveUrl
        ? undefined
        : "Optional override; set NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL=https://<ref>.supabase.co",
    });
  } else if (!SUPABASE_HTTPS_URL_RE.test(srvUrl) || isPlaceholder(srvUrl)) {
    items.push({
      name: "SUPABASE_URL",
      ok: false,
      detail: srvUrl,
      hint: "SUPABASE_URL must match https://<ref>.supabase.co (or omit it to fall back to NEXT_PUBLIC_SUPABASE_URL)",
    });
  } else {
    items.push({
      name: "SUPABASE_URL",
      ok: true,
      detail: srvUrl.replace(/\/+$/, ""),
    });
  }

  // 3. Publishable key (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY first, NEXT_PUBLIC_SUPABASE_ANON_KEY fallback)
  const pubKey = getSupabasePublishableKey(env);
  const pubKeySource = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
    ? "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
    : env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
      ? "NEXT_PUBLIC_SUPABASE_ANON_KEY (fallback)"
      : "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

  if (!pubKey) {
    items.push({
      name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      ok: false,
      detail: redactSecret(pubKey),
      hint: "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... in .env.local (Supabase Dashboard -> Settings -> API Keys)",
    });
  } else if (!pubKey.startsWith("sb_publishable_") || pubKey.length <= "sb_publishable_".length || isPlaceholder(pubKey)) {
    items.push({
      name: pubKeySource,
      ok: false,
      detail: redactSecret(pubKey),
      hint: "Publishable key must start with 'sb_publishable_' and contain your real key from Supabase Dashboard -> Settings -> API Keys",
    });
  } else {
    items.push({
      name: pubKeySource,
      ok: true,
      detail: redactSecret(pubKey),
    });
  }

  // 4. SUPABASE_SERVICE_ROLE_KEY (accepts sb_secret_... or service_role key; must differ from publishable key)
  const srvKey = getServiceRoleKey(env);
  if (!srvKey || isPlaceholder(srvKey)) {
    items.push({
      name: "SUPABASE_SERVICE_ROLE_KEY",
      ok: false,
      detail: redactSecret(srvKey),
      hint: "Set SUPABASE_SERVICE_ROLE_KEY=sb_secret_... in .env.local (Supabase Dashboard -> Settings -> API Keys)",
    });
  } else if (srvKey === pubKey || srvKey.startsWith("sb_publishable_")) {
    items.push({
      name: "SUPABASE_SERVICE_ROLE_KEY",
      ok: false,
      detail: redactSecret(srvKey),
      hint: "SUPABASE_SERVICE_ROLE_KEY must be your secret/service key (e.g. sb_secret_...) and must differ from the publishable key",
    });
  } else {
    items.push({
      name: "SUPABASE_SERVICE_ROLE_KEY",
      ok: true,
      detail: redactSecret(srvKey),
    });
  }

  // 5. ADMIN_IMPORT_TOKEN (>= 32 chars)
  const adminToken = getAdminImportToken(env);
  if (!adminToken || isPlaceholder(adminToken)) {
    items.push({
      name: "ADMIN_IMPORT_TOKEN",
      ok: false,
      detail: redactSecret(adminToken),
      hint: "Generate a token with `pnpm gen-token` and set ADMIN_IMPORT_TOKEN in .env.local (must be >= 32 chars)",
    });
  } else if (adminToken.length < 32) {
    items.push({
      name: "ADMIN_IMPORT_TOKEN",
      ok: false,
      detail: redactSecret(adminToken),
      hint: `ADMIN_IMPORT_TOKEN is too short (len=${adminToken.length}, required >= 32). Run \`pnpm gen-token\` to generate a 48-char token`,
    });
  } else {
    items.push({
      name: "ADMIN_IMPORT_TOKEN",
      ok: true,
      detail: redactSecret(adminToken),
    });
  }

  return items;
}

/**
 * Classify a Supabase / PostgREST / Storage error into an actionable operator hint.
 */
export function explainSupabaseError(err: { code?: string; message?: string; status?: number } | null | undefined): {
  reason: "migrations_not_applied" | "wrong_key" | "network_or_other";
  hint: string;
} {
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  const lower = msg.toLowerCase();

  if (
    code === "42P01" ||
    code === "PGRST205" ||
    lower.includes("does not exist") ||
    lower.includes("could not find the table") ||
    lower.includes("schema cache")
  ) {
    return {
      reason: "migrations_not_applied",
      hint: "Migrations not applied. Run: supabase link --project-ref emqooadipseotdbzqtbd && supabase db push",
    };
  }

  if (
    err?.status === 401 ||
    err?.status === 403 ||
    code === "42501" ||
    lower.includes("invalid api key") ||
    lower.includes("jwt") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("permission denied") ||
    lower.includes("row-level security") ||
    lower.includes("secret api key")
  ) {
    return {
      reason: "wrong_key",
      hint: "Wrong key or insufficient privileges. Check SUPABASE_SERVICE_ROLE_KEY in .env.local (use sb_secret_... or service_role key, not the publishable key)",
    };
  }

  return {
    reason: "network_or_other",
    hint: `Check network connectivity, SUPABASE_URL, and migrations (supabase db push). Raw error: ${msg || "unknown"}`,
  };
}

export interface SupabaseProbeClient {
  selectDevices(): Promise<{ count: number; error?: { code?: string; message?: string; status?: number } | null }>;
  listBuckets(): Promise<{
    buckets: { id: string; name: string; public?: boolean }[];
    error?: { code?: string; message?: string; status?: number } | null;
  }>;
}

export function createSupabaseProbe(db: SupabaseClient): SupabaseProbeClient {
  return {
    async selectDevices() {
      const { data, error } = await db.from("devices").select("id").limit(1);
      return { count: data?.length ?? 0, error };
    },
    async listBuckets() {
      const { data, error } = await db.storage.listBuckets();
      return { buckets: (data ?? []) as { id: string; name: string; public?: boolean }[], error };
    },
  };
}

export const REQUIRED_BUCKETS = ["snapshots", "reports"] as const;

/**
 * Full environment + live Supabase check (`pnpm check-env`).
 */
export async function runEnvCheck(options?: {
  env?: EnvMap;
  probe?: SupabaseProbeClient;
}): Promise<{ ok: boolean; items: CheckItem[] }> {
  const env = options?.env ?? process.env;
  const items = validateEnvShape(env);

  const urlOk = items.find((i) => i.name === "NEXT_PUBLIC_SUPABASE_URL")?.ok &&
    items.find((i) => i.name === "SUPABASE_URL")?.ok;
  const srvKeyOk = items.find((i) => i.name === "SUPABASE_SERVICE_ROLE_KEY")?.ok;

  if (!urlOk || !srvKeyOk) {
    items.push({
      name: "db: select from devices",
      ok: false,
      detail: "skipped (fix URL / SUPABASE_SERVICE_ROLE_KEY first)",
      hint: "Fix the environment variable errors above and re-run `pnpm check-env`",
    });
    for (const b of REQUIRED_BUCKETS) {
      items.push({
        name: `storage bucket: ${b}`,
        ok: false,
        detail: "skipped (fix URL / SUPABASE_SERVICE_ROLE_KEY first)",
        hint: "Fix the environment variable errors above and re-run `pnpm check-env`",
      });
    }
    return { ok: false, items };
  }

  const probe =
    options?.probe ??
    createSupabaseProbe(
      createClient(getSupabaseUrl(env), getServiceRoleKey(env), {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );

  // 1. Probe `devices` table
  try {
    const devRes = await probe.selectDevices();
    if (devRes.error) {
      const { hint } = explainSupabaseError(devRes.error);
      items.push({
        name: "db: select from devices",
        ok: false,
        detail: devRes.error.message || "query failed",
        hint,
      });
    } else {
      items.push({
        name: "db: select from devices",
        ok: true,
        detail: "table reachable",
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { hint } = explainSupabaseError({ message: msg });
    items.push({
      name: "db: select from devices",
      ok: false,
      detail: msg,
      hint,
    });
  }

  // 2. Probe storage buckets (`snapshots`, `reports`)
  try {
    const bRes = await probe.listBuckets();
    if (bRes.error) {
      const { hint } = explainSupabaseError(bRes.error);
      for (const b of REQUIRED_BUCKETS) {
        items.push({
          name: `storage bucket: ${b}`,
          ok: false,
          detail: bRes.error.message || "listBuckets failed",
          hint,
        });
      }
    } else {
      const byId = new Map(bRes.buckets.map((b) => [b.id || b.name, b]));
      for (const b of REQUIRED_BUCKETS) {
        const found = byId.get(b);
        if (!found) {
          items.push({
            name: `storage bucket: ${b}`,
            ok: false,
            detail: "missing",
            hint: `Bucket "${b}" does not exist. Run \`supabase db push\` (migration 20261028000002 creates it) or create a private bucket named "${b}" in Supabase Dashboard -> Storage`,
          });
        } else if (found.public) {
          items.push({
            name: `storage bucket: ${b}`,
            ok: false,
            detail: "bucket is public (must be private)",
            hint: `Bucket "${b}" must be private (public=false). Run \`supabase db push\` or set it to private in Supabase Dashboard -> Storage`,
          });
        } else {
          items.push({
            name: `storage bucket: ${b}`,
            ok: true,
            detail: "present (private)",
          });
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { hint } = explainSupabaseError({ message: msg });
    for (const b of REQUIRED_BUCKETS) {
      items.push({
        name: `storage bucket: ${b}`,
        ok: false,
        detail: msg,
        hint,
      });
    }
  }

  return { ok: items.every((i) => i.ok), items };
}

export function formatEnvCheckReport(items: readonly CheckItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const tag = item.ok ? "OK  " : "FAIL";
    lines.push(`[${tag}] ${item.name}: ${item.detail}`);
    if (!item.ok && item.hint) {
      lines.push(`       Hint: ${item.hint}`);
    }
  }
  return lines.join("\n");
}
