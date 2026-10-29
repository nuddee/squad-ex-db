import { serviceClient } from "@/lib/ingest/store-supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + DB reachability. No auth, no details leaked. */
export async function GET() {
  let db = false;
  try {
    const { error } = await serviceClient().from("app_settings").select("key").limit(1);
    db = !error;
    if (error) log("warn", "health.db_error", { message: error.message });
  } catch (e) {
    log("warn", "health.db_unavailable", { message: e instanceof Error ? e.message : String(e) });
  }
  return Response.json({ ok: db, db, time: new Date().toISOString() }, { status: db ? 200 : 503 });
}
