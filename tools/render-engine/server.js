// Robust Render engine entrypoint for medx-ingest-api
// - Loads request-logger (if present)
// - Prefer a local describe-handler (if present)
// - Otherwise, prefer a describe-proxy (if present)
// - Otherwise, expose an internal /describe implementation (calls OpenAI if OPENAI_API_KEY set, else returns a deterministic mock)
// - Also exposes /ingest for AvidiaTech ingestion engine callbacks.
// - Listens on process.env.PORT and binds to 0.0.0.0
//
// Notes:
// - Ensure RENDER_ENGINE_SECRET is set in Render and matches Vercel for /describe calls.
// - Ensure INGEST_SECRET (or fallback RENDER_ENGINE_SECRET) matches Vercel INGEST_SECRET for /ingest calls.
// - Start command on Render should be: node tools/render-engine/server.js
//   (or node server.js with a root shim that requires this file).
// - This file logs module load status so you can confirm the running code in Render logs.

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { Configuration, OpenAIApi } = require("openai");

const app = express();

// Ensure we parse JSON bodies before any handlers (request-logger may expect req.body)
app.use(express.json({ limit: "2mb" }));
app.use(bodyParser.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8081;
const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || "dev-secret";
// For ingest HMAC: prefer explicit INGEST_SECRET, fallback to ENGINE_SECRET so
// you don't have to add a new env if you keep them the same.
const INGEST_SECRET = process.env.INGEST_SECRET || ENGINE_SECRET;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

// ---- helper: fetch compatible with Node < 18 (optional) ----
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    // If node-fetch is installed, use it as a fallback
    // (if not, you'll see a clear error in logs).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fetchFn = require("node-fetch");
  } catch (e) {
    console.warn(
      "No global fetch and node-fetch not available; callbacks will fail:",
      e?.message || e
    );
  }
}

// ---- helper: verify HMAC signature (same as AvidiaTech ingest) ----
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

// Try to load request-logger (optional)
try {
  // If you placed it in a subfolder adjust the path, e.g. './tools/render-engine/request-logger'
  require("./request-logger")(app);
  console.log("request-logger loaded");
} catch (e) {
  console.warn(
    "request-logger not found or failed to load:",
    e?.message || e
  );
}

// If a dedicated describe-handler exists, prefer it and do not mount internal fallback
let hasDescribeHandler = false;
try {
  require("./describe-handler")(app);
  hasDescribeHandler = true;
  console.log("describe-handler loaded (external)");
} catch (e) {
  console.warn(
    "describe-handler not found or failed to load:",
    e?.message || e
  );
}

// If a describe-proxy exists and no external handler, load it (it will mount /describe)
let hasDescribeProxy = false;
if (!hasDescribeHandler) {
  try {
    require("./describe-proxy")(app, { targetPath: "/api/v1/describe" });
    hasDescribeProxy = true;
    console.log(
      "describe-proxy loaded (will proxy /describe to internal path)"
    );
  } catch (e) {
    console.warn(
      "describe-proxy not found or failed to load:",
      e?.message || e
    );
  }
}

// If neither describe-handler nor describe-proxy were loaded, mount an internal /describe implementation
if (!hasDescribeHandler && !hasDescribeProxy) {
  console.log(
    "No external describe handler or proxy found — mounting internal /describe implementation"
  );

  // Health endpoint (also present in other files)
  app.get("/healthz", (req, res) => res.json({ ok: true }));

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
      if (OPENAI_KEY) {
        const configuration = new Configuration({ apiKey: OPENAI_KEY });
        const client = new OpenAIApi(configuration);

        // Instruct model to output JSON ONLY in required shape
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

        const completion = await client.createChatCompletion({
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

        const text = completion.data.choices?.[0]?.message?.content ?? "";
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
        // No OpenAI key: return deterministic mock
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
      console.error("render engine error:", err);
      return res
        .status(500)
        .json({ error: "internal render error", details: String(err) });
    }
  });

  // Help GET for debugging
  app.get("/describe", (req, res) => {
    res
      .status(200)
      .send("POST /describe is supported; send JSON body with x-engine-key header.");
  });
} else {
  // Ensure /healthz exists even if external modules were loaded
  app.get("/healthz", (req, res) => res.json({ ok: true }));
}

// -----------------------------------------------------------------------------
// New: /ingest endpoint for AvidiaTech ingestion engine
// -----------------------------------------------------------------------------

// Minimal ingest implementation. Replace this with real scraping/normalization
// logic when ready.
async function runIngest(url, options) {
  // TODO: wire to real medx-ingest-api scraping logic if desired.
  // For now we return a deterministic normalized payload that AvidiaSEO can use.
  return {
    source_url: url,
    options: options || {},
    seo: {
      title: `SEO title for ${url}`,
      meta_title: `SEO title for ${url}`,
      meta_description: `SEO meta description for ${url}`,
      h1: `Product for ${url}`,
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

console.log("Mounting POST /ingest handler for AvidiaTech ingest");
app.post("/ingest", async (req, res) => {
  try {
    if (!INGEST_SECRET) {
      console.error(
        "INGEST_SECRET/RENDER_ENGINE_SECRET not configured on render-engine"
      );
      return res.status(500).json({ error: "server_misconfigured" });
    }

    // Reconstruct raw JSON body for HMAC verification
    const rawBody = JSON.stringify(req.body || {});
    const signature = req.header("x-avidiatech-signature") || "";

    if (!verifyIngestSignature(rawBody, signature, INGEST_SECRET)) {
      console.warn("medx-ingest-api: invalid signature on /ingest");
      return res.status(401).json({ error: "invalid_signature" });
    }

    const { job_id, url, options, callback_url, correlation_id } =
      req.body || {};

    if (!job_id || !url || !callback_url) {
      console.warn("medx-ingest-api: missing required fields on /ingest", {
        job_id: !!job_id,
        url: !!url,
        callback_url: !!callback_url,
      });
      return res.status(400).json({ error: "missing_required_fields" });
    }

    console.log(
      "[medx-ingest-api] received ingest job",
      job_id,
      "url=",
      url,
      "callback_url=",
      callback_url
    );

    // Run your real ingestion/scraping/normalization here:
    const normalized = await runIngest(url, options);

    // Build callback payload for AvidiaTech app
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
        "No fetch available in this Node environment; cannot send callback"
      );
      return res.status(500).json({ error: "callback_unavailable" });
    }

    // Sign callback body with same secret so /api/v1/ingest/callback accepts it
    const hmac = crypto.createHmac("sha256", INGEST_SECRET);
    hmac.update(callbackBody, "utf8");
    const callbackSig = hmac.digest("hex");

    console.log(
      "[medx-ingest-api] posting callback to",
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
        "[medx-ingest-api] callback failed:",
        callbackRes.status,
        callbackText
      );
      // Still respond 202 to indicate we *accepted* the job, but log the failure
      return res.status(202).json({
        ok: false,
        message: "callback_failed",
        statusCode: callbackRes.status,
      });
    }

    console.log(
      "[medx-ingest-api] callback success for job",
      job_id,
      "response:",
      callbackText
    );

    // Tell AvidiaTech app we accepted/processed the job.
    return res.status(202).json({
      ok: true,
      job_id,
      message: "ingest_completed_and_callback_sent",
    });
  } catch (err) {
    console.error("[medx-ingest-api] /ingest error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// -----------------------------------------------------------------------------
// Mount gptInstructionsEnforcer.mjs (Describe route enforcer) onto the same app
// -----------------------------------------------------------------------------

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

// Start listening - bind to 0.0.0.0 (Render requires this)
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Render engine listening on :${PORT}, RENDER_ENGINE_SECRET=${
      ENGINE_SECRET ? "set" : "not-set"
    }, INGEST_SECRET=${INGEST_SECRET ? "set" : "not-set"}`
  );
});
