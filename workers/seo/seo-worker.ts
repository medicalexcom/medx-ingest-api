// workers/seo/seo-worker.ts
// BullMQ worker that runs the GPT_SEO / AvidiaSEO module for a given ingestion.
//
// Design:
// - This worker is OPTIONAL. If REDIS_URL is not set, it logs a warning and no worker is started.
// - When enabled, it consumes jobs from a BullMQ queue (default name: "seo").
// - Each job payload is expected to contain { ingestionId, userId?, tenantId? }.
// - For each job, the worker calls the AvidiaTech app's /api/v1/seo endpoint,
//   which already knows how to:
//     * load product_ingestions by ingestionId from Supabase
//     * call CENTRAL_GPT_URL / CENTRAL_GPT_KEY (if configured) OR fall back to normalized_payload
//     * write seo_payload, description_html, features, seo_generated_at back to Supabase.
//
// This keeps all the SEO shaping logic centralized in the AvidiaTech app, and the
// ingest-api only needs to fire jobs when/if you decide to use background SEO.

import type { Job, WorkerOptions } from "bullmq";
import { Worker } from "bullmq";

// ----- Environment configuration -------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "";
// Base URL of the AvidiaTech app that exposes POST /api/v1/seo
// You can override this in Render/Vercel if needed.
const AVIDIA_APP_BASE_URL =
  process.env.AVIDIA_APP_BASE_URL || "https://app.avidiatech.com";

// Optional internal key if your /api/v1/seo route checks for it
const AVIDIA_INTERNAL_WORKER_KEY =
  process.env.AVIDIA_INTERNAL_WORKER_KEY || "";

// Queue name; keep this in sync with whatever enqueues SEO jobs.
const SEO_QUEUE_NAME = process.env.SEO_QUEUE_NAME || "seo";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SeoJobPayload {
  ingestionId: string;
  userId?: string | null;
  tenantId?: string | null;
  // You can add more fields later without breaking this worker,
  // as long as ingestionId remains present.
}

// -----------------------------------------------------------------------------
// Core processor logic
// -----------------------------------------------------------------------------

async function runSeoForIngestion(job: Job<SeoJobPayload>) {
  const { ingestionId, userId, tenantId } = job.data || {};

  if (!ingestionId) {
    const msg = "[seo-worker] job missing ingestionId; skipping";
    console.warn(msg, { jobId: job.id, data: job.data });
    await job.log(msg);
    return { ok: false, error: "missing_ingestionId" };
  }

  const url = `${AVIDIA_APP_BASE_URL.replace(/\/+$/, "")}/api/v1/seo`;

  const payload: Record<string, unknown> = {
    ingestionId,
    // Optional context (the /api/v1/seo handler can ignore these if it wants)
    userId: userId ?? undefined,
    tenantId: tenantId ?? undefined,
    trigger: "seo-worker",
  };

  let res: Response;
  let bodyText = "";

  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(AVIDIA_INTERNAL_WORKER_KEY
          ? { "x-internal-worker-key": AVIDIA_INTERNAL_WORKER_KEY }
          : {}),
      },
      body: JSON.stringify(payload),
    });

    bodyText = await res.text();
  } catch (err: any) {
    const msg = `[seo-worker] network error calling ${url}: ${
      err?.message || String(err)
    }`;
    console.error(msg);
    await job.log(msg);
    throw err;
  }

  let json: any = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // Not fatal; we still have bodyText for debugging.
  }

  if (!res.ok) {
    const msg = `[seo-worker] /api/v1/seo returned ${res.status}: ${
      json ? JSON.stringify(json) : bodyText
    }`;
    console.error(msg);
    await job.log(msg);
    // Re-throw so BullMQ marks job as failed.
    throw new Error(msg);
  }

  const msg = `[seo-worker] SEO generated for ingestion ${ingestionId}`;
  console.log(msg);
  await job.log(msg);

  return {
    ok: true,
    status: res.status,
    body: json ?? bodyText,
  };
}

// This is the function BullMQ will use as the processor.
export async function processSeoJob(job: Job<SeoJobPayload>) {
  try {
    return await runSeoForIngestion(job);
  } catch (err: any) {
    console.error(
      "[seo-worker] processSeoJob error:",
      err?.message || String(err)
    );
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Worker bootstrap (side-effect on import)
// -----------------------------------------------------------------------------

// If REDIS_URL is not set, we do NOT start a worker.
// This keeps the ingest-api deploy stable even if Redis is not configured yet.
if (!REDIS_URL) {
  console.warn(
    "[seo-worker] REDIS_URL not set; SEO BullMQ worker will NOT be started. " +
      "This is fine if you're running SEO synchronously via /api/v1/seo only."
  );
} else {
  const workerOptions: WorkerOptions = {
    connection: { url: REDIS_URL },
    concurrency: 1,
  };

  const worker = new Worker<SeoJobPayload>(
    SEO_QUEUE_NAME,
    processSeoJob,
    workerOptions
  );

  worker.on("completed", (job, result) => {
    console.log(
      "[seo-worker] job completed",
      { jobId: job.id, ingestionId: job.data?.ingestionId },
      { result }
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      "[seo-worker] job failed",
      { jobId: job?.id, ingestionId: job?.data?.ingestionId },
      err
    );
  });

  console.log(
    `[seo-worker] BullMQ worker started on queue "${SEO_QUEUE_NAME}" with concurrency=1`
  );
}
