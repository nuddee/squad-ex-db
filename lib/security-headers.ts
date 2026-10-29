import type { EnvMap } from "@/lib/env";

export interface HttpHeaderEntry {
  key: string;
  value: string;
}

/**
 * Build the Content-Security-Policy header value.
 * - Allows own origin (`'self'`)
 * - Allows Supabase HTTPS & WebSocket origins (`https://*.supabase.co`, `wss://*.supabase.co`,
 *   plus the configured `NEXT_PUBLIC_SUPABASE_URL` if it uses a custom/local host) for `connect-src` and `img-src`
 * - Allows `data:` and `blob:` for `img-src`
 * - Disallows framing (`frame-ancestors 'none'`)
 */
export function buildContentSecurityPolicy(env: EnvMap = process.env): string {
  const isDev = (env.NODE_ENV ?? "").trim() === "development";
  const connectSources = new Set<string>([
    "'self'",
    "https://*.supabase.co",
    "wss://*.supabase.co",
  ]);
  const imgSources = new Set<string>([
    "'self'",
    "data:",
    "blob:",
    "https://*.supabase.co",
  ]);

  const rawSupabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "").trim();
  if (rawSupabaseUrl) {
    try {
      const parsed = new URL(rawSupabaseUrl);
      const origin = parsed.origin;
      connectSources.add(origin);
      imgSources.add(origin);
      const wsOrigin =
        parsed.protocol === "https:"
          ? `wss://${parsed.host}`
          : parsed.protocol === "http:"
            ? `ws://${parsed.host}`
            : null;
      if (wsOrigin) connectSources.add(wsOrigin);
    } catch {
      // Ignore malformed URL in CSP builder; assertProductionEnv catches invalid URLs in production
    }
  }

  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${[...imgSources].join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${[...connectSources].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  return directives.join("; ");
}

/**
 * Full list of HTTP security headers applied to all routes via `next.config.ts`.
 */
export function buildSecurityHeaders(env: EnvMap = process.env): HttpHeaderEntry[] {
  return [
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(env),
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()",
    },
    {
      key: "X-Frame-Options",
      value: "DENY",
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
  ];
}
