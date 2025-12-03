// seo-worker.ts - BullMQ worker that runs the GPT_SEO module
// Place: medx-ingest-api/workers/seo/seo-worker.ts
//
// Behavior:
//  - Listens on queue "seo"
//  - Payload expected: { jobId, tenant_id, raw_payload, correlation_id }
//  - Calls central GPT via CENTRAL_GPT_URL / CENTRAL_GPT_KEY (if set)
//  - Writes module result to Supabase product_ingestions.normalized_payload (update by id)
//    and sets status/completed_at and diagnostics.
//
// Env required:
//  - REDIS_URL
//  - SUPABASE_URL
//  - SUPABASE_SERVICE_ROLE_KEY
//  - (optional) CENTRAL_GPT_URL, CENTRAL_GPT_KEY

import IORedis from "ioredis";
import { Worker, Job } from "bullmq";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const REDIS_URL = process.env.REDIS_URL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CENTRAL_GPT_URL = process.env.CENTRAL_GPT_URL || "";
const CENTRAL_GPT_KEY = process.env.CENTRAL_GPT_KEY || "";

if (!REDIS_URL) {
  throw new Error("REDIS_URL env var is required for seo-worker");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required for seo-worker"
  );
}

const connection = new IORedis(REDIS_URL);

const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
);

type SeoJobPayload = {
  jobId: string;
  tenant_id?: string | null;
  raw_payload?: any;
  correlation_id?: string;
};

/**
 * Call the central SEO model. If CENTRAL_GPT_URL / CENTRAL_GPT_KEY are not set,
 * we simply echo raw_payload as the SEO output (for local/dev).
 */
async function callSeoModel(
  rawPayload: any,
  correlationId?: string
): Promise<any> {
  if (!CENTRAL_GPT_URL || !CENTRAL_GPT_KEY) {
    console.warn(
      "[seo-worker] CENTRAL_GPT_URL/CENTRAL_GPT_KEY not set; returning raw_payload as seo output"
    );
    return rawPayload;
  }

  const body = {
    module: "seo",
    payload: rawPayload,
    correlation_id: correlationId || undefined,
  };

  const res = await fetch(CENTRAL_GPT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CENTRAL_GPT_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore JSON parse errors below, we’ll surface the raw body
  }

  if (!res.ok) {
    throw new Error(
      `central GPT seo error: ${res.status} ${
        json ? JSON.stringify(json) : text
      }`
    );
  }

  // You can adjust this if your API returns seo under a different shape
  const seo = json?.seo ?? json ?? rawPayload;
  return seo;
}

async function updateDiagnostics(
  jobId: string,
  seoDiagnostics: Record<string, any>
): Promise<void> {
  const { data, error } = await supabase
    .from("product_ingestions")
    .select("diagnostics")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    console.warn(
      `[seo-worker] failed to load diagnostics for job=${jobId}`,
      error.message || error
    );
    return;
  }

  const existingDiagnostics = (data?.diagnostics as any) || {};
  const newDiagnostics = {
    ...existingDiagnostics,
    seo_call: {
      ...(existingDiagnostics.seo_call || {}),
      ...seoDiagnostics,
    },
  };

  const { error: updErr } = await supabase
    .from("product_ingestions")
    .update({
      diagnostics: newDiagnostics,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (updErr) {
    console.warn(
      `[seo-worker] failed to update diagnostics for job=${jobId}`,
      updErr.message || updErr
    );
  }
}

/**
 * Main BullMQ job processor for SEO.
 */
export async function processor(
  job: Job<SeoJobPayload>
): Promise<{ ok: boolean; seo: any }> {
  const { jobId, tenant_id, raw_payload, correlation_id } = job.data || {};

  if (!jobId) {
    throw new Error("[seo-worker] jobId is required in job.data");
  }

  if (!raw_payload) {
    throw new Error("[seo-worker] raw_payload is required in job.data");
  }

  console.log(
    `[seo-worker] start job=${jobId} tenant=${tenant_id || "n/a"}`
  );

  let seo: any;
  const startedAt = new Date().toISOString();

  try {
    seo = await callSeoModel(raw_payload, correlation_id);
  } catch (err: any) {
    console.error(
      `[seo-worker] seo model call failed for job=${jobId}`,
      err?.message || err
    );

    await updateDiagnostics(jobId, {
      last_error: String(err?.message || err),
      last_error_at: new Date().toISOString(),
    });

    throw err;
  }

  // Persist SEO payload into product_ingestions.normalized_payload
  try {
    const { error } = await supabase
      .from("product_ingestions")
      .update({
        normalized_payload: seo,
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (error) {
      console.error(
        `[seo-worker] error updating product_ingestions for job=${jobId}`,
        error.message || error
      );
      throw error;
    }

    await updateDiagnostics(jobId, {
      last_success_at: new Date().toISOString(),
      started_at: startedAt,
    });

    console.log(`[seo-worker] completed job=${jobId}`);
  } catch (err: any) {
    console.error(
      `[seo-worker] error persisting seo for job=${jobId}`,
      String(err)
    );
    throw err;
  }

  return { ok: true, seo };
}

// Spin up the worker when this module is run directly
if (require.main === module) {
  console.log("[seo-worker] Starting SEO worker on queue 'seo' ...");
  const worker = new Worker("seo", processor as any, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job) => {
    console.log(`[seo-worker] job completed id=${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[seo-worker] job failed id=${job?.id}`,
      err?.message || err
    );
  });
}

export default processor;
