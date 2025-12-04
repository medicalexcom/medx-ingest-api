// tools/render-engine/server.js
// Render-engine plugin for medx-ingest-api
// - Attaches /describe + related logic to an existing Express app
// - Attaches POST /ingest for AvidiaTech ingest pipeline
// - DOES NOT call app.listen; root server.js owns the port

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import crypto from "node:crypto";
import OpenAI from "openai";

const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || "dev-secret";
const INGEST_SECRET = process.env.INGEST_SECRET || ENGINE_SECRET;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const fetchFn = globalThis.fetch;

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// ---------- HMAC helper (must match AvidiaTech app side) ----------
function verifyIngestSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody, "utf8");
    const digest = hmac.digest("hex");
    return digest === signature;
  } catch (e) {
    console.error("verifyIngestSignature error:", e);
    return false;
  }
}

// ---------- Internal helper: simple ingest implementation ----------
async function runIngest(url, options) {
  // TODO: replace this with your real scraping / normalization logic.
  // For now this returns a deterministic sample payload so the pipeline works end-to-end.
  return {
    source_url: url,
    options: options || {},
    seo: {
      h1: `Product for ${url}`,
      title: `SEO title for ${url}`,
      pageTitle: `SEO title for ${url}`,
      metaTitle: `SEO title for ${url}`,
      metaDescription: `SEO meta description for ${url}`,
      seoShortDescription: `Short SEO summary for ${url}`,
    },
    description_html: `<p>Sample description generated for ${url}. Replace runIngest() with real scraper output.</p>`,
    features: [`Key feature for ${url}`, "Secondary feature"],
    normalizedPayload: {
      name: `Product for ${url}`,
      brand: null,
      specs: {},
      format: "avidia_standard",
    },
  };
}

// ---------- Main entry: called from root server.js ----------
export function mountRenderEngine(app) {
  // ---------------------------------------------------------------------------
  // Optional request-logger
  // ---------------------------------------------------------------------------
  try {
    const reqLogger = require("./request-logger");
    (reqLogger.default || reqLogger)(app);
    console.log("render-engine: request-logger loaded");
  } catch (e) {
    console.warn(
      "render-engine: request-logger not found or failed to load:",
      e?.message || e
    );
  }

  // ---------------------------------------------------------------------------
  // /describe: external handler > proxy > internal fallback
  // ---------------------------------------------------------------------------
  let hasDescribeHandler = false;
  try {
    const handler = require("./describe-handler");
    (handler.default || handler)(app);
    hasDescribeHandler = true;
    console.log("render-engine: describe-handler loaded (external)");
  } catch (e) {
    console.warn(
      "render-engine: describe-handler not found or failed to load:",
      e?.message || e
    );
  }

  let hasDescribeProxy = false;
  if (!hasDescribeHandler) {
    try {
      const proxy = require("./describe-proxy");
      (proxy.default || proxy)(app, { targetPath: "/api/v1/describe" });
      hasDescribeProxy = true;
      console.log(
        "render-engine: describe-proxy loaded (will proxy /describe to internal path)"
      );
    } catch (e) {
      console.warn(
        "render-engine: describe-proxy not found or failed to load:",
        e?.message || e
      );
    }
  }

  if (!hasDescribeHandler && !hasDescribeProxy) {
    console.log(
      "render-engine: no external describe handler or proxy — mounting internal /describe implementation"
    );

    app.post("/describe", async (req, res) => {
      const key = req.header("x-engine-key");
      if (!key || key !== ENGINE_SECRET) {
        console.warn("describe: unauthorized key", {
          headerKeyProvided: !!key,
        });
        return res
          .status(401)
          .json({ error: "unauthorized: invalid engine key" });
      }

      const body = req.body || {};
      const name = body.name || "Sample product";
      const shortDescription = body.shortDescription || "Short description";

      try {
        let response;
        if (openai) {
          // OpenAI v4 client
          const prompt = `You are a normalization pipeline. Input:
name: ${name}
shortDescription: ${shortDescription}
brand: ${body.brand || ""}
specs: ${JSON.stringify(body.specs || {})}
format: ${body.format || "avidia_standard"}
---
Return ONLY JSON with fields: descriptionHtml, sections, seo, normalizedPayload, raw.
Sections must contain overview, features (array), specsSummary, includedItems, manualsSectionHtml.
SEO must contain h1, pageTitle, metaDescription, seoShortDescription.
`;

          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You output machine-readable JSON according to instructions.",
              },
              { role: "user", content: prompt },
            ],
            max_tokens: 1000,
            temperature: 0.2,
          });

          const text =
            completion.choices?.[0]?.message?.content?.trim() ?? "";

          try {
            response = JSON.parse(text);
          } catch (e) {
            console.warn(
              "OpenAI returned non-JSON; falling back to deterministic shape",
              e?.message
            );
            response = {
              descriptionHtml: `<p>${shortDescription}</p>`,
              sections: {
                overview: `${shortDescription}`,
                features: [`Feature A for ${name}`, "Feature B"],
                specsSummary: body.specs || {},
                includedItems: [],
                manualsSectionHtml: "",
              },
              seo: {
                h1: name,
                pageTitle: `${name} - Buy now`,
                metaDescription: shortDescription,
                seoShortDescription: shortDescription,
              },
              normalizedPayload: {
                name,
                brand: body.brand ?? null,
                specs: body.specs ?? null,
                format: body.format ?? "avidia_standard",
              },
              raw: { modelText: text, request: body },
            };
          }
        } else {
          // No OpenAI key: deterministic mock
          response = {
            descriptionHtml: `<p>${shortDescription}</p>`,
            sections: {
              overview: `${shortDescription}`,
              features: [`Feature A for ${name}`, "Feature B"],
              specsSummary: body.specs || {},
              includedItems: [],
              manualsSectionHtml: "",
            },
            seo: {
              h1: name,
              pageTitle: `${name} - Buy now`,
              metaDescription: shortDescription,
              seoShortDescription: shortDescription,
            },
            normalizedPayload: {
              name,
              brand: body.brand ?? null,
              specs: body.specs ?? null,
              format: body.format ?? "avidia_standard",
            },
            raw: { request: body },
          };
        }

        return res.json(response);
      } catch (err) {
        console.error("render-engine /describe error:", err);
        return res
          .status(500)
          .json({ error: "internal render error", details: String(err) });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // New: POST /ingest for AvidiaTech ingest pipeline
  // ---------------------------------------------------------------------------
  console.log(
    "render-engine: mounting POST /ingest handler for AvidiaTech ingest"
  );

  app.post("/ingest", async (req, res) => {
    try {
      if (!INGEST_SECRET) {
        console.error(
          "render-engine: INGEST_SECRET/RENDER_ENGINE_SECRET not configured"
        );
        return res.status(500).json({ error: "server_misconfigured" });
      }

      const rawBody = JSON.stringify(req.body || {});
      const signature = req.header("x-avidiatech-signature") || "";

      if (!verifyIngestSignature(rawBody, signature, INGEST_SECRET)) {
        console.warn("render-engine: invalid signature on /ingest");
        return res.status(401).json({ error: "invalid_signature" });
      }

      const { job_id, url, options, callback_url, correlation_id } =
        req.body || {};

      if (!job_id || !url || !callback_url) {
        console.warn("render-engine: missing required fields on /ingest", {
          job_id: !!job_id,
          url: !!url,
          callback_url: !!callback_url,
        });
        return res.status(400).json({ error: "missing_required_fields" });
      }

      console.log(
        "[render-engine] received ingest job",
        job_id,
        "url=",
        url,
        "callback_url=",
        callback_url
      );

      const normalized = await runIngest(url, options);

      const callbackPayload = {
        job_id,
        status: "completed",
        normalized_payload: normalized,
        diagnostics: {
          engine: "medx-ingest-api",
          correlation_id: correlation_id || null,
          finished_at: new Date().toISOString(),
        },
      };

      const callbackBody = JSON.stringify(callbackPayload);

      if (!fetchFn) {
        console.error(
          "render-engine: no fetch available; cannot send callback"
        );
        return res.status(500).json({ error: "callback_unavailable" });
      }

      const hmac = crypto.createHmac("sha256", INGEST_SECRET);
      hmac.update(callbackBody, "utf8");
      const callbackSig = hmac.digest("hex");

      console.log(
        "[render-engine] posting callback to",
        callback_url,
        "for job",
        job_id
      );

      const callbackRes = await fetchFn(callback_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-avidiatech-signature": callbackSig,
        },
        body: callbackBody,
      });

      const callbackText = await callbackRes.text();

      if (!callbackRes.ok) {
        console.error(
          "[render-engine] callback failed:",
          callbackRes.status,
          callbackText
        );
        return res.status(202).json({
          ok: false,
          message: "callback_failed",
          statusCode: callbackRes.status,
        });
      }

      console.log(
        "[render-engine] callback success for job",
        job_id,
        "response:",
        callbackText
      );

      return res.status(202).json({
        ok: true,
        job_id,
        message: "ingest_completed_and_callback_sent",
      });
    } catch (err) {
      console.error("[render-engine] /ingest error:", err);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ---------------------------------------------------------------------------
  // gptInstructionsEnforcer (Describe route enforcer) on same app
  // ---------------------------------------------------------------------------
  (async () => {
    try {
      const mod = await import("./gptInstructionsEnforcer.mjs");
      if (mod && typeof mod.mountDescribeRoute === "function") {
        await mod.mountDescribeRoute(app);
        console.log("render-engine: mountDescribeRoute completed successfully");
      } else {
        console.warn(
          "render-engine: gptInstructionsEnforcer.mjs loaded but mountDescribeRoute not found"
        );
      }
    } catch (err) {
      console.error(
        "render-engine: mountDescribeRoute failed during startup:",
        err && err.stack ? err.stack : String(err)
      );
    }
  })();
}
