import { NextResponse } from "next/server";
import { verifySameOrigin } from "@/lib/auth/session";
import { createSupabaseRequestClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrfDenied = verifySameOrigin(req);
  if (csrfDenied) return csrfDenied;

  const setCookies: string[] = [];
  const supabase = createSupabaseRequestClient(req, process.env, (cookies) => {
    setCookies.push(...cookies);
  });

  if (supabase) {
    await supabase.auth.signOut();
  }

  const res = NextResponse.json(
    { ok: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
  for (const cookieHeader of setCookies) {
    res.headers.append("Set-Cookie", cookieHeader);
  }
  return res;
}
