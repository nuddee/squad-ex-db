import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { listDashboardBatches } from "@/lib/dashboard/queries";
import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const res = await listDashboardBatches(serviceClient());
    return NextResponse.json(res, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "batches.list_error", { message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to load batches" },
      { status: 500 },
    );
  }
}
