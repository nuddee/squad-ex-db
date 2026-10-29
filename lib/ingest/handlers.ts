import type { ZodType } from "zod";
import { log } from "@/lib/log";
import type { Device } from "./auth";
import { rateLimit } from "./rate-limit";
import { ingestRows, ingestRowsBodySchema } from "./core";
import { signBodySchema, signSnapshots } from "./snapshots";
import type { IngestStore } from "./store";

export interface HandlerDeps {
  authenticate(req: Request): Promise<Device | null>;
  store(): IngestStore;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function guarded<T>(
  req: Request,
  deps: HandlerDeps,
  event: string,
  schema: ZodType<T>,
  run: (device: Device, body: T) => Promise<Record<string, unknown>>,
): Promise<Response> {
  try {
    const device = await deps.authenticate(req);
    if (!device) return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });

    const rl = rateLimit(device.id);
    if (!rl.ok) {
      log("warn", `${event}.rate_limited`, { device: device.name });
      return json({ error: "rate_limited" }, 429, { "retry-after": String(rl.retryAfterS) });
    }

    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    let raw: unknown;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
      raw = JSON.parse(text);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return json(
        { error: "invalid_body", issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) },
        400,
      );
    }
    const result = await run(device, parsed.data);
    return json(result);
  } catch (e) {
    log("error", `${event}.failed`, { message: e instanceof Error ? e.message : String(e) });
    return json({ error: "internal_error" }, 500);
  }
}

/** POST /api/ingest/rows */
export function handleIngestRows(req: Request, deps: HandlerDeps): Promise<Response> {
  return guarded(req, deps, "ingest.rows", ingestRowsBodySchema, async (device, body) => {
    const report = await ingestRows(deps.store(), {
      deviceId: device.id,
      sourceName: body.source_name,
      columns: body.columns,
      rows: body.rows,
      firstRecord: body.first_record,
    });
    const level = report.skipped > 0 || report.weight?.weight_warning ? "warn" : "info";
    log(level, "ingest.rows", {
      device: device.name,
      source: report.source_name,
      batch_id: report.batch_id,
      received: report.received,
      accepted: report.accepted,
      skipped: report.skipped,
      skip_reasons: report.skip_reasons,
      skipped_samples: report.skipped_samples,
      duplicates_in_request: report.duplicates_in_request,
      weight_warning: report.weight?.weight_warning ?? null,
    });
    return { ...report };
  });
}

/** POST /api/ingest/snapshots/sign */
export function handleSignSnapshots(req: Request, deps: HandlerDeps): Promise<Response> {
  return guarded(req, deps, "ingest.sign", signBodySchema, async (device, body) => {
    const report = await signSnapshots(deps.store(), {
      deviceId: device.id,
      sourceName: body.source_name,
      filenames: body.files.map((f) => f.filename),
      thumbs: body.thumbs,
    });
    log(report.skipped > 0 ? "warn" : "info", "ingest.sign", {
      device: device.name,
      source: report.source_name,
      batch_id: report.batch_id,
      received: report.received,
      signed: report.signed.length,
      skipped: report.skipped,
      skip_reasons: report.skip_reasons,
    });
    return { ...report };
  });
}
