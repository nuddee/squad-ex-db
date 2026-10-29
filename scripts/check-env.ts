/**
 * Validate .env.local variables and probe the live Supabase project (`devices` table + `snapshots`/`reports` buckets).
 * Never prints secret values (only a redacted prefix and character length).
 *
 *   pnpm check-env
 */
import { formatEnvCheckReport, loadEnvLocalIfNeeded, runEnvCheck } from "../lib/env";

async function main() {
  const loaded = loadEnvLocalIfNeeded();
  console.log(loaded ? "Loaded .env.local" : "Warning: .env.local not found (checking current process.env)");
  console.log("");

  const { ok, items } = await runEnvCheck();
  console.log(formatEnvCheckReport(items));
  console.log("");

  if (!ok) {
    console.error("Environment check FAILED. Fix the [FAIL] items above and re-run `pnpm check-env`.");
    process.exit(1);
  }
  console.log("All environment and Supabase checks passed (OK).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
