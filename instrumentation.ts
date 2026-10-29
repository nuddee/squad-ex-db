import { assertProductionEnv } from "@/lib/env";

/**
 * Next.js Server Startup Hook (`instrumentation.ts`).
 * Validates required environment variables at server boot in production (`NODE_ENV=production`)
 * and fails closed if any required key (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
 * `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_IMPORT_TOKEN`) is missing or if dev-only bypasses are active.
 */
export function register(): void {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    assertProductionEnv(process.env);
  }
}
