import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SETTINGS,
  applyAppSettingsRows,
  normalizeSnapshotFilenameTz,
  type Settings,
} from "@/lib/qc/config";

export type EditableSettingKey =
  | "good_seed_weight_g"
  | "immature_seed_weight_g"
  | "sm_seed_weight_g"
  | "dc_seed_weight_g"
  | "defect_warn_threshold_pct"
  | "plate_variance_spread_pct"
  | "metrics_window_rows"
  | "expected_plates"
  | "active_ttl_s"
  | "refresh_sec"
  | "snapshot_filename_tz"
  | "report_footer_left"
  | "report_form_code";

export interface SettingFieldSpec {
  key: EditableSettingKey;
  label: string;
  description: string;
  kind: "number" | "integer" | "timezone" | "string";
  min?: number;
  max?: number;
  maxLength?: number;
  assumedWeightNote?: boolean;
}

export const EDITABLE_SETTINGS_SPEC: readonly SettingFieldSpec[] = [
  {
    key: "good_seed_weight_g",
    label: "Good seed weight (g)",
    description: "Weight of one good seed (g) — ASSUMED, not measured",
    kind: "number",
    min: 0.001,
    max: 10.0,
    assumedWeightNote: true,
  },
  {
    key: "immature_seed_weight_g",
    label: "Immature seed weight (g)",
    description: "Weight of one immature seed (g) — ASSUMED, not measured",
    kind: "number",
    min: 0.001,
    max: 10.0,
    assumedWeightNote: true,
  },
  {
    key: "sm_seed_weight_g",
    label: "Spoiled & Mold seed weight (g)",
    description: "Weight of one spoiled/mold seed (g) — ASSUMED, not measured",
    kind: "number",
    min: 0.001,
    max: 10.0,
    assumedWeightNote: true,
  },
  {
    key: "dc_seed_weight_g",
    label: "Discolor seed weight (g)",
    description: "Weight of one discolor seed (g) — ASSUMED, not measured",
    kind: "number",
    min: 0.001,
    max: 10.0,
    assumedWeightNote: true,
  },
  {
    key: "defect_warn_threshold_pct",
    label: "Defect alert threshold (%)",
    description: "Alert when weight-based defect % >= this",
    kind: "number",
    min: 0.1,
    max: 100.0,
  },
  {
    key: "plate_variance_spread_pct",
    label: "Plate variance threshold (%)",
    description: "High variance when defect % spread >= this",
    kind: "number",
    min: 0.1,
    max: 100.0,
  },
  {
    key: "metrics_window_rows",
    label: "Metrics window rows (0 = all rows)",
    description: "Rows used for metrics/PDF; 0 = all (legacy parity = 200)",
    kind: "integer",
    min: 0,
    max: 10000,
  },
  {
    key: "expected_plates",
    label: "Expected plates per batch",
    description: "Expected plates per batch",
    kind: "integer",
    min: 1,
    max: 50,
  },
  {
    key: "active_ttl_s",
    label: "Active batch TTL (s)",
    description: "Batch is active if last data within this many seconds",
    kind: "integer",
    min: 5,
    max: 3600,
  },
  {
    key: "refresh_sec",
    label: "Fallback poll interval (s)",
    description: "Dashboard fallback refetch interval",
    kind: "integer",
    min: 1,
    max: 300,
  },
  {
    key: "snapshot_filename_tz",
    label: "Snapshot filename timezone",
    description: "Timezone of YYYYMMDD_HHMMSS timestamps in snapshot filenames (UTC or Asia/Bangkok)",
    kind: "timezone",
  },
  {
    key: "report_footer_left",
    label: "PDF report footer (left)",
    description: "Left footer label on generated QC PDF reports",
    kind: "string",
    maxLength: 120,
  },
  {
    key: "report_form_code",
    label: "PDF report form code (right)",
    description: "Form code shown in the right footer on generated QC PDF reports",
    kind: "string",
    maxLength: 40,
  },
] as const;

const SPEC_BY_KEY = new Map<string, SettingFieldSpec>(
  EDITABLE_SETTINGS_SPEC.map((s) => [s.key, s]),
);

export interface SettingsValidationResult {
  ok: boolean;
  errors: { key: string; message: string }[];
  rowsToUpsert: { key: EditableSettingKey; value: string; description: string }[];
}

/**
 * Pure server-side validator for `PUT /api/admin/settings`.
 * Validates types, ranges, string lengths, and allowed enum values.
 */
export function validateSettingsUpdate(rawInput: unknown): SettingsValidationResult {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return {
      ok: false,
      errors: [{ key: "_root", message: "Request body must be a JSON object of setting keys and values." }],
      rowsToUpsert: [],
    };
  }

  const inputObj = rawInput as Record<string, unknown>;
  const entries = Object.entries(inputObj);
  if (entries.length === 0) {
    return {
      ok: false,
      errors: [{ key: "_root", message: "At least one setting key must be provided." }],
      rowsToUpsert: [],
    };
  }

  const errors: { key: string; message: string }[] = [];
  const rowsToUpsert: { key: EditableSettingKey; value: string; description: string }[] = [];

  for (const [key, rawVal] of entries) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) {
      errors.push({ key, message: `Unknown or uneditable setting key "${key}".` });
      continue;
    }

    if (spec.kind === "timezone") {
      if (typeof rawVal !== "string" || !rawVal.trim()) {
        errors.push({ key, message: `${spec.label} must be "UTC" or "Asia/Bangkok".` });
        continue;
      }
      const tz = normalizeSnapshotFilenameTz(rawVal);
      // Only allow canonical timezone strings ("UTC" or "Asia/Bangkok") in admin settings
      const trimmed = rawVal.trim();
      if (!tz || (trimmed !== "UTC" && trimmed !== "Asia/Bangkok")) {
        errors.push({ key, message: `${spec.label} must be exactly "UTC" or "Asia/Bangkok".` });
        continue;
      }
      rowsToUpsert.push({ key: spec.key, value: tz, description: spec.description });
      continue;
    }

    if (spec.kind === "string") {
      if (typeof rawVal !== "string") {
        errors.push({ key, message: `${spec.label} must be a string.` });
        continue;
      }
      const trimmed = rawVal.trim();
      const maxLen = spec.maxLength ?? 120;
      if (trimmed.length === 0) {
        errors.push({ key, message: `${spec.label} cannot be empty.` });
        continue;
      }
      if (trimmed.length > maxLen) {
        errors.push({ key, message: `${spec.label} must be at most ${maxLen} characters.` });
        continue;
      }
      if (/[\0-\x1f\x7f]/.test(trimmed)) {
        errors.push({ key, message: `${spec.label} must not contain control characters.` });
        continue;
      }
      rowsToUpsert.push({ key: spec.key, value: trimmed, description: spec.description });
      continue;
    }

    // "number" or "integer"
    const num =
      typeof rawVal === "number"
        ? rawVal
        : typeof rawVal === "string" && rawVal.trim() !== ""
          ? Number(rawVal.trim())
          : Number.NaN;

    if (!Number.isFinite(num)) {
      errors.push({ key, message: `${spec.label} must be a finite number.` });
      continue;
    }

    if (spec.kind === "integer" && !Number.isInteger(num)) {
      errors.push({ key, message: `${spec.label} must be a whole integer.` });
      continue;
    }

    if (spec.min !== undefined && num < spec.min) {
      errors.push({ key, message: `${spec.label} must be >= ${spec.min}.` });
      continue;
    }

    if (spec.max !== undefined && num > spec.max) {
      errors.push({ key, message: `${spec.label} must be <= ${spec.max}.` });
      continue;
    }

    rowsToUpsert.push({
      key: spec.key,
      value: String(num),
      description: spec.description,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    rowsToUpsert: errors.length === 0 ? rowsToUpsert : [],
  };
}

export interface SettingsAuditItem {
  id: number;
  setting_key: string;
  old_value: string | null;
  new_value: string;
  changed_by: string | null;
  changed_by_email: string | null;
  changed_at: string;
}

export async function getAdminSettingsAndAudit(db: SupabaseClient): Promise<{
  settings: Settings;
  raw_rows: {
    key: string;
    value: string;
    description: string | null;
    updated_at?: string | null;
    updated_by?: string | null;
  }[];
  audit_log: SettingsAuditItem[];
}> {
  let rawRows: {
    key: string;
    value: string;
    description: string | null;
    updated_at?: string | null;
    updated_by?: string | null;
  }[] = [];

  const { data: fullData, error: fullErr } = await db
    .from("app_settings")
    .select("key,value,description,updated_at,updated_by")
    .order("key");

  if (fullErr) {
    const { data: basicData, error: basicErr } = await db
      .from("app_settings")
      .select("key,value,description")
      .order("key");
    if (basicErr) throw new Error(`app_settings select: ${basicErr.message}`);
    rawRows = ((basicData ?? []) as { key: string; value: string | number; description: string | null }[]).map(
      (r) => ({
        key: r.key,
        value: String(r.value),
        description: r.description ?? null,
      }),
    );
  } else {
    rawRows = (
      (fullData ?? []) as {
        key: string;
        value: string | number;
        description: string | null;
        updated_at?: string | null;
        updated_by?: string | null;
      }[]
    ).map((r) => ({
      key: r.key,
      value: String(r.value),
      description: r.description ?? null,
      updated_at: r.updated_at ?? null,
      updated_by: r.updated_by ?? null,
    }));
  }

  let auditLog: SettingsAuditItem[] = [];
  const { data: auditData, error: auditErr } = await db
    .from("settings_audit_log")
    .select("id,setting_key,old_value,new_value,changed_by,changed_by_email,changed_at")
    .order("changed_at", { ascending: false })
    .limit(30);

  if (!auditErr && auditData) {
    auditLog = auditData as SettingsAuditItem[];
  }

  return {
    settings: applyAppSettingsRows(rawRows, DEFAULT_SETTINGS),
    raw_rows: rawRows,
    audit_log: auditLog,
  };
}

export async function updateAdminSettings(
  db: SupabaseClient,
  rowsToUpsert: readonly { key: EditableSettingKey; value: string; description: string }[],
  actor: { id: string; email: string },
): Promise<{
  settings: Settings;
  changes: { key: string; old_value: string | null; new_value: string }[];
}> {
  const { data: existingRows } = await db.from("app_settings").select("key,value");
  const existingMap = new Map<string, string>();
  for (const r of (existingRows ?? []) as { key: string; value: string | number }[]) {
    existingMap.set(r.key, String(r.value));
  }

  const nowIso = new Date().toISOString();
  const changes: { key: string; old_value: string | null; new_value: string }[] = [];

  for (const item of rowsToUpsert) {
    const prev = existingMap.get(item.key) ?? null;
    if (prev !== item.value) {
      changes.push({
        key: item.key,
        old_value: prev,
        new_value: item.value,
      });
    }
  }

  // Upsert into app_settings (with updated_at/updated_by if migration 000008 is applied, fallback otherwise)
  const payloadWithAudit = rowsToUpsert.map((r) => ({
    key: r.key,
    value: r.value,
    description: r.description,
    updated_at: nowIso,
    updated_by: actor.id,
  }));

  const { error: upErr } = await db
    .from("app_settings")
    .upsert(payloadWithAudit, { onConflict: "key" });

  if (upErr) {
    const basicPayload = rowsToUpsert.map((r) => ({
      key: r.key,
      value: r.value,
      description: r.description,
    }));
    const { error: fallbackErr } = await db
      .from("app_settings")
      .upsert(basicPayload, { onConflict: "key" });
    if (fallbackErr) {
      throw new Error(`app_settings upsert: ${fallbackErr.message}`);
    }
  }

  if (changes.length > 0) {
    const auditRows = changes.map((c) => ({
      setting_key: c.key,
      old_value: c.old_value,
      new_value: c.new_value,
      changed_by: actor.id,
      changed_by_email: actor.email,
      changed_at: nowIso,
    }));
    // Best-effort insert into settings_audit_log (succeeds once migration 000008 is applied)
    await db.from("settings_audit_log").insert(auditRows);
  }

  const { data: refreshed } = await db.from("app_settings").select("key,value");
  const settings = applyAppSettingsRows(
    ((refreshed ?? []) as { key: string; value: string | number }[]),
    DEFAULT_SETTINGS,
  );

  return { settings, changes };
}
