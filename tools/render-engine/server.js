// tools-render-engine/server.js
// Render-engine plugin for medx-ingest-api
// - Attaches /ingest for the AvidiaTech ingest pipeline
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

  // POST /ingest – main AvidiaTech ingest entrypoint
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

      let normalizedPayload = null;
      let error = null;

      try {
        // For now we still use the demo runIngest implementation.
        // Later you will swap this for the real scraper/normalizer.
        const result = await runIngest(url, options || {});
        normalizedPayload = result && result.normalizedPayload ? result.normalizedPayload : result;
      } catch (innerErr) {
        console.error(
          "render-engine: error during runIngest for job %s:",
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
        raw_payload: null,
        normalized_payload: normalizedPayload,
        seo_payload: null,
        specs_payload: null,
        manuals_payload: null,
        variants_payload: null,
        diagnostics: {
          engine: "render-engine-demo",
          engine_version: "2025-12-01",
          correlation_id,
          tenant_id,
          export_type: export_type || "JSON",
          action: action || "ingest",
          completed_at: completedAt,
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

/**
 * Demo implementation of runIngest.
 * This is still the hard-coded stub that you will eventually replace
 * with the real scraper + normalizer.
 */
function runIngest(url, options = {}) {
  console.log("render-engine: runIngest demo implementation", { url, options });

  return {
    source_url: url,
    options,
    seo: {
      h1: `Product for ${url}`,
      title: `SEO title for ${url}`,
      description: `Short description for ${url}`,
    },
    features: [
      `Key feature for ${url}`,
      "Secondary feature",
    ],
    description_html: `<p>Sample description generated for ${url}. Replace runIngest() with real scraper output.</p>`,
    normalizedPayload: {
      name: `Product for ${url}`,
      brand: null,
      specs: {},
      format: "avidia_standard",
    },
  };
}

// Also export default for convenience, in case the root uses a default import.
export default mountRenderEngine;
