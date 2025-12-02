// seo-worker.ts - BullMQ worker that runs the GPT_SEO module
// Place: medx-ingest-api/workers/seo/seo-worker.ts
//
// Behavior:
//  - Listens on queue 'seo'
//  - Payload expected: { jobId, tenant_id, raw_payload, correlation_id }
//  - Calls central GPT via central-gpt-client.ts
//  - Validates output with zod (seo-schema.ts)
//  - Writes module result to Supabase product_ingestions.normalized_payload (update existing row by id)
//    and sets status/completed_at, diagnostics, attempts_count, etc.
//
// Env required:
//  - REDIS_URL
//  - CENTRAL_GPT_URL, CENTRAL_GPT_KEY (if used)
//  - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "@supabase/supabase-js";
import { getQueue, createWorker } from "../queue";
import { callCentralGpt } from "../gpt/central-gpt-client";
import { SeoSchema } from "../gpt/schemas/seo-schema";

// Lazy make supabase client
function getSupabase() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE envs required");
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// Processor fn for the worker
async function processor(job) {
  const supabase = getSupabase();
  const payload = job.data || {};
  const { jobId, tenant_id, raw_payload, correlation_id } = payload;

  const now = new Date().toISOString();

  console.info(`[seo-worker] start job=${jobId} correlation_id=${correlation_id}`);

  // defensive: ensure jobId exists
  if (!jobId) {
    throw new Error("Missing jobId in seo job payload");
  }

  // Mark started_at and bump attempts_count (best-effort)
  try {
    await supabase
      .from("product_ingestions")
      .update({
        started_at: now,
        last_attempt_at: now,
        attempts_count: (0), // we'll read+increment below to avoid race in some DBs, but set base here if missing
      })
      .eq("id", jobId);
  } catch (e) {
    // non-fatal, proceed
    console.warn(`[seo-worker] could not mark started_at for job=${jobId}`, String(e));
  }

  // Read existing row (we need diagnostics and existing normalized payload)
  const { data: existing, error: selectErr } = await supabase
    .from("product_ingestions")
    .select("normalized_payload, diagnostics, attempts_count, status")
    .eq("id", jobId)
    .single();

  if (selectErr) {
    console.warn(`[seo-worker] product_ingestions row not found for id=${jobId}`, selectErr.message || selectErr);
    // Continue — we will still try to update by id (it will fail and surface error so operator can fix)
  }

  // Build a deterministic SEO prompt (central GPT backend will apply your prompt templates)
  const prompt = JSON.stringify({
    raw_title: raw_payload?.title || raw_payload?.name || "",
    raw_description: raw_payload?.description || raw_payload?.long_description || raw_payload?.summary || "",
    raw_bullets: raw_payload?.bullets || raw_payload?.features || [],
  });

  const system = "You are an ecommerce SEO writer. Output JSON with keys: h1,title,meta_description,seo_short_description. Title <= 60 chars, meta <= 155 chars, h1 <= 110 chars. Return only valid JSON.";

  // Call central GPT backend
  let gptResp;
  try {
    gptResp = await callCentralGpt({ system, prompt, max_tokens: 500, metadata: { module: "seo", correlation_id } });
  } catch (err) {
    const errText = String(err);
    console.error(`[seo-worker] central GPT call failed for job=${jobId}`, errText);
    // persist diagnostic and increment attempts
    try {
      await supabase.from("product_ingestions").update({
        diagnostics: { ...(existing?.diagnostics || {}), seo_call_error: errText },
        last_attempt_at: now,
        attempts_count: (existing?.attempts_count || 0) + 1,
        last_error: errText
      }).eq("id", jobId);
    } catch (uErr) {
      console.error(`[seo-worker] failed to write diagnostics for job=${jobId}`, String(uErr));
    }
    throw err;
  }

  if (!gptResp || !gptResp.output) {
    const errText = "Empty response from GPT";
    console.error(`[seo-worker] ${errText} job=${jobId}`);
    await supabase.from("product_ingestions").update({
      diagnostics: { ...(existing?.diagnostics || {}), seo_raw_output: gptResp?.output ?? null },
      last_attempt_at: now,
      attempts_count: (existing?.attempts_count || 0) + 1,
      last_error: errText
    }).eq("id", jobId);
    throw new Error(errText);
  }

  // Attempt to parse JSON output
  let parsed;
  try {
    parsed = typeof gptResp.output === "string" ? JSON.parse(gptResp.output) : gptResp.output;
  } catch (err) {
    const errText = String(err);
    console.warn(`[seo-worker] Failed to parse GPT output for job=${jobId}`, errText);
    // Save raw output and error
    try {
      await supabase.from("product_ingestions").update({
        diagnostics: { ...(existing?.diagnostics || {}), seo_raw_output: gptResp.output, seo_error: errText },
        last_attempt_at: now,
        attempts_count: (existing?.attempts_count || 0) + 1,
        last_error: errText
      }).eq("id", jobId);
    } catch (uErr) {
      console.error(`[seo-worker] failed to persist parse error for job=${jobId}`, String(uErr));
    }
    throw new Error("Failed to parse GPT JSON output: " + errText);
  }

  // Validate with zod
  const parseResult = SeoSchema.safeParse(parsed);
  if (!parseResult.success) {
    const validationText = JSON.stringify(parseResult.error.format());
    console.warn(`[seo-worker] SEO schema validation failed for job=${jobId}`, validationText);
    // Save validation errors and raw output for debugging, then fail this job
    await supabase.from("product_ingestions").update({
      diagnostics: { ...(existing?.diagnostics || {}), seo_validation: parseResult.error.format(), seo_raw_output: parsed },
      last_attempt_at: now,
      attempts_count: (existing?.attempts_count || 0) + 1,
      last_error: "SEO schema validation failed"
    }).eq("id", jobId);
    throw new Error("SEO schema validation failed");
  }

  const seo: any = parseResult.data;

  // Persist module into the normalized payload (merge) -- set seo field
  try {
    const normalized = (existing?.normalized_payload && typeof existing.normalized_payload === "object") ? existing.normalized_payload : {};
    normalized.seo = seo;

    // Build diagnostics merge
    const newDiagnostics = { ...(existing?.diagnostics || {}), seo_tokens: gptResp.tokens || null };

    // Prepare update payload with metadata and status
    const updatePayload: any = {
      normalized_payload: normalized,
      diagnostics: newDiagnostics,
      status: "completed",
      completed_at: new Date().toISOString(),
      last_attempt_at: now,
      last_error: null,
      attempts_count: (existing?.attempts_count || 0) + 1
    };

    const { error } = await supabase.from("product_ingestions").update(updatePayload).eq("id", jobId);

    if (error) {
      console.error(`[seo-worker] Failed to write SEO result to DB for job=${jobId}`, error);
      // try fallback by job_id (some installs use job_id column)
      try {
        const { error: error2 } = await supabase.from("product_ingestions").update(updatePayload).eq("job_id", jobId);
        if (error2) {
          throw new Error("Fallback update by job_id failed: " + JSON.stringify(error2));
        }
      } catch (fbErr) {
        // persist diagnostics and throw
        await supabase.from("product_ingestions").update({
          diagnostics: { ...(existing?.diagnostics || {}), seo_write_error: JSON.stringify(error) },
          last_attempt_at: now,
          attempts_count: (existing?.attempts_count || 0) + 1,
          last_error: String(error)
        }).eq("id", jobId).catch(()=>null);
        throw new Error("Failed to write SEO result to DB: " + JSON.stringify(error));
      }
    }

    console.info(`[seo-worker] completed job=${jobId} seo persisted`);
  } catch (err) {
    console.error(`[seo-worker] error persisting seo for job=${jobId}`, String(err));
    throw err;
  }

  // Optionally emit a 'module:done' job or update status — depends on your orchestration
  return { ok: true, seo };
}

// Create the worker when this module is invoked directly
if (require.main === module) {
  console.log("Starting SEO worker...");
  createWorker("seo", processor, { concurrency: 1 });
}

export default processor;
