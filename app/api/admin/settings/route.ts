import { NextResponse } from "next/server";
import {
  getAdminSettingsAndAudit,
  updateAdminSettings,
  validateSettingsUpdate,
} from "@/lib/admin/settings";
import { requireAdmin } from "@/lib/auth/session";
import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const payload = await getAdminSettingsAndAudit(serviceClient());
    return NextResponse.json(payload, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.settings.get_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to load application settings." },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const validation = validateSettingsUpdate(body);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: validation.errors.map((e) => e.message).join(" "),
        errors: validation.errors,
      },
      { status: 400 },
    );
  }

  try {
    const result = await updateAdminSettings(
      serviceClient(),
      validation.rowsToUpsert,
      { id: auth.user.id, email: auth.user.email },
    );

    log("info", "admin.settings_updated", {
      changed_by: auth.user.id,
      changed_by_email: auth.user.email,
      changes: result.changes,
    });

    const refreshed = await getAdminSettingsAndAudit(serviceClient());
    return NextResponse.json(
      {
        ...refreshed,
        changes: result.changes,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.settings.put_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to save application settings." },
      { status: 500 },
    );
  }
}
