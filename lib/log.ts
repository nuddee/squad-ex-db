const SENSITIVE_KEY_RE =
  /(?:api_?key|service_?role|secret|token|password|passwd|authorization|cookie|signed_?url|signedurl|full_url|thumb_url)/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsb_secret_[A-Za-z0-9_-]+/g,
  /\bsb_publishable_[A-Za-z0-9_-]+/g,
  /\bagv_[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /https?:\/\/[^\s"']+\/storage\/v1\/object\/sign\/[^\s"']+/gi,
  /([?&]token=)[^&\s"']+/gi,
];

export function redactSensitiveString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) =>
      typeof prefix === "string" && match.startsWith(prefix)
        ? `${prefix}[REDACTED]`
        : "[REDACTED]",
    );
  }
  return out;
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }
  return redactSensitiveString(String(value));
}

export function sanitizeLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeLogValue(fields, 0) as Record<string, unknown>;
}

/**
 * Structured (JSON-line) logging for Route Handlers and scripts.
 * Automatically scrubs keys, tokens, passwords, Authorization headers, and signed Storage URLs.
 */
export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (process.env.VITEST && !process.env.LOG_IN_TESTS) return;
  const safeFields = sanitizeLogFields(fields);
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  });
  (level === "error"
    ? console.error
    : level === "warn"
      ? console.warn
      : console.log)(line);
}
