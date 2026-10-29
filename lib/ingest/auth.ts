import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Device {
  id: string;
  name: string;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** New device key: shown once to the operator; only its SHA-256 is stored. */
export function generateDeviceKey(): string {
  return `agv_${randomBytes(32).toString("base64url")}`;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}

const LAST_SEEN_THROTTLE_MS = 60_000;
const lastSeenWriteAt = new Map<string, number>();

export function _resetLastSeenThrottle(): void {
  lastSeenWriteAt.clear();
}

/** Looks up a non-revoked device by the SHA-256 of its bearer key, and updates last_seen_at (throttled 1/min). */
export async function authenticateDevice(db: SupabaseClient, req: Request): Promise<Device | null> {
  const token = bearerToken(req);
  if (!token || token.length > 200) return null;
  const { data, error } = await db
    .from("devices")
    .select("id,name,revoked_at")
    .eq("api_key_hash", sha256Hex(token))
    .maybeSingle();
  if (error) throw new Error(`devices select: ${error.message}`);
  if (!data || data.revoked_at) return null;

  const id = data.id as string;
  const now = Date.now();
  if (now - (lastSeenWriteAt.get(id) ?? 0) >= LAST_SEEN_THROTTLE_MS) {
    lastSeenWriteAt.set(id, now);
    void Promise.resolve(db.from("devices").update({ last_seen_at: new Date(now).toISOString() }).eq("id", id)).catch(() => {
      // best-effort telemetry; never fail device auth if last_seen_at update fails
    });
  }

  return { id, name: data.name as string };
}
