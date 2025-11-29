// Minimal, safe adapter: AvidiaExtract -> direct ingest API
// - Removes the old "ingest stub" flow and instead calls the ingest API (GET /ingest?url=...)
// - Applies lightweight normalization to unit tokens in string fields of the returned object
// - Non-blocking / defensive: returns ingest API JSON on success, throws clear errors on failures
//
// Usage:
//   const { extractAndIngest } = require('./services/avidiaExtractToIngest');
//   const result = await extractAndIngest('https://www.apple.com/iphone-17/');
//
// Environment variables:
//   INGEST_API_ENDPOINT  (default: https://medx-ingest-api.onrender.com)
//   INGEST_API_KEY       (optional) - will be sent in header "x-api-key" if present
//
// Note: This module intentionally keeps behavior simple: it delegates heavy scraping/normalization
// to the central ingest service, and only performs small local normalizations (unit casing).
// It is an augmentation to the existing AvidiaExtract logic: replace the old "write stub" / local persist
// step with a call to extractAndIngest(url) and return/promote its result.

const DEFAULT_INGEST = "https://medx-ingest-api.onrender.com";

// Use native fetch if available (Node 18+), otherwise try node-fetch
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    fetchFn = (...args) => import('node-fetch').then(m => m.default(...args));
  } catch (e) {
    // will surface below if fetch never available
  }
}

function normalizeUnitsInString(s = "") {
  if (!s || typeof s !== "string") return s;
  const map = {
    "\\bIN\\b": "in",
    "\\bINCHES?\\b": "in",
    "\\bFT\\b": "ft",
    "\\bCM\\b": "cm",
    "\\bMM\\b": "mm",
    "\\bM\\b": "m",
    "\\bLB\\b": "lb",
    "\\bLBS\\b": "lb",
    "\\bOZ\\b": "oz",
    "\\bML\\b": "mL",
    "\\bUL\\b": "µL",
    "\\bG\\b": "g",
    "\\bKG\\b": "kg"
  };
  let out = s;
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(k, "gi");
    out = out.replace(re, v);
  }
  // make "25mL" -> "25 mL"
  out = out.replace(/(\d)(mL|µL|cm|mm|in|ft|kg|g|lb|oz)\b/gi, (m, d, u) => `${d} ${u}`);
  return out;
}

// Walk object and normalize string fields (light-touch)
function normalizeUnitsDeep(obj) {
  if (Array.isArray(obj)) {
    return obj.map(normalizeUnitsDeep);
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = normalizeUnitsDeep(v);
    }
    return out;
  }
  if (typeof obj === "string") {
    return normalizeUnitsInString(obj);
  }
  return obj;
}

async function callIngestApiForUrl(targetUrl, opts = {}) {
  const ingestEndpoint = process.env.INGEST_API_ENDPOINT || DEFAULT_INGEST;
  const ingestKey = process.env.INGEST_API_KEY || opts.ingestApiKey || null;

  if (!fetchFn) {
    throw new Error("No fetch available in runtime. Install node-fetch or run on Node 18+.");
  }

  const fullUrl = `${ingestEndpoint.replace(/\/$/, "")}/ingest?url=${encodeURIComponent(targetUrl)}`;
  const headers = {
    "accept": "application/json"
  };
  if (ingestKey) headers["x-api-key"] = ingestKey;

  const resp = await fetchFn(fullUrl, { method: "GET", headers, timeout: 120000 });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const msg = `Ingest API request failed: ${resp.status} ${resp.statusText} ${txt ? `: ${txt.slice(0,200)}` : ""}`;
    const e = new Error(msg);
    e.status = resp.status;
    throw e;
  }
  const json = await resp.json().catch(async err => {
    const txt = await resp.text().catch(() => "");
    const e = new Error(`Invalid JSON from ingest API: ${err?.message || ""} -- body: ${txt.slice(0,300)}`);
    throw e;
  });
  return json;
}

/**
 * Main adapter function: given a target URL, call central ingest endpoint and return normalized result.
 * - Delegates scraping + heavy normalization to ingest service.
 * - Applies light normalization (units) to the returned JSON.
 *
 * @param {string} targetUrl - the URL to scrape/ingest (e.g., product page)
 * @param {object} [opts] - optional overrides { ingestApiKey }
 * @returns {object} - JSON result returned by ingest service (post-normalization)
 */
async function extractAndIngest(targetUrl, opts = {}) {
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new TypeError("extractAndIngest requires targetUrl string");
  }

  // call ingest API (which already performs scraping/processing)
  const ingestResult = await callIngestApiForUrl(targetUrl, opts);

  // light normalization/cleanup: unit casing, simple string cleanups
  const normalized = normalizeUnitsDeep(ingestResult);

  // additional lightweight cleanups could go here (e.g., trim long arrays, sanitize HTML, etc.)
  return normalized;
}

module.exports = {
  extractAndIngest,
  // exported for tests
  normalizeUnitsInString,
  normalizeUnitsDeep,
  callIngestApiForUrl
};
