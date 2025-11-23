// seo-worker.ts - BullMQ worker that runs the GPT_SEO module
// Place: medx-ingest-api/workers/seo/seo-worker.ts
//
// Behavior:
//  - Listens on queue 'seo'
//  - Payload expected: { jobId, tenant_id, raw_payload, correlation_id }
//  - Calls central GPT via central-gpt-client.ts
//  - Validates output with zod (seo-schema.ts)
//  - Writes module result to Supabase product_ingestions.normalized_payload or a dedicated modules table
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

  // Build a deterministic SEO prompt (central GPT backend will apply your prompt templates)
  const prompt = JSON.stringify({
    raw_title: raw_payload?.title || "",
    raw_description: raw_payload?.description || "",
    raw_bullets: raw_payload?.bullets || [],
  });

  const system = "You are an ecommerce SEO writer. Output JSON with keys: h1,title,meta_description,seo_short_description. Title <= 60 chars, meta <= 155 chars, h1 <= 110 chars. Return only valid JSON.";

  // Call central GPT backend
  const gptResp = await callCentralGpt({ system, prompt, max_tokens: 500, metadata: { module: "seo", correlation_id } });

  if (!gptResp || !gptResp.output) {
    throw new Error("Empty response from GPT");
  }

  // Attempt to parse JSON output
  let parsed;
  try {
    parsed = typeof gptResp.output === "string" ? JSON.parse(gptResp.output) : gptResp.output;
  } catch (err) {
    // Optionally retry or save raw output into diagnostics
    const errText = String(err);
    await supabase.from("product_ingestions").update({
      diagnostics: { seo_raw_output: gptResp.output, seo_error: errText },
    }).eq("id", jobId);
    throw new Error("Failed to parse GPT JSON output: " + errText);
  }

  // Validate with zod
  const parseResult = SeoSchema.safeParse(parsed);
  if (!parseResult.success) {
    // Save validation errors and raw output for debugging, then fail this job
    await supabase.from("product_ingestions").update({
      diagnostics: { seo_validation: parseResult.error.format(), seo_raw_output: parsed },
    }).eq("id", jobId);
    throw new Error("SEO schema validation failed");
  }

  const seo: any = parseResult.data;

  // Persist module into the normalized payload (merge) -- naive approach: set seo field
  // Note: For concurrency, consider using a modules table or row-level locks
  const { data: existing } = await supabase.from("product_ingestions").select("normalized_payload").eq("id", jobId).single();

  const normalized = existing?.normalized_payload || {};
  normalized.seo = seo;

  const { error } = await supabase.from("product_ingestions").update({
    normalized_payload: normalized,
    diagnostics: { ...(existing?.diagnostics || {}), seo_tokens: gptResp.tokens || null },
  }).eq("id", jobId);

  if (error) {
    throw new Error("Failed to write SEO result to DB: " + JSON.stringify(error));
  }

  // Optionally emit a 'module:done' job or update status — depends on your orchestration
  return { ok: true, seo };
}

// Create the worker when this module is invoked directly
if (require.main === module) {
  const { createWorker } = require("../queue");
  console.log("Starting SEO worker...");
  createWorker("seo", processor, { concurrency: 1 });
}

export default processor;
