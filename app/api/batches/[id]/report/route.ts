import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";
import {
  DEFAULT_MAX_REPORT_SNAPSHOTS,
  MAX_REPORT_SNAPSHOTS,
  generateAndStoreBatchReport,
} from "@/lib/report/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
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

  let maxSnapshots = DEFAULT_MAX_REPORT_SNAPSHOTS;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { max_snapshots?: number };
      if (
        typeof body?.max_snapshots === "number" &&
        Number.isFinite(body.max_snapshots) &&
        body.max_snapshots >= 1 &&
        body.max_snapshots <= MAX_REPORT_SNAPSHOTS
      ) {
        maxSnapshots = Math.trunc(body.max_snapshots);
      }
    }
  } catch {
    // Empty or non-JSON body uses default maxSnapshots = 6
  }

  try {
    const result = await generateAndStoreBatchReport(serviceClient(), id, {
      maxSnapshots,
      createdBy: auth.user.id,
    });
    if (!result) {
      return NextResponse.json(
        { error: "not_found", message: "Batch not found" },
        { status: 404 },
      );
    }

    log("info", "batches.report_generated", {
      batch_id: id,
      report_id: result.report_id,
      storage_path: result.storage_path,
      created_by: auth.user.id,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log("error", "batches.report_error", { id, message });
    return NextResponse.json(
      { error: "internal_error", message: "Failed to generate PDF report" },
      { status: 500 },
    );
  }
}
