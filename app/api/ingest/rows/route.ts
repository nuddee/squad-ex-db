import { handleIngestRows } from "@/lib/ingest/handlers";
import { authenticateDevice } from "@/lib/ingest/auth";
import { serviceClient, supabaseStore } from "@/lib/ingest/store-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleIngestRows(req, {
    authenticate: (r) => authenticateDevice(serviceClient(), r),
    store: () => supabaseStore(),
  });
}
