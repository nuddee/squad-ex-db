import { isDevBypassAllowed, type EnvMap } from "@/lib/env";

export type BasicAuthDecision =
  | { ok: true; status: 200; mode: "authenticated" | "dev_bypass" }
  | {
      ok: false;
      status: 401 | 503;
      error: "unauthorized" | "access_gate_unconfigured";
      message: string;
    };

/**
 * Constant-time comparison of two UTF-8 strings over equal-length padded byte buffers.
 * Never short-circuits on length or prefix mismatch.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  const maxLen = Math.max(aBuf.length, bBuf.length, 1);

  const aPadded = new Uint8Array(maxLen);
  const bPadded = new Uint8Array(maxLen);
  aPadded.set(aBuf);
  bPadded.set(bBuf);

  let diff = aBuf.length ^ bBuf.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= aPadded[i]! ^ bPadded[i]!;
  }
  return diff === 0;
}

function decodeBase64Utf8(b64: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(b64, "base64").toString("utf8");
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Determine whether a request pathname is covered by the pre-Phase-7 Dashboard Basic Auth gate.
 * Protects all UI pages (`/`, `/batches`, `/admin/import`, etc.) and `/api/batches*`.
 * Leaves `/api/ingest/*` (device Bearer auth), `/api/admin/import` (ADMIN_IMPORT_TOKEN),
 * `/api/health`, and Next.js static assets untouched.
 */
export function shouldProtectWithDashboardGate(pathname: string): boolean {
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/ingest/") ||
    pathname === "/api/admin/import" ||
    pathname.startsWith("/api/admin/import/")
  ) {
    return false;
  }
  if (pathname.startsWith("/api/")) {
    return pathname === "/api/batches" || pathname.startsWith("/api/batches/");
  }
  return true;
}

/**
 * Evaluate Basic Auth credentials against DASHBOARD_BASIC_AUTH_USER / DASHBOARD_BASIC_AUTH_PASSWORD.
 * - Fails closed (503) when credentials are unset unless NODE_ENV === "development".
 * - Uses constant-time comparison for both username and password.
 */
export function evaluateDashboardBasicAuth(
  authHeader: string | null | undefined,
  env: EnvMap = process.env,
): BasicAuthDecision {
  const expectedUser = (env.DASHBOARD_BASIC_AUTH_USER ?? "").trim();
  const expectedPass = env.DASHBOARD_BASIC_AUTH_PASSWORD ?? "";
  const nodeEnv = (env.NODE_ENV ?? "production").trim();

  if (!expectedUser || !expectedPass) {
    if (isDevBypassAllowed({ NODE_ENV: nodeEnv })) {
      return { ok: true, status: 200, mode: "dev_bypass" };
    }
    return {
      ok: false,
      status: 503,
      error: "access_gate_unconfigured",
      message:
        "Dashboard access gate is not configured. Set DASHBOARD_BASIC_AUTH_USER and DASHBOARD_BASIC_AUTH_PASSWORD.",
    };
  }

  const raw = (authHeader ?? "").trim();
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(raw);
  if (!match || !match[1]) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Basic authentication required.",
    };
  }

  const decoded = decodeBase64Utf8(match[1]);
  if (decoded === null) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid Basic authentication header.",
    };
  }

  const colonIdx = decoded.indexOf(":");
  const givenUser = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
  const givenPass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";

  // Run both constant-time checks unconditionally (no short-circuit &&)
  const userOk = constantTimeEqual(givenUser, expectedUser);
  const passOk = constantTimeEqual(givenPass, expectedPass);
  const hasColon = colonIdx >= 0;

  if (hasColon && userOk && passOk) {
    return { ok: true, status: 200, mode: "authenticated" };
  }

  return {
    ok: false,
    status: 401,
    error: "unauthorized",
    message: "Invalid username or password.",
  };
}

/**
 * Enforce the dashboard Basic Auth gate on a Request, returning a 401/503 Response on failure or null when allowed.
 */
export function enforceDashboardBasicAuth(
  req: Request,
  env: EnvMap = process.env,
): Response | null {
  const decision = evaluateDashboardBasicAuth(req.headers.get("authorization"), env);
  if (decision.ok) return null;

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (decision.status === 401) {
    headers.set("WWW-Authenticate", 'Basic realm="AgriVision QC", charset="UTF-8"');
  }

  return new Response(
    JSON.stringify({ error: decision.error, message: decision.message }),
    { status: decision.status, headers },
  );
}

/**
 * In Phase 7+, Basic Auth is an optional perimeter layer controlled by `DASHBOARD_BASIC_AUTH_ENABLED=1` (default off).
 */
export function isBasicAuthEnabled(env: EnvMap = process.env): boolean {
  const flag = (env.DASHBOARD_BASIC_AUTH_ENABLED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * Enforce Basic Auth ONLY when `DASHBOARD_BASIC_AUTH_ENABLED=1` (or `true`).
 */
export function enforceOptionalBasicAuth(
  req: Request,
  env: EnvMap = process.env,
): Response | null {
  if (!isBasicAuthEnabled(env)) return null;
  return enforceDashboardBasicAuth(req, env);
}
