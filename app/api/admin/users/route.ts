import { NextResponse } from "next/server";
import { setUserDisabled } from "@/lib/admin/users";
import { validatePassword } from "@/lib/auth/password";
import { normalizeRole, requireAdmin, type UserRole } from "@/lib/auth/session";
import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeUserProvisionMessage(raw: string | undefined, fallback: string): string {
  const lower = (raw ?? "").toLowerCase();
  if (lower.includes("already been registered") || lower.includes("already exists")) {
    return "A user with this email address already exists.";
  }
  if (lower.includes("invalid email") || lower.includes("unable to validate email")) {
    return "Invalid email address.";
  }
  if (lower.includes("password")) {
    return "Password does not meet security requirements.";
  }
  if (lower.includes("rate limit")) {
    return "Rate limit exceeded. Please wait before sending another invite.";
  }
  return fallback;
}

export interface AdminUserItem {
  id: string;
  email: string;
  role: UserRole;
  raw_role: string;
  disabled: boolean;
  disabled_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const db = serviceClient();
    const { data: usersRes, error: usersErr } = await db.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (usersErr) {
      throw new Error(`auth.admin.listUsers: ${usersErr.message}`);
    }

    const profileMap = new Map<
      string,
      { role: string; disabled_at: string | null }
    >();
    const { data: profData, error: profErr } = await db
      .from("profiles")
      .select("user_id,role,disabled_at");

    if (profErr) {
      const { data: fallbackProf } = await db
        .from("profiles")
        .select("user_id,role");
      for (const r of (fallbackProf ?? []) as { user_id: string; role: string }[]) {
        profileMap.set(r.user_id, { role: r.role, disabled_at: null });
      }
    } else {
      for (const r of (profData ?? []) as {
        user_id: string;
        role: string;
        disabled_at?: string | null;
      }[]) {
        profileMap.set(r.user_id, {
          role: r.role,
          disabled_at: r.disabled_at ?? null,
        });
      }
    }

    const users: AdminUserItem[] = (usersRes?.users ?? []).map((u) => {
      const prof = profileMap.get(u.id);
      const metaRole =
        typeof (u.app_metadata as Record<string, unknown> | undefined)?.role ===
        "string"
          ? String((u.app_metadata as Record<string, unknown>).role)
          : null;
      const effectiveRaw = prof?.role ?? metaRole ?? "viewer";
      const { role, rawRole } = normalizeRole(effectiveRaw);

      const bannedUntil = (u as { banned_until?: string | null }).banned_until;
      const isBanned =
        Boolean(bannedUntil) &&
        Number.isFinite(Date.parse(String(bannedUntil))) &&
        Date.parse(String(bannedUntil)) > Date.now();
      const metaDisabled = Boolean(
        (u.app_metadata as Record<string, unknown> | undefined)?.disabled,
      );
      const disabledAt = prof?.disabled_at ?? (isBanned ? bannedUntil ?? null : null);

      return {
        id: u.id,
        email: u.email ?? "",
        role,
        raw_role: rawRole,
        disabled: Boolean(disabledAt) || isBanned || metaDisabled,
        disabled_at: disabledAt,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
      };
    });

    users.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return NextResponse.json(
      { users },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.users.get_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to load users." },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: {
    email?: unknown;
    password?: unknown;
    role?: unknown;
    mode?: unknown;
  };
  try {
    body = (await req.json()) as {
      email?: unknown;
      password?: unknown;
      role?: unknown;
      mode?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "validation_error", message: "A valid email address is required." },
      { status: 400 },
    );
  }

  const roleRaw = typeof body?.role === "string" ? body.role.trim().toLowerCase() : "viewer";
  // New users are 'admin' or 'viewer' only ('operator' is a legacy alias of 'viewer', see README).
  if (roleRaw !== "admin" && roleRaw !== "viewer") {
    return NextResponse.json(
      { error: "validation_error", message: "Role must be 'admin' or 'viewer'." },
      { status: 400 },
    );
  }
  const { role } = normalizeRole(roleRaw);
  const mode = body?.mode === "invite" ? "invite" : "create";
  const password = typeof body?.password === "string" ? body.password : "";

  if (mode === "create") {
    const pw = validatePassword(password);
    if (!pw.ok) {
      return NextResponse.json(
        { error: "validation_error", message: pw.message },
        { status: 400 },
      );
    }
  }

  try {
    const db = serviceClient();
    let createdUserId: string | null = null;

    if (mode === "invite") {
      const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
        data: { role },
      });
      if (error || !data?.user) {
        log("warn", "admin.users.invite_failed", { email, message: error?.message });
        return NextResponse.json(
          {
            error: "create_user_failed",
            message: safeUserProvisionMessage(error?.message, "Failed to invite user."),
          },
          { status: 400 },
        );
      }
      createdUserId = data.user.id;
      await db.auth.admin.updateUserById(createdUserId, {
        app_metadata: { role, disabled: false },
      });
    } else {
      const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role, disabled: false },
      });
      if (error || !data?.user) {
        log("warn", "admin.users.create_failed", { email, message: error?.message });
        return NextResponse.json(
          {
            error: "create_user_failed",
            message: safeUserProvisionMessage(error?.message, "Failed to create user."),
          },
          { status: 400 },
        );
      }
      createdUserId = data.user.id;
    }

    // Upsert profile row (with graceful fallback to 'operator' if migration 000008 has not been pushed yet)
    const { error: profErr } = await db
      .from("profiles")
      .upsert(
        { user_id: createdUserId, role, disabled_at: null },
        { onConflict: "user_id" },
      );

    if (profErr) {
      const legacyRole = role === "admin" ? "admin" : "operator";
      await db
        .from("profiles")
        .upsert({ user_id: createdUserId, role: legacyRole }, { onConflict: "user_id" });
    }

    log("info", "admin.user_created", {
      user_id: createdUserId,
      email,
      role,
      mode,
      created_by: auth.user.id,
    });

    return NextResponse.json(
      {
        user: {
          id: createdUserId,
          email,
          role,
          mode,
        },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.users.post_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to provision user." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { user_id?: unknown; role?: unknown; disabled?: unknown };
  try {
    body = (await req.json()) as {
      user_id?: unknown;
      role?: unknown;
      disabled?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  if (!UUID_RE.test(userId)) {
    return NextResponse.json(
      { error: "validation_error", message: "Valid user_id UUID is required." },
      { status: 400 },
    );
  }

  const hasRoleChange = body?.role !== undefined;
  const hasDisableChange = typeof body?.disabled === "boolean";

  if (!hasRoleChange && !hasDisableChange) {
    return NextResponse.json(
      { error: "validation_error", message: "Provide 'role' or 'disabled' to update." },
      { status: 400 },
    );
  }

  let targetRole: UserRole | undefined;
  if (hasRoleChange) {
    const r = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
    if (r !== "admin" && r !== "viewer") {
      return NextResponse.json(
        { error: "validation_error", message: "Role must be 'admin' or 'viewer'." },
        { status: 400 },
      );
    }
    targetRole = normalizeRole(r).role;
  }

  const targetDisabled = hasDisableChange ? Boolean(body.disabled) : undefined;

  if (
    userId === auth.user.id &&
    ((targetRole && targetRole !== "admin") || targetDisabled === true)
  ) {
    return NextResponse.json(
      {
        error: "self_lockout_prevented",
        message: "You cannot demote or disable your own administrator account.",
      },
      { status: 400 },
    );
  }

  try {
    const db = serviceClient();

    if (targetRole !== undefined) {
      const { error: roleAuthErr } = await db.auth.admin.updateUserById(userId, {
        app_metadata: { role: targetRole },
      });
      if (roleAuthErr) throw new Error(`auth.admin.updateUserById: ${roleAuthErr.message}`);

      const { error: profErr } = await db
        .from("profiles")
        .upsert({ user_id: userId, role: targetRole }, { onConflict: "user_id" });
      if (profErr) throw new Error(`profiles role update: ${profErr.message}`);
    }

    let disableResult: Awaited<ReturnType<typeof setUserDisabled>> | null = null;
    if (targetDisabled !== undefined) {
      // Ban in Auth + profiles.disabled_at (RLS) + revoke sessions on disable; re-enable lifts the ban.
      disableResult = await setUserDisabled(db, userId, targetDisabled);
      if (disableResult.revokeError) {
        log("warn", "admin.user_revoke_sessions_failed", {
          user_id: userId,
          message: disableResult.revokeError,
        });
      }
    }

    log("info", "admin.user_updated", {
      user_id: userId,
      role: targetRole,
      disabled: targetDisabled,
      sessions_revoked: disableResult?.sessionsRevoked ?? null,
      updated_by: auth.user.id,
    });

    return NextResponse.json(
      {
        ok: true,
        user_id: userId,
        role: targetRole,
        disabled: targetDisabled,
        sessions_revoked: disableResult?.sessionsRevoked ?? null,
        warning: disableResult?.revokeError
          ? "User was banned and disabled, but active sessions could not be revoked (is migration 010 pushed?)."
          : undefined,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.users.patch_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to update user." },
      { status: 500 },
    );
  }
}
