/**
 * Manage device keys.
 *   pnpm create-device <name>            create a device, print its key ONCE (only the SHA-256 is stored)
 *   pnpm create-device --revoke <name>   revoke every non-revoked device with that name
 * Rotation: create a new device (e.g. "jetson-1-v2"), put its key in edge-sync, then revoke the old one.
 */
import { explainSupabaseError, getServiceRoleKey, getSupabaseUrl, isPlaceholder, loadEnvLocalIfNeeded } from "../lib/env";
import { generateDeviceKey, sha256Hex } from "../lib/ingest/auth";
import { serviceClient } from "../lib/ingest/store-supabase";

export async function runCreateDevice(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadEnvLocalIfNeeded();

  const revoke = args[0] === "--revoke";
  const name = (revoke ? args[1] : args[0])?.trim();
  if (!name) {
    console.error("usage: pnpm create-device <name> | pnpm create-device --revoke <name>");
    process.exit(2);
  }

  const url = getSupabaseUrl();
  const key = getServiceRoleKey();
  if (!url || !key || isPlaceholder(url) || isPlaceholder(key)) {
    throw new Error(
      "Missing or placeholder environment variables (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). " +
        "Copy .env.example to .env.local, fill in your keys, and run `pnpm check-env`.",
    );
  }

  const db = serviceClient();
  if (revoke) {
    const { data, error } = await db
      .from("devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("name", name)
      .is("revoked_at", null)
      .select("id");
    if (error) {
      const { hint } = explainSupabaseError(error);
      throw new Error(`Failed to revoke device "${name}": ${error.message}\nHint: ${hint}`);
    }
    console.log(`revoked ${data?.length ?? 0} device(s) named "${name}"`);
    return;
  }

  const deviceKey = generateDeviceKey();
  const { data, error } = await db
    .from("devices")
    .insert({ name, api_key_hash: sha256Hex(deviceKey) })
    .select("id")
    .single();
  if (error) {
    const { hint } = explainSupabaseError(error);
    throw new Error(`Failed to create device "${name}": ${error.message}\nHint: ${hint}`);
  }
  console.log(`device "${name}" created (id ${data.id})`);
  console.log(`AGRIVISION_DEVICE_KEY=${deviceKey}`);
  console.log("Store this key now; it cannot be shown again.");
}

if (require.main === module) {
  runCreateDevice().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
