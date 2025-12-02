#!/usr/bin/env node
// run-seo-job.js
// Usage: node scripts/run-seo-job.js <jobId>
// This imports the seo worker processor and runs it locally.
// Requires SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY and any GPT envs needed by callCentralGpt.

const path = require("path");

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node scripts/run-seo-job.js <jobId>");
    process.exit(1);
  }

  // Ensure envs needed by the worker are set: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, (CENTRAL_GPT_URL/KEY if used)
  console.log("running seo processor locally for jobId:", jobId);
  try {
    // require the compiled JS worker module. If project is TS-only, transpile first or change require path.
    const workerPath = path.resolve(__dirname, "../workers/seo/seo-worker.js");
    const processor = require(workerPath).default;
    // call the processor with a fake job object structured as the real queue would pass
    const result = await processor({ data: { jobId, tenant_id: null, raw_payload: { title: "Test run", description: "Test description" }, correlation_id: "localtest" } });
    console.log("processor result:", result);
  } catch (err) {
    console.error("processor error:", err && err.stack ? err.stack : err);
    process.exit(2);
  }
}

main();
