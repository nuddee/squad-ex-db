"use client";

import React, { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/browser";

function safeRedirectTarget(raw: string | null): string {
  if (!raw) return "/";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/login")) {
    return "/";
  }
  return trimmed;
}

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeRedirectTarget(searchParams.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const supabase = getBrowserSupabaseClient();
      if (!supabase) {
        setError(
          "Supabase client is not configured. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
        );
        return;
      }

      const { data, error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInErr || !data.session) {
        setError("Invalid email or password.");
        return;
      }

      // Verify account status (not disabled) with server session check
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      if (!meRes.ok) {
        const body = (await meRes.json().catch(() => null)) as {
          message?: string;
        } | null;
        await supabase.auth.signOut();
        setError(body?.message ?? "Account is not authorized to access AgriVision QC.");
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch {
      setError("Unable to sign in right now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      className="hmi-shell"
      style={{
        minHeight: "90vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 430,
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 16,
          padding: "28px 26px",
          boxShadow: "0 10px 25px -5px rgba(15, 23, 42, 0.06)",
        }}
      >
        <div className="app-brand" style={{ marginBottom: 16 }}>
          <div className="mark">🌾</div>
          <div>
            <div className="name">AgriVision QC</div>
            <div className="sub">Production Quality Control · HMI</div>
          </div>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px 0", color: "#0f172a" }}>
          Sign in to Dashboard
        </h1>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 18px 0", lineHeight: 1.45 }}>
          Enter your operator or administrator credentials to access inspection batches, live telemetry, and QC reports.
        </p>

        {error && (
          <div
            role="alert"
            className="banner banner-danger"
            style={{ marginBottom: 14, fontSize: 13 }}
          >
            ⚠️ {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 5, fontSize: 13, fontWeight: 700, color: "#334155" }}>
            Email address
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="operator@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                padding: "9px 12px",
                borderRadius: 10,
                border: "1px solid #cbd5e1",
                fontSize: 14,
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 5, fontSize: 13, fontWeight: 700, color: "#334155" }}>
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                padding: "9px 12px",
                borderRadius: 10,
                border: "1px solid #cbd5e1",
                fontSize: 14,
              }}
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="hmi-btn hmi-btn-primary"
            style={{
              width: "100%",
              justifyContent: "center",
              padding: "10px 16px",
              fontSize: 14,
              marginTop: 4,
            }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: "1px solid #f1f5f9",
            fontSize: 12,
            color: "#64748b",
            lineHeight: 1.5,
          }}
        >
          🔒 <strong>Public sign-up is disabled.</strong> Operator and administrator accounts are created by an administrator in{" "}
          <code>/settings</code>.
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="hmi-shell">
          <div className="page-title">Loading sign-in…</div>
        </main>
      }
    >
      <LoginFormInner />
    </Suspense>
  );
}
