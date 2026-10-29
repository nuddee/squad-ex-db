import type { SupabaseClient } from "@supabase/supabase-js";

/** ~100 years: effectively permanent until an admin re-enables the user. */
export const DISABLE_BAN_DURATION = "876000h";

export interface SetUserDisabledResult {
  /** Number of auth sessions deleted, or null when the revoke RPC failed (see `revokeError`). */
  sessionsRevoked: number | null;
  revokeError: string | null;
}

/**
 * Disable or re-enable a user so they lose ALL access:
 *  1. Auth ban (`ban_duration`): blocks sign-in and refresh-token use; re-enable lifts it (`none`).
 *  2. `profiles.disabled_at`: makes `is_active_user()` false, so every RLS read policy (and Realtime) denies.
 *  3. On disable only: `revoke_user_sessions()` deletes the user's `auth.sessions` (and cascaded refresh tokens),
 *     so existing access tokens stop validating at `auth.getUser()`.
 * Never touches roles. Throws on ban/profile failure; revoke failure is reported, not hidden.
 */
export async function setUserDisabled(
  db: SupabaseClient,
  userId: string,
  disabled: boolean,
  nowIso: string = new Date().toISOString(),
): Promise<SetUserDisabledResult> {
  const { error: banErr } = await db.auth.admin.updateUserById(userId, {
    ban_duration: disabled ? DISABLE_BAN_DURATION : "none",
    app_metadata: { disabled },
  });
  if (banErr) throw new Error(`auth.admin.updateUserById: ${banErr.message}`);

  const { error: profErr } = await db
    .from("profiles")
    .upsert({ user_id: userId, disabled_at: disabled ? nowIso : null }, { onConflict: "user_id" });
  if (profErr) throw new Error(`profiles update: ${profErr.message}`);

  if (!disabled) return { sessionsRevoked: null, revokeError: null };

  const { data, error } = await db.rpc("revoke_user_sessions", { p_user_id: userId });
  if (error) return { sessionsRevoked: null, revokeError: error.message };
  return { sessionsRevoked: typeof data === "number" ? data : null, revokeError: null };
}
