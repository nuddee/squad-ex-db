import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { getDashboardBatchDetail } from "@/lib/dashboard/queries";
import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found", message: "Batch not found" }, { status: 404 });
  }
  try {
    const detail = await getDashboardBatchDetail(serviceClient(), id);
    if (!detail) {
      return NextResponse.json({ error: "not_found", message: "Batch not found" }, { status: 404 });
    }
    return NextResponse.json(detail, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "batches.detail_error", { id, message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to load batch detail" },
      { status: 500 },
    );
  }
}
