// tools-render-engine/server.js
// Render-engine plugin for medx-ingest-api
// - Attaches /ingest for the AvidiaTech ingest pipeline (async callback flow)
// - Attaches /describe through gptInstructionsEnforcer
// - Attaches /central-gpt via mountCentralGpt so AvidiaTech can call a single GPT orchestrator
// - DOES NOT call app.listen; the root server.js owns the port.

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import crypto from "node:crypto";
import { mountCentralGpt } from "./central-gpt.mjs";

const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || "dev-secret";
const INGEST_SECRET = process.env.INGEST_SECRET || ENGINE_SECRET;
const INGEST_CALLBACK_TIMEOUT_MS = Number(
  process.env.INGEST_CALLBACK_TIMEOUT_MS || "10000"
) || 10000;

const INGEST_SELF_TIMEOUT_MS = Number(
  process.env.INGEST_SELF_TIMEOUT_MS || "60000"
) || 60000;

// If your root server runs on a different port, set this.
// In Render, this is usually the same process/port.
const SELF_BASE_URL =
  process.env.INGEST_SELF_BASE_URL ||
  (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : "http://127.0.0.1:3000");

/**
 * Best-effort HMAC verification for inbound /ingest calls from AvidiaTech.
 * We sign the *JSON string* of the body on the caller side, so we do the same here.
 */
function verifyIngestSignature(bodyObj, headerValue) {
  if (!INGEST_SECRET) {
    console.warn(
      "render-engine: INGEST_SECRET not set; skipping signature verification"
    );
    return true;
  }

  if (!headerValue) {
    console.warn(
      "render-engine: missing x-avidiatech-signature; allowing but logging"
    );
    return true;
  }

  try {
    const expected = crypto
      .createHmac("sha256", INGEST_SECRET)
      .update(JSON.stringify(bodyObj || {}))
      .digest("hex");

    if (expected !== headerValue) {
      console.warn(
        "render-engine: invalid ingest signature; expected %s got %s",
        expected,
        headerValue
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "render-engine: error while verifying ingest signature:",
      err && err.stack ? err.stack : String(err)
    );
    // Fail-open so we don't accidentally brick the pipeline.
    return true;
  }
}

function toNonEmptyString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function looksUrlDerivedName(name) {
  const s = String(name || "").toLowerCase();
  return (
    s.includes("http://") ||
    s.includes("https://") ||
    s.includes("www.") ||
    s.includes("product for ")
  );
}

function coerceSpecsObject(input) {
  const out = {};
  if (!input) return out;

  if (typeof input === "object" && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input)) {
      const kk = toNonEmptyString(k);
      const vv = toNonEmptyString(v);
      if (kk && vv) out[kk] = vv;
    }
    return out;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const key = toNonEmptyString(item.key);
      const val = toNonEmptyString(item.value);
      if (key && val) {
        out[key] = val;
        continue;
      }
      const entries = Object.entries(item);
      if (entries.length === 1) {
        const [k, v] = entries[0];
        const kk = toNonEmptyString(k);
        const vv = toNonEmptyString(v);
        if (kk && vv) out[kk] = vv;
      }
    }
    return out;
  }

  return out;
}

/**
 * Call the local "real" ingest logic (GET /ingest?url=...).
 * This reuses the canonical scraper/normalizer pipeline already implemented in the main server.
 */
async function callLocalIngest(url, options = {}) {
  const ingestUrl = new URL(`${SELF_BASE_URL.replace(/\/$/, "")}/ingest`);
  ingestUrl.searchParams.set("url", url);

  // Default flags for robust extraction (can be overridden by options)
  // These match patterns used elsewhere in repo (e.g. queueRoutes.js).
  ingestUrl.searchParams.set("harvest", "true");
  ingestUrl.searchParams.set("sanitize", "true");

  if (options.markdown === true) ingestUrl.searchParams.set("markdown", "true");
  if (options.debug === true) ingestUrl.searchParams.set("debug", "true");
  if (options.wait != null) ingestUrl.searchParams.set("wait", String(options.wait));
  if (options.timeout != null) ingestUrl.searchParams.set("timeout", String(options.timeout));
  if (options.mode != null) ingestUrl.searchParams.set("mode", String(options.mode));
  if (options.mainonly != null) ingestUrl.searchParams.set("mainonly", String(options.mainonly));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGEST_SELF_TIMEOUT_MS);

  try {
    const resp = await fetch(ingestUrl.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      const err = new Error(`local_ingest_failed status=${resp.status} body=${text.slice(0, 500)}`);
      err.status = resp.status;
      throw err;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`local_ingest_invalid_json body=${text.slice(0, 500)}`);
    }

    if (json && typeof json === "object" && json.error) {
      throw new Error(`local_ingest_error ${String(json.error)}`);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build a canonical Avidia Standard payload grounded from real scraped ingest output.
 * We DO NOT allow placeholder names like "Product for <url>".
 */
function buildAvidiaStandardNormalizedPayloadFromIngestResult(ingestResult, sourceUrl) {
  const nameRaw =
    toNonEmptyString(ingestResult?.name_raw) ||
    toNonEmptyString(ingestResult?.name_best) ||
    toNonEmptyString(ingestResult?.name) ||
    toNonEmptyString(ingestResult?.title) ||
    null;

  const name =
    nameRaw && !looksUrlDerivedName(nameRaw) ? nameRaw : null;

  const brand =
    toNonEmptyString(ingestResult?.brand) ||
    toNonEmptyString(ingestResult?.manufacturer) ||
    null;

  const specs =
    coerceSpecsObject(ingestResult?.specs) ||
    {};

  const specsCount = Object.keys(specs).length;

  if (!name) {
    const err = new Error("missing_or_placeholder_name");
    err.details = { nameRaw };
    throw err;
  }
  if (!specsCount) {
    const err = new Error("missing_specs");
    err.details = { specsCount };
    throw err;
  }

  return {
    format: "avidia_standard",
    name,
    brand: brand || null,
    specs,

    // extra grounding fields that avidia app may store/use
    name_raw: nameRaw,
    description_raw: toNonEmptyString(ingestResult?.description_raw) || null,
    features_raw: Array.isArray(ingestResult?.features_raw) ? ingestResult.features_raw : null,

    sku: toNonEmptyString(ingestResult?.sku) || toNonEmptyString(ingestResult?.mpn) || null,
    images: Array.isArray(ingestResult?.images) ? ingestResult.images : null,
    pdf_manual_urls: Array.isArray(ingestResult?.pdf_manual_urls) ? ingestResult.pdf_manual_urls : null,
  };
}

/**
 * Mounts all render-engine functionality onto an existing Express app.
 * This is called from the root server.js via:
 *
 *   import { mountRenderEngine } from "./tools/render-engine/server.js";
 *   await mountRenderEngine(app);
 */
export async function mountRenderEngine(app) {
  // Optional request logger (non-fatal if missing)
  try {
    const maybeLogger = require("./request-logger.js");
    if (typeof maybeLogger === "function") {
      maybeLogger(app, { prefix: "render-engine" });
    }
    console.log("render-engine: request-logger loaded");
  } catch (err) {
    console.warn(
      "render-engine: request-logger not found or failed to load:",
      err && err.message ? err.message : String(err)
    );
  }

  // Optional legacy describe-handler (kept for backwards compatibility)
  try {
    const maybeDescribe = require("./describe-handler.js");
    if (typeof maybeDescribe === "function") {
      maybeDescribe(app);
      console.log("render-engine: describe-handler loaded (external)");
    } else if (
      maybeDescribe &&
      typeof maybeDescribe.mountDescribeHandler === "function"
    ) {
      maybeDescribe.mountDescribeHandler(app);
      console.log("render-engine: mountDescribeHandler loaded (external)");
    }
  } catch (err) {
    console.warn(
      "render-engine: describe-handler not found or failed to load:",
      err && err.message ? err.message : String(err)
    );
  }

  // Mount central GPT orchestrator for AvidiaTech (SEO, Describe, etc.)
  try {
    await mountCentralGpt(app);
    console.log("render-engine: central GPT orchestrator mounted at /central-gpt");
  } catch (err) {
    console.error(
      "render-engine: failed to mount central GPT orchestrator:",
      err && err.stack ? err.stack : String(err)
    );
  }

  // POST /ingest – main AvidiaTech ingest entrypoint (async callback flow)
  console.log("render-engine: mounting POST /ingest handler for AvidiaTech ingest");
  app.post("/ingest", async (req, res) => {
    try {
      const headerSigRaw =
        req.headers["x-avidiatech-signature"] ||
        req.headers["X-AVIDIATECH-SIGNATURE"];
      const headerSig = Array.isArray(headerSigRaw)
        ? headerSigRaw[0]
        : headerSigRaw;

      if (!verifyIngestSignature(req.body, headerSig)) {
        return res.status(401).json({ ok: false, error: "invalid_signature" });
      }

      const {
        url,
        options,
        export_type,
        callback_url,
        job_id,
        correlation_id,
        tenant_id,
        action,
      } = req.body || {};

      if (!url || !callback_url || !job_id) {
        return res.status(400).json({
          ok: false,
          error: "missing_fields",
          details: { url: !!url, callback_url: !!callback_url, job_id: !!job_id },
        });
      }

      console.log(
        "render-engine: received ingest job %s url=%s callback_url=%s",
        job_id,
        url,
        callback_url
      );

      let ingestResult = null;
      let normalizedPayload = null;
      let error = null;

      try {
        // Reuse the real scraper/normalizer via local GET /ingest
        ingestResult = await callLocalIngest(url, options || {});
        normalizedPayload = buildAvidiaStandardNormalizedPayloadFromIngestResult(ingestResult, url);
      } catch (innerErr) {
        console.error(
          "render-engine: error during ingest for job %s:",
          job_id,
          innerErr && innerErr.stack ? innerErr.stack : String(innerErr)
        );
        error = innerErr;
      }

      const completedAt = new Date().toISOString();
      const status = error ? "failed" : "completed";

      const callbackBody = {
        ok: !error,
        job_id,
        ingestion_id: job_id, // We treat job_id === ingestionId in the dashboard.
        status,
        error: error ? String(error && error.message ? error.message : error) : null,

        // IMPORTANT: send real data (no null stubs)
        raw_payload: ingestResult,
        normalized_payload: normalizedPayload,
        seo_payload: ingestResult?.seo || null,
        specs_payload: ingestResult?.specs || null,
        manuals_payload: ingestResult?.manuals || ingestResult?.pdf_manual_urls || null,
        variants_payload: ingestResult?.variants || null,

        diagnostics: {
          engine: "render-engine",
          engine_version: "2025-12-28",
          correlation_id,
          tenant_id,
          export_type: export_type || "JSON",
          action: action || "ingest",
          completed_at: completedAt,
          self_base_url: SELF_BASE_URL,
        },
      };

      // Fire callback to the Next.js /api/v1/ingest/callback route
      if (callback_url) {
        console.log(
          "[render-engine] posting callback to %s for job %s",
          callback_url,
          job_id
        );
        try {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            INGEST_CALLBACK_TIMEOUT_MS
          );

          const callbackJson = JSON.stringify(callbackBody);
          const callbackSignature = INGEST_SECRET
            ? crypto
                .createHmac("sha256", INGEST_SECRET)
                .update(callbackJson)
                .digest("hex")
            : "";

          const resp = await fetch(callback_url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(callbackSignature
                ? { "x-avidiatech-signature": callbackSignature }
                : {}),
            },
            body: callbackJson,
            signal: controller.signal,
          });

          clearTimeout(timeout);

          let callbackText = "";
          try {
            callbackText = await resp.text();
          } catch {
            // ignore
          }

          console.log(
            "[render-engine] callback response status=%s body=%s",
            resp.status,
            callbackText
          );
        } catch (cbErr) {
          console.error(
            "[render-engine] callback error for job %s:",
            job_id,
            cbErr && cbErr.stack ? cbErr.stack : String(cbErr)
          );
        }
      }

      return res.status(202).json({
        ok: true,
        job_id,
        message: "ingest_completed_and_callback_sent",
      });
    } catch (err) {
      console.error(
        "render-engine: unexpected error in POST /ingest:",
        err && err.stack ? err.stack : String(err)
      );
      return res
        .status(500)
        .json({ ok: false, error: "internal_error", message: String(err) });
    }
  });
}

// Also export default for convenience, in case the root uses a default import.
export default mountRenderEngine;
