#!/usr/bin/env node
// scripts/test-extract.js
// Usage:
//   node scripts/test-extract.js "https://www.apple.com/iphone-17/"
// Env:
//   INGEST_API_ENDPOINT (optional) - default https://medx-ingest-api.onrender.com
//   INGEST_API_KEY (optional)      - if medx-ingest-api requires an api key
//
// This script will call the central ingest endpoint and print a short summary of the response.
// It uses the services/avidiaExtractToIngest adapter if present; otherwise it does a direct fetch.

const DEFAULT_INGEST = process.env.INGEST_API_ENDPOINT || "https://medx-ingest-api.onrender.com";
const targetUrl = process.argv[2] || "https://www.apple.com/iphone-17/";
const ingestKey = process.env.INGEST_API_KEY || null;

async function callDirectIngest(url) {
  // Use global fetch if available (Node 18+), otherwise dynamic import node-fetch
  let fetchFn = globalThis.fetch;
  if (!fetchFn) {
    try {
      const m = await import("node-fetch");
      fetchFn = m.default;
    } catch (err) {
      console.error("node-fetch not available. Install node-fetch or run on Node 18+.");
      throw err;
    }
  }

  const ingestUrl = `${DEFAULT_INGEST.replace(/\/$/, "")}/ingest?url=${encodeURIComponent(url)}`;
  const headers = { accept: "application/json" };
  if (ingestKey) headers["x-api-key"] = ingestKey;

  const resp = await fetchFn(ingestUrl, { method: "GET", headers, timeout: 120000 });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const err = new Error(`Ingest API returned ${resp.status} ${resp.statusText}: ${txt}`);
    err.status = resp.status;
    throw err;
  }
  const json = await resp.json();
  return json;
}

async function run() {
  console.log("Target URL:", targetUrl);
  console.log("Ingest endpoint:", DEFAULT_INGEST);
  console.log("Using adapter if available...");

  try {
    // Prefer local adapter if present
    let result = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const adapter = require("../services/avidiaExtractToIngest");
      if (adapter && typeof adapter.extractAndIngest === "function") {
        console.log("Calling local adapter: services/avidiaExtractToIngest.extractAndIngest");
        result = await adapter.extractAndIngest(targetUrl, { ingestApiKey: ingestKey });
      } else {
        throw new Error("adapter not present");
      }
    } catch (errAdapter) {
      console.log("Local adapter not found or failed, falling back to direct ingest call:", errAdapter.message);
      result = await callDirectIngest(targetUrl);
    }

    // Print summary
    console.log("=== Ingest result summary ===");
    if (!result || typeof result !== "object") {
      console.log("No JSON returned or not an object. Raw result:", result);
      process.exit(1);
    }
    const keys = Object.keys(result);
    console.log("Top-level keys:", keys.join(", "));
    // Print some fields if present
    if (result.name_best) console.log("name_best:", result.name_best);
    if (result.short_name_60) console.log("short_name_60:", result.short_name_60);
    if (result.desc_audit) console.log("desc_audit:", JSON.stringify(result.desc_audit, null, 2));
    if (result.pdf_manual_urls) console.log("pdf_manual_urls:", JSON.stringify(result.pdf_manual_urls, null, 2));
    const s = JSON.stringify(result, null, 2);
    if (s.length <= 2000) console.log("Full JSON:\n", s);
    else console.log("Result size:", s.length, "chars; first 2000 chars:\n", s.slice(0, 2000));
    console.log("=== End summary ===");
    process.exit(0);
  } catch (err) {
    console.error("ERROR calling ingest API:", err?.message || err);
    if (err.stack) console.error(err.stack);
    process.exit(2);
  }
}

run();
