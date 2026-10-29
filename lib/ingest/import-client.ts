import type { IngestReport } from "@/lib/ingest/core";
import type { SnapshotImportReport } from "@/lib/ingest/importer";

export interface AdminImportUiResult {
  ingest?: IngestReport;
  snapshots?: SnapshotImportReport | null;
  summary_text?: string;
  error?: string;
  message?: string;
  status?: number;
}

export const WEB_IMPORT_CSV_LIMIT_MB = 10;
export const WEB_IMPORT_SNAPSHOT_LIMIT_MB = 10;
export const WEB_IMPORT_MAX_SNAPSHOTS = 100;

/**
 * Parse a `fetch("/api/admin/import")` Response safely:
 * - Always checks `res.ok` and `res.status`.
 * - Handles 413 Payload Too Large (including HTML/plain-text gateway errors from Vercel/reverse proxies) with a clear message pointing bulk snapshot imports to the CLI.
 * - Handles any other non-JSON error body gracefully instead of throwing `SyntaxError`.
 */
export async function parseAdminImportResponse(res: {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}): Promise<AdminImportUiResult> {
  const raw = await res.text();
  if (res.status === 413) {
    let parsed: { error?: string; message?: string } | undefined;
    try {
      parsed = JSON.parse(raw) as { error?: string; message?: string };
    } catch {
      // non-JSON 413 from reverse proxy / Vercel
    }
    return {
      status: 413,
      error: parsed?.error ?? "payload_too_large",
      message:
        parsed?.message ??
        `Upload exceeds the web import limits (CSV <= ${WEB_IMPORT_CSV_LIMIT_MB} MB, <= ${WEB_IMPORT_MAX_SNAPSHOTS} snapshots, <= ${WEB_IMPORT_SNAPSHOT_LIMIT_MB} MB per image). For bulk snapshot imports, run the CLI instead: pnpm import-csv <file.csv> --device <name>.`,
    };
  }

  let data: AdminImportUiResult | null = null;
  try {
    data = JSON.parse(raw) as AdminImportUiResult;
  } catch {
    return {
      status: res.status,
      error: res.ok ? "invalid_response" : `http_${res.status}`,
      message:
        `Server returned a non-JSON response (HTTP ${res.status}): ${raw.slice(0, 180).trim() || "empty body"}. ` +
        `If you are uploading many snapshots, use the CLI: pnpm import-csv <file.csv> --device <name>.`,
    };
  }

  if (!res.ok) {
    return {
      status: res.status,
      error: data.error ?? `http_${res.status}`,
      message: data.message ?? `Request failed with HTTP ${res.status}.`,
    };
  }
  return { ...data, status: res.status };
}
