import type { SupabaseClient } from "@supabase/supabase-js";
import { generateDeviceKey, sha256Hex } from "@/lib/ingest/auth";

export interface DeviceAdminItem {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
}

export interface CreatedDeviceOnceResult {
  device: DeviceAdminItem;
  /** Plaintext device key returned ONCE upon creation; only its SHA-256 hex is stored in the DB. */
  api_key: string;
}

export function validateDeviceName(rawName: unknown): {
  ok: boolean;
  name?: string;
  message?: string;
} {
  if (typeof rawName !== "string") {
    return { ok: false, message: "Device name must be a string." };
  }
  const name = rawName.trim();
  if (name.length < 1 || name.length > 80) {
    return { ok: false, message: "Device name must be between 1 and 80 characters." };
  }
  if (/[\0-\x1f\x7f]/.test(name)) {
    return { ok: false, message: "Device name must not contain control characters." };
  }
  return { ok: true, name };
}

/**
 * List all devices for the Admin UI without ever selecting or returning `api_key_hash`.
 */
export async function listAdminDevices(db: SupabaseClient): Promise<DeviceAdminItem[]> {
  const { data, error } = await db
    .from("devices")
    .select("id,name,created_at,revoked_at,last_seen_at")
    .order("created_at", { ascending: false });

  if (error) {
    // Graceful fallback if `last_seen_at` migration has not been pushed yet
    const { data: fallbackData, error: fallbackErr } = await db
      .from("devices")
      .select("id,name,created_at,revoked_at")
      .order("created_at", { ascending: false });
    if (fallbackErr) {
      throw new Error(`devices select: ${fallbackErr.message}`);
    }
    return ((fallbackData ?? []) as Omit<DeviceAdminItem, "last_seen_at">[]).map((d) => ({
      ...d,
      last_seen_at: null,
    }));
  }

  return (data ?? []) as DeviceAdminItem[];
}

/**
 * Create a new device: stores only `sha256Hex(apiKey)` in `public.devices` and returns `api_key` ONCE.
 */
export async function createAdminDevice(
  db: SupabaseClient,
  rawName: unknown,
): Promise<CreatedDeviceOnceResult> {
  const v = validateDeviceName(rawName);
  if (!v.ok || !v.name) {
    throw new Error(v.message ?? "Invalid device name.");
  }

  const apiKey = generateDeviceKey();
  const apiKeyHash = sha256Hex(apiKey);

  const { data, error } = await db
    .from("devices")
    .insert({ name: v.name, api_key_hash: apiKeyHash })
    .select("id,name,created_at,revoked_at")
    .single();

  if (error || !data) {
    throw new Error(`devices insert: ${error?.message ?? "no row returned"}`);
  }

  const row = data as Omit<DeviceAdminItem, "last_seen_at">;
  return {
    device: {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      revoked_at: row.revoked_at ?? null,
      last_seen_at: null,
    },
    api_key: apiKey,
  };
}

/**
 * Revoke a device by setting `revoked_at = now()`.
 */
export async function revokeAdminDevice(
  db: SupabaseClient,
  deviceId: string,
): Promise<DeviceAdminItem | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("devices")
    .update({ revoked_at: nowIso })
    .eq("id", deviceId)
    .select("id,name,created_at,revoked_at")
    .maybeSingle();

  if (error) {
    throw new Error(`devices revoke: ${error.message}`);
  }
  if (!data) return null;

  const row = data as Omit<DeviceAdminItem, "last_seen_at">;
  return {
    ...row,
    last_seen_at: null,
  };
}
