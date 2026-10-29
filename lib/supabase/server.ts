import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getPublicSupabaseUrl, getSupabasePublishableKey, type EnvMap } from "@/lib/env";

/**
 * Server Component / Route Handler Supabase client backed by Next.js `cookies()`.
 */
export async function createSupabaseServerClient(
  env: EnvMap = process.env,
): Promise<SupabaseClient | null> {
  const url = getPublicSupabaseUrl(env);
  const key = getSupabasePublishableKey(env);
  if (!url || !key) return null;

  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where setting cookies is a no-op (handled by proxy.ts)
        }
      },
    },
  });
}

/**
 * Request-scoped Supabase SSR client that reads cookies directly from a `Request`'s `Cookie` header.
 * Works in Route Handlers even when invoked directly in unit tests without Next.js `AsyncLocalStorage`.
 */
export function createSupabaseRequestClient(
  req: Request,
  env: EnvMap = process.env,
  onSetCookies?: (serializedCookies: string[]) => void,
): SupabaseClient | null {
  const url = getPublicSupabaseUrl(env);
  const key = getSupabasePublishableKey(env);
  if (!url || !key) return null;

  const rawCookie = req.headers.get("cookie") ?? "";
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return parseCookieHeader(rawCookie).map((c) => ({
          name: c.name,
          value: c.value ?? "",
        }));
      },
      setAll(cookiesToSet) {
        if (onSetCookies) {
          onSetCookies(
            cookiesToSet.map(({ name, value, options }) =>
              serializeCookieHeader(name, value, options),
            ),
          );
        }
      },
    },
  });
}
