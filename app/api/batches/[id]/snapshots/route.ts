import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import {
  getDashboardBatchSnapshots,
  SNAPSHOTS_PER_PAGE,
} from "@/lib/dashboard/queries";
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
    return NextResponse.json(
      { error: "not_found", message: "Batch not found" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const pageParam = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;

  const pageSizeParam = Number.parseInt(
    url.searchParams.get("pageSize") ?? String(SNAPSHOTS_PER_PAGE),
    10,
  );
  const pageSize =
    Number.isFinite(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= 64
      ? pageSizeParam
      : SNAPSHOTS_PER_PAGE;

  const plateRaw = (url.searchParams.get("plate") ?? "").trim().toLowerCase();
  let plateFilter: number | null = null;
  if (plateRaw && plateRaw !== "all") {
    const parsedPlate = Number.parseInt(plateRaw.replace(/^plate\s+/i, ""), 10);
    if (Number.isFinite(parsedPlate) && parsedPlate >= 1) {
      plateFilter = parsedPlate;
    }
  }

  try {
    const payload = await getDashboardBatchSnapshots(serviceClient(), id, {
      page,
      pageSize,
      plateFilter,
    });
    if (!payload) {
      return NextResponse.json(
        { error: "not_found", message: "Batch not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(payload, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "batches.snapshots_error", { id, message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to load batch snapshots" },
      { status: 500 },
    );
  }
}
