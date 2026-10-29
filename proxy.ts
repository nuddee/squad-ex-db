import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  enforceOptionalBasicAuth,
  shouldProtectWithDashboardGate,
} from "@/lib/auth/basic-auth";
import { getPublicSupabaseUrl, getSupabasePublishableKey } from "@/lib/env";

function isPublicOrMachineApiRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/ingest/")
  );
}

function isAdminOnlyPage(pathname: string): boolean {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  );
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublicOrMachineApiRoute(pathname)) {
    return NextResponse.next();
  }

  // Optional Basic Auth perimeter layer (default off unless DASHBOARD_BASIC_AUTH_ENABLED=1)
  if (shouldProtectWithDashboardGate(pathname)) {
    const basicDenied = enforceOptionalBasicAuth(req);
    if (basicDenied) return basicDenied;
  }

  // Allow token-authenticated CLI / machine calls to /api/admin/import to proceed directly to route handler
  if (
    (pathname === "/api/admin/import" || pathname.startsWith("/api/admin/import/")) &&
    (req.headers.get("x-admin-token")?.trim() ||
      /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? ""))
  ) {
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: {
      headers: req.headers,
    },
  });

  const url = getPublicSupabaseUrl();
  const key = getSupabasePublishableKey();
  if (!url || !key) {
    // If Supabase env is missing, redirect UI pages to /login and let API route handlers return 401
    if (!pathname.startsWith("/api/") && pathname !== "/login") {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          req.cookies.set(name, value);
        }
        response = NextResponse.next({
          request: {
            headers: req.headers,
          },
        });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data: userRes } = await supabase.auth.getUser();
  const authUser = userRes?.user ?? null;

  // API routes enforce their own strict requireUser() / requireAdmin() check inside the route handler
  if (pathname.startsWith("/api/")) {
    return response;
  }

  if (pathname === "/login") {
    if (authUser) {
      const dest = req.nextUrl.clone();
      dest.pathname = "/";
      dest.search = "";
      return NextResponse.redirect(dest);
    }
    return response;
  }

  if (!authUser) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Optimistic admin role check for /settings and /admin/* pages
  if (isAdminOnlyPage(pathname)) {
    const metaRole =
      typeof (authUser.app_metadata as Record<string, unknown> | undefined)?.role ===
      "string"
        ? String((authUser.app_metadata as Record<string, unknown>).role)
        : null;

    let isAdmin = metaRole === "admin";
    if (!isAdmin) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", authUser.id)
        .maybeSingle();
      if ((prof as { role?: string } | null)?.role === "admin") {
        isAdmin = true;
      }
    }

    if (!isAdmin) {
      const homeUrl = req.nextUrl.clone();
      homeUrl.pathname = "/";
      homeUrl.search = "?error=admin_required";
      return NextResponse.redirect(homeUrl);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
