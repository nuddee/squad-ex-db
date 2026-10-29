# Deploying AgriVision QC to Vercel

This guide covers deploying the Next.js 16 application (`ex-db/`) to **Vercel** connected to Supabase project `emqooadipseotdbzqtbd` (`https://emqooadipseotdbzqtbd.supabase.co`).

---

## 1. Pre-Deploy Database Checklist (Supabase)

Before deploying the web application, ensure all migrations (`20261028000001` through `20261028000010`) are pushed to the linked Supabase project:

```bash
cd ex-db
supabase login
supabase link --project-ref emqooadipseotdbzqtbd
supabase db push --linked
```

Also verify in **Supabase Dashboard → Authentication → Sign In / Up**:
- **Allow new users to sign up** is **OFF** (disabled). Only administrators can create or invite users via `/settings` or `pnpm bootstrap-admin <email>`.

---

## 2. Vercel Project Configuration

1. Import the repository into Vercel and set **Root Directory** to `ex-db`.
2. **Framework Preset:** `Next.js`
3. **Install Command:** `pnpm install --frozen-lockfile`
4. **Build Command:** `pnpm build`
5. **Function Region:** Set the default Serverless Function region close to your Supabase project (`ap-southeast-1` / **Singapore `sin1`**) in **Vercel Project Settings → Functions → Function Region** so database queries and Storage signed-URL calls have single-digit millisecond latency.

---

## 3. Required Environment Variables on Vercel

Configure these in **Vercel Project Settings → Environment Variables** for **Production** (and **Preview** if used).

| Name | Required | Secret? | Where Used | Description |
| :--- | :---: | :---: | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | No | Browser + Server | `https://emqooadipseotdbzqtbd.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **Yes** | No | Browser + Server | Supabase publishable (`sb_publishable_...`) or anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | **Yes** | Server-only (`serviceClient`) | Supabase secret key (`sb_secret_...` or `service_role` JWT). Never exposed to client components. |
| `ADMIN_IMPORT_TOKEN` | **Yes** | **Yes** | Server-only (`/api/admin/import`) | `>= 32` char random hex secret generated via `pnpm gen-token`. |
| `SUPABASE_URL` | Optional | No | Server-only | Optional server-side override; defaults to `NEXT_PUBLIC_SUPABASE_URL`. |
| `DASHBOARD_BASIC_AUTH_ENABLED` | Optional | No | `proxy.ts` / `requireUser` | Default `0` (disabled). Set to `1` only if you want an extra HTTP Basic Auth prompt in front of `/login`. |
| `DASHBOARD_BASIC_AUTH_USER` | Cond. | No | `proxy.ts` / `requireUser` | Required when `DASHBOARD_BASIC_AUTH_ENABLED=1`. |
| `DASHBOARD_BASIC_AUTH_PASSWORD` | Cond. | **Yes** | `proxy.ts` / `requireUser` | Required when `DASHBOARD_BASIC_AUTH_ENABLED=1` (must not be a weak default). |

> **Fail-Closed Startup Validation (`instrumentation.ts` + `lib/env.ts`):**
> When `NODE_ENV=production`, `assertProductionEnv()` runs at server startup and before `serviceClient()` initialization. If any of the 4 required variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_IMPORT_TOKEN`) is missing or placeholder, or if `ALLOW_INSECURE_ADMIN_IMPORT=1` is set, the server fails closed immediately.

---

## 4. Runtime, `maxDuration`, and Thai Font Bundling

### Node.js Runtime & `maxDuration`
All API routes declare `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`:
- **PDF Report Route (`app/api/batches/[id]/report/route.ts`):**
  - `export const runtime = "nodejs";`
  - `export const maxDuration = 30;` (allows up to 30 seconds to fetch up to 6 plate snapshots from Supabase Storage, embed them with `pdfkit`, and upload the generated PDF to the private `reports` bucket).
- **Admin CSV & Snapshot Import Route (`app/api/admin/import/route.ts`):**
  - `export const runtime = "nodejs";`
  - `export const maxDuration = 60;` (allows up to 60 seconds for multi-hundred-row CSV upserts and up to 100 snapshot uploads).

### Confirming Thai Fonts Are Bundled on Vercel
`next.config.ts` configures `serverExternalPackages: ["pdfkit"]` and `outputFileTracingIncludes` for `/api/batches/[id]/report` so `./lib/report/fonts/NotoSansThai-Regular.ttf` and `./lib/report/fonts/NotoSansThai-Bold.ttf` are traced into the Vercel Serverless Function bundle:

```ts
serverExternalPackages: ["pdfkit"],
outputFileTracingIncludes: {
  "/api/batches/[id]/report": [
    "./lib/report/fonts/**/*",
    "./node_modules/pdfkit/js/standard-fonts/**/*",
  ],
  "/api/batches/[id]/report/route": [
    "./lib/report/fonts/**/*",
    "./node_modules/pdfkit/js/standard-fonts/**/*",
  ],
},
```

**How to verify on the deployed site:**
1. Sign in at `https://<your-vercel-domain>/login`.
2. Select a batch (e.g. `SAMPLE 1` or a batch with a Thai truck plate / inspector name) and click **Download PDF Report**.
3. Open the downloaded PDF and verify:
   - Thai characters render cleanly (no tofu boxes `□` or garbled glyphs).
   - In your PDF viewer's **Document Properties → Fonts**, `NotoSansThai-Regular` and `NotoSansThai-Bold` are listed as embedded TrueType subsets.

---

## 5. Post-Deploy Smoke Test Checklist

Run the automated smoke test script against your deployed Vercel URL:

```bash
# Unauthenticated checks (health, / -> /login redirect, 401 on /api/batches and /api/ingest/rows)
pnpm smoke https://<your-vercel-domain>

# Full authenticated + PDF generation + cleanup smoke suite
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD='<your-admin-password>' \
pnpm smoke https://<your-vercel-domain>
```

Manual verification checklist after deployment:
1. `GET https://<your-vercel-domain>/api/health` returns `200` with `{"ok":true,"db":true,...}`.
2. Visiting `https://<your-vercel-domain>/` in an incognito window redirects (`307`) to `/login?next=%2F`.
3. Response headers on `/` include `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY`, and `Strict-Transport-Security`.
4. Signing in at `/login` loads the dashboard (`/`), connects to Supabase Realtime (`wss://emqooadipseotdbzqtbd.supabase.co/realtime/v1/websocket`) without CSP console errors, and displays `LIVE` / `SUBSCRIBED`.
5. Opening **Snapshots** tab loads signed thumbnail URLs (`10 min` expiry) and opens the **View larger** lightbox.
6. Clicking **Download PDF Report** generates a PDF in `reports/<batch_id>/<timestamp>.pdf`, opens the signed URL (`10 min` expiry), and renders Thai text + numbers matching the dashboard.
7. Visiting `/settings` as an `admin` loads App Settings (with audit log), Edge Devices, and Users; visiting `/settings` as a `viewer` redirects to `/?error=admin_required` and `/api/admin/*` returns `403`.
