/**
 * Bootstrap the first administrator account in Supabase Auth + `public.profiles`.
 *
 * Usage:
 *   pnpm bootstrap-admin <email>
 *
 * The password is NEVER accepted as a CLI argument (it would leak into shell history / process lists).
 * It is read from the BOOTSTRAP_ADMIN_PASSWORD env var, or prompted with hidden input. Minimum 12 characters.
 * Never logs or prints passwords or secret keys.
 */
import { validatePassword } from "../lib/auth/password";
import {
  explainSupabaseError,
  getServiceRoleKey,
  getSupabaseUrl,
  isPlaceholder,
  loadEnvLocalIfNeeded,
} from "../lib/env";
import { serviceClient } from "../lib/ingest/store-supabase";

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(
        new Error(
          "No interactive terminal available. Set BOOTSTRAP_ADMIN_PASSWORD in the environment instead.",
        ),
      );
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const finish = (err: Error | null) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") return finish(null);
        if (c === "\u0003") return finish(new Error("cancelled"));
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

export async function runBootstrapAdmin(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  loadEnvLocalIfNeeded();

  const email = (args[0] ?? "").trim().toLowerCase();
  if (args.length > 1) {
    console.error(
      "error: passing a password as a CLI argument is not supported. " +
        "Set BOOTSTRAP_ADMIN_PASSWORD or enter it at the hidden prompt.",
    );
    process.exit(2);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("usage: pnpm bootstrap-admin <email>   (password via BOOTSTRAP_ADMIN_PASSWORD or hidden prompt)");
    process.exit(2);
  }

  const url = getSupabaseUrl();
  const key = getServiceRoleKey();
  if (!url || !key || isPlaceholder(url) || isPlaceholder(key)) {
    throw new Error(
      "Missing or placeholder environment variables (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). " +
        "Copy .env.example to .env.local, fill in your keys, and run `pnpm check-env`.",
    );
  }

  const db = serviceClient();
  const { data: listRes, error: listErr } = await db.auth.admin.listUsers({
    page: 1,
    perPage: 500,
  });
  if (listErr) {
    const { hint } = explainSupabaseError(listErr);
    throw new Error(`Failed to list users: ${listErr.message}\nHint: ${hint}`);
  }

  const existing = (listRes?.users ?? []).find(
    (u) => (u.email ?? "").toLowerCase() === email,
  );

  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  if (!password) {
    password = await promptHidden(
      existing
        ? `New password for ${email} (>= 12 chars, empty keeps the current one): `
        : `Password for new admin ${email} (>= 12 chars): `,
    );
  }
  if (password || !existing) {
    const check = validatePassword(password);
    if (!check.ok) {
      console.error(`error: ${check.message}`);
      process.exit(2);
    }
  }

  let userId: string;
  if (existing) {
    userId = existing.id;
    const { error: updErr } = await db.auth.admin.updateUserById(userId, {
      email_confirm: true,
      app_metadata: { role: "admin", disabled: false },
      ban_duration: "none",
      ...(password ? { password } : {}),
    });
    if (updErr) {
      throw new Error(`Failed to update existing user "${email}": ${updErr.message}`);
    }
  } else {
    const { data: createRes, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "admin", disabled: false },
    });
    if (createErr || !createRes?.user) {
      throw new Error(`Failed to create user "${email}": ${createErr?.message ?? "unknown"}`);
    }
    userId = createRes.user.id;
  }

  const { error: profErr } = await db
    .from("profiles")
    .upsert({ user_id: userId, role: "admin", disabled_at: null }, { onConflict: "user_id" });

  if (profErr) {
    const { error: fallbackErr } = await db
      .from("profiles")
      .upsert({ user_id: userId, role: "admin" }, { onConflict: "user_id" });
    if (fallbackErr) {
      const { hint } = explainSupabaseError(fallbackErr);
      throw new Error(`Failed to upsert admin profile: ${fallbackErr.message}\nHint: ${hint}`);
    }
  }

  console.log(`admin user ready: ${email} (id ${userId}, role=admin)`);
}

if (require.main === module) {
  runBootstrapAdmin().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
