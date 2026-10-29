import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json(
    { user: auth.user },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
