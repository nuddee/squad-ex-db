"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

/**
 * Browser Supabase client (`@supabase/ssr`) for Auth and Realtime subscriptions.
 * Shares session cookies with Next.js Server Components, Route Handlers, and `proxy.ts`,
 * and automatically syncs the user's JWT access token to Supabase Realtime so `postgres_changes`
 * events arrive under the `authenticated` RLS role.
 *
 * Reads NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY first, then NEXT_PUBLIC_SUPABASE_ANON_KEY as fallback.
 */
export function getBrowserSupabaseClient(): SupabaseClient | null {
  if (browserClient) return browserClient;
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  ).trim();
  if (!url || !key || url.includes("YOUR-PROJECT") || key.includes("YOUR_KEY")) {
    return null;
  }
  try {
    const client = createBrowserClient(url, key);
    client.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        client.realtime.setAuth(session.access_token);
      }
    });
    void client.auth.getSession().then(({ data }) => {
      if (data.session?.access_token) {
        client.realtime.setAuth(data.session.access_token);
      }
    });
    browserClient = client;
    return browserClient;
  } catch {
    return null;
  }
}
