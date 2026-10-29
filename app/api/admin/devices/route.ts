import { NextResponse } from "next/server";
import {
  createAdminDevice,
  listAdminDevices,
  revokeAdminDevice,
  validateDeviceName,
} from "@/lib/admin/devices";
import { requireAdmin } from "@/lib/auth/session";
import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const devices = await listAdminDevices(serviceClient());
    return NextResponse.json(
      { devices },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.devices.get_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to load devices." },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { name?: unknown };
  try {
    body = (await req.json()) as { name?: unknown };
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const v = validateDeviceName(body?.name);
  if (!v.ok || !v.name) {
    return NextResponse.json(
      { error: "validation_error", message: v.message ?? "Invalid device name." },
      { status: 400 },
    );
  }

  try {
    const created = await createAdminDevice(serviceClient(), v.name);
    log("info", "admin.device_created", {
      device_id: created.device.id,
      name: created.device.name,
      created_by: auth.user.id,
    });
    return NextResponse.json(created, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.devices.post_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to create device." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { id?: unknown; action?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; action?: unknown };
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const deviceId = typeof body?.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(deviceId)) {
    return NextResponse.json(
      { error: "validation_error", message: "Valid device UUID is required." },
      { status: 400 },
    );
  }

  if (body?.action !== "revoke") {
    return NextResponse.json(
      { error: "validation_error", message: "Supported action is 'revoke'." },
      { status: 400 },
    );
  }

  try {
    const updated = await revokeAdminDevice(serviceClient(), deviceId);
    if (!updated) {
      return NextResponse.json(
        { error: "not_found", message: "Device not found." },
        { status: 404 },
      );
    }
    log("info", "admin.device_revoked", {
      device_id: deviceId,
      revoked_by: auth.user.id,
    });
    return NextResponse.json(
      { device: updated },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "admin.devices.patch_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to revoke device." },
      { status: 500 },
    );
  }
}
