import { NextResponse } from "next/server";
import { enforceOptionalBasicAuth } from "@/lib/auth/basic-auth";
import type { EnvMap } from "@/lib/env";
import { rateLimit } from "@/lib/ingest/rate-limit";
import { createSupabaseRequestClient } from "@/lib/supabase/server";

export type UserRole = "admin" | "viewer";
export type RawProfileRole = "admin" | "viewer" | "operator";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  rawRole: RawProfileRole;
}

export type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: Response };

export interface ResolvedSessionCandidate {
  id: string;
  email?: string | null;
  rawRole?: string | null;
  disabled?: boolean;
}

export interface SessionCheckDeps {
  env?: EnvMap;
  /** Optional hook for deterministic unit tests; when omitted, verifies session via Supabase Auth SSR client. */
  resolveUser?: (req: Request) => Promise<ResolvedSessionCandidate | null>;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function normalizeRole(raw: unknown): {
  role: UserRole;
  rawRole: RawProfileRole;
} {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "admin") {
    return { role: "admin", rawRole: "admin" };
  }
  if (v === "operator") {
    return { role: "viewer", rawRole: "operator" };
  }
  return { role: "viewer", rawRole: "viewer" };
}

/**
 * CSRF protection for session-authenticated state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`).
 * Verifies that the `Origin` header (or `Referer` fallback) matches the target request's host.
 */
export function verifySameOrigin(req: Request): Response | null {
  const method = (req.method ?? "GET").toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) {
    return null;
  }

  let expectedHost = "";
  try {
    expectedHost = (
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host") ||
      new URL(req.url).host
    )
      .split(",")[0]!
      .trim()
      .toLowerCase();
  } catch {
    return NextResponse.json(
      { error: "csrf_origin_mismatch", message: "Invalid request target URL." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const originHeader = req.headers.get("origin")?.trim();
  const refererHeader = req.headers.get("referer")?.trim();

  if (originHeader) {
    if (originHeader === "null") {
      return NextResponse.json(
        {
          error: "csrf_origin_mismatch",
          message: "Cross-origin state-changing request rejected.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      const originHost = new URL(originHeader).host.toLowerCase();
      if (originHost !== expectedHost) {
        return NextResponse.json(
          {
            error: "csrf_origin_mismatch",
            message: "Cross-origin state-changing request rejected.",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return null;
    } catch {
      return NextResponse.json(
        {
          error: "csrf_origin_mismatch",
          message: "Invalid Origin header.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  if (refererHeader) {
    try {
      const refererHost = new URL(refererHeader).host.toLowerCase();
      if (refererHost !== expectedHost) {
        return NextResponse.json(
          {
            error: "csrf_origin_mismatch",
            message: "Cross-origin state-changing request rejected.",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return null;
    } catch {
      return NextResponse.json(
        {
          error: "csrf_origin_mismatch",
          message: "Invalid Referer header.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  return NextResponse.json(
    {
      error: "csrf_origin_mismatch",
      message: "Missing Origin header on state-changing request.",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

async function resolveSupabaseRequestUser(
  req: Request,
  env: EnvMap = process.env,
): Promise<ResolvedSessionCandidate | null> {
  const supabase = createSupabaseRequestClient(req, env);
  if (!supabase) return null;

  const { data: userRes, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userRes?.user) {
    return null;
  }

  const authUser = userRes.user;
  const bannedUntil = (authUser as { banned_until?: string | null }).banned_until;
  const isBanned =
    Boolean(bannedUntil) &&
    Number.isFinite(Date.parse(String(bannedUntil))) &&
    Date.parse(String(bannedUntil)) > Date.now();
  const metaDisabled = Boolean(
    (authUser.app_metadata as Record<string, unknown> | undefined)?.disabled,
  );
  const metaRole =
    typeof (authUser.app_metadata as Record<string, unknown> | undefined)?.role ===
    "string"
      ? String((authUser.app_metadata as Record<string, unknown>).role)
      : null;

  // Read own profile via user's authenticated client (allowed by `read_own_profile` RLS policy;
  // never calls serviceClient() before authentication succeeds).
  let profile: SessionProfile | null = null;

  const { data: profData, error: profErr } = await supabase
    .from("profiles")
    .select("role,disabled_at")
    .eq("user_id", authUser.id)
    .maybeSingle();

  if (profErr) {
    // Fallback if the `disabled_at` column migration has not been pushed yet
    const { data: fallbackProf } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", authUser.id)
      .maybeSingle();
    if (fallbackProf) {
      profile = {
        role: (fallbackProf as { role?: string | null }).role ?? null,
        disabled_at: null,
      };
    }
  } else if (profData) {
    profile = profData as SessionProfile;
  }

  return buildSessionCandidate({
    id: authUser.id,
    email: authUser.email ?? "",
    isBanned,
    metaDisabled,
    metaRole,
    profile,
  });
}

export interface SessionProfile {
  role?: string | null;
  disabled_at?: string | null;
}

/**
 * Combine Auth-user facts with the caller's own `profiles` row into a session candidate.
 * FAIL CLOSED: a missing profile row counts as disabled. Since migration 010 the `read_own_profile`
 * RLS policy hides a disabled user's own row, so "no row" is exactly what a disabled user sees.
 * The profile role is authoritative when present (matches `public.is_admin()` in the DB).
 */
export function buildSessionCandidate(input: {
  id: string;
  email: string;
  isBanned: boolean;
  metaDisabled: boolean;
  metaRole: string | null;
  profile: SessionProfile | null;
}): ResolvedSessionCandidate {
  const { profile } = input;
  return {
    id: input.id,
    email: input.email,
    rawRole: profile?.role ?? input.metaRole ?? "viewer",
    disabled:
      input.isBanned ||
      input.metaDisabled ||
      profile === null ||
      Boolean(profile.disabled_at),
  };
}

/**
 * Require a valid, non-disabled logged-in Supabase user session.
 * Also enforces optional Basic Auth (when `DASHBOARD_BASIC_AUTH_ENABLED=1`) and
 * CSRF same-origin verification on state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`).
 *
 * Must be called BEFORE `serviceClient()` in every dashboard route handler.
 */
export async function requireUser(
  req: Request,
  deps: SessionCheckDeps = {},
): Promise<AuthResult> {
  const basicDenied = enforceOptionalBasicAuth(req, deps.env);
  if (basicDenied) {
    return { ok: false, response: basicDenied };
  }

  const csrfDenied = verifySameOrigin(req);
  if (csrfDenied) {
    return { ok: false, response: csrfDenied };
  }

  const resolver =
    deps.resolveUser ?? ((r: Request) => resolveSupabaseRequestUser(r, deps.env));
  const candidate = await resolver(req);

  if (!candidate || !candidate.id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unauthorized", message: "Authentication required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  if (candidate.disabled) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "account_disabled", message: "Your account has been disabled." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  const { role, rawRole } = normalizeRole(candidate.rawRole);
  return {
    ok: true,
    user: {
      id: candidate.id,
      email: candidate.email ?? "",
      role,
      rawRole,
    },
  };
}

/**
 * Require a logged-in user with the `admin` role.
 * Returns `401` if unauthenticated or `403` if authenticated as a `viewer`/`operator`.
 *
 * Must be called BEFORE `serviceClient()` in every admin route handler.
 */
export async function requireAdmin(
  req: Request,
  deps: SessionCheckDeps = {},
): Promise<AuthResult> {
  const res = await requireUser(req, deps);
  if (!res.ok) return res;

  if (res.user.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "forbidden",
          message: "Administrator privileges required.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const rl = rateLimit(`admin:${res.user.id}`, { capacity: 60, refillPerSec: 1 });
    if (!rl.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "rate_limited",
            message: "Too many administrative requests. Please retry shortly.",
          },
          {
            status: 429,
            headers: {
              "Cache-Control": "no-store",
              "Retry-After": String(rl.retryAfterS),
            },
          },
        ),
      };
    }
  }

  return res;
}
