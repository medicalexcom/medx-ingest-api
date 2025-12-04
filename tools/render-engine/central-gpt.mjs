// tools/render-engine/central-gpt.mjs
// Central GPT endpoint for AvidiaTech modules (currently used by AvidiaSEO).
// - Reads custom_gpt_instructions.md from the repo
// - Calls OpenAI with those instructions
// - Returns SEO JSON that /api/v1/seo in AvidiaTech expects.
//
// Auth:
//   - Expects header: Authorization: Bearer CENTRAL_GPT_KEY
//   - CENTRAL_GPT_KEY must be set as env var in Render.
//
// Input body (from AvidiaTech):
//   {
//     module: "seo",
//     payload: { ...normalized_payload from product_ingestions... },
//     correlation_id?: string
//   }
//
// Output body:
//   {
//     seo: {
//       h1,
//       pageTitle,
//       metaDescription,
//       seoShortDescription,
//       ... (you can add more SEO fields)
//     },
//     description_html: "<p>...</p>",
//     features: [ "..." ]
//   }

import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

/**
 * Load the custom GPT instructions once and cache them in memory.
 */
let cachedInstructions = null;

async function loadCustomInstructions() {
  if (cachedInstructions) return cachedInstructions;

  const instructionsPath = path.resolve(
    process.cwd(),
    "tools",
    "render-engine",
    "prompts",
    "custom_gpt_instructions.md",
  );

  const buf = await fs.readFile(instructionsPath, "utf8");
  cachedInstructions = buf.toString();
  return cachedInstructions;
}

/**
 * Mounts POST /central-gpt on the shared Express app.
 */
export function mountCentralGpt(app) {
  const CENTRAL_GPT_KEY = process.env.CENTRAL_GPT_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    console.warn(
      "[central-gpt] WARNING: OPENAI_API_KEY is not set. Endpoint will return a deterministic stub."
    );
  }

  if (!CENTRAL_GPT_KEY) {
    console.warn(
      "[central-gpt] WARNING: CENTRAL_GPT_KEY is not set. You should set it in Render to protect this endpoint."
    );
  }

  app.post("/central-gpt", async (req, res) => {
    try {
      // --- 1) Auth guard ---
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();

      if (!CENTRAL_GPT_KEY || !token || token !== CENTRAL_GPT_KEY) {
        console.warn("[central-gpt] unauthorized request");
        return res.status(401).json({ error: "unauthorized" });
      }

      // --- 2) Parse body ---
      const body = req.body || {};
      const moduleName = body.module || "seo";
      const payload = body.payload || {};
      const correlationId = body.correlation_id || null;

      if (moduleName !== "seo") {
        // For now we only support "seo" module.
        return res.status(400).json({ error: "unsupported_module", module: moduleName });
      }

      // --- 3) Load instructions ---
      const customInstructions = await loadCustomInstructions();

      // Payload fields we care about
      const sourceUrl =
        payload.source_url ||
        payload.url ||
        payload.normalizedPayload?.source_url ||
        "N/A";

      const existingSeo = payload.seo || {};
      const existingDescriptionHtml = payload.description_html || "";
      const existingFeatures = payload.features || [];
      const normalizedProduct = payload.normalizedPayload || payload;

      // If no OpenAI key, return a deterministic stub
      if (!OPENAI_API_KEY) {
        console.warn(
          "[central-gpt] OPENAI_API_KEY not set, returning deterministic stub output"
        );
        return res.json({
          seo: {
            h1: existingSeo.h1 || `Product for ${sourceUrl}`,
            pageTitle:
              existingSeo.pageTitle ||
              existingSeo.title ||
              `SEO title for ${sourceUrl}`,
            metaDescription:
              existingSeo.metaDescription ||
              `SEO meta description for ${sourceUrl}`,
            seoShortDescription:
              existingSeo.seoShortDescription ||
              `Short SEO summary for ${sourceUrl}`,
          },
          description_html:
            existingDescriptionHtml ||
            `<p>Sample description generated for ${sourceUrl}. Replace with real GPT output.</p>`,
          features:
            existingFeatures.length > 0
              ? existingFeatures
              : [
                  `Key feature for ${sourceUrl}`,
                  "Secondary feature",
                ],
        });
      }

      // --- 4) Call OpenAI with custom_gpt_instructions ---
      const client = new OpenAI({ apiKey: OPENAI_API_KEY });

      const systemPrompt = `
You are the central AvidiaTech SEO engine.

Below are the full custom GPT instructions that you MUST follow exactly.
These instructions define:
- How to use normalized product payloads
- How to structure SEO (H1, Page Title, Meta Description, SEO Short Description)
- How to generate HTML descriptions and feature lists
- All validation rules for MedicalEx/AvidiaTech.

----------------- START OF CUSTOM INSTRUCTIONS -----------------
${customInstructions}
-----------------  END OF CUSTOM INSTRUCTIONS  -----------------

When asked to generate SEO, you MUST return ONLY valid JSON.
DO NOT include backticks, markdown fences, or any commentary.
The top-level JSON shape MUST be:

{
  "seo": {
    "h1": string,
    "pageTitle": string,
    "metaDescription": string,
    "seoShortDescription": string,
    // other SEO fields allowed but optional
  },
  "description_html": string,
  "features": string[]
}
`;

      const userPrompt = `
You are generating SEO for the URL: ${sourceUrl}

Here is the normalized payload (input data) that came from the ingest engine:
${JSON.stringify(normalizedProduct, null, 2)}

Here is any existing SEO-like data (if present):
${JSON.stringify(existingSeo, null, 2)}

Here is any existing HTML description and features (if present):
description_html:
${existingDescriptionHtml || "(none)"}

features:
${JSON.stringify(existingFeatures, null, 2)}

Task:
- Using the custom instructions, generate the BEST possible SEO for this product.
- You MUST obey all formatting and validation rules in the custom instructions.
- Output ONLY valid JSON with the exact shape described in the system message.
`;

      const completion = await client.responses.create({
        model: "gpt-4.1-mini",
        reasoning: { effort: "medium" },
        input: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        metadata: {
          module: "avidia_seo",
          correlation_id: correlationId || undefined,
          source_url: sourceUrl,
        },
      });

      const responseContent =
        completion.output[0]?.content?.[0]?.text ||
        completion.output[0]?.content?.[0]?.content ||
        "";

      let json;
      try {
        json = JSON.parse(responseContent);
      } catch (e) {
        console.warn(
          "[central-gpt] OpenAI returned non-JSON; falling back to deterministic stub",
          e?.message || e
        );
        json = null;
      }

      if (!json || typeof json !== "object") {
        // Fallback: merge deterministic with any partial data we have
        return res.json({
          seo: {
            h1: existingSeo.h1 || `Product for ${sourceUrl}`,
            pageTitle:
              existingSeo.pageTitle ||
              existingSeo.title ||
              `SEO title for ${sourceUrl}`,
            metaDescription:
              existingSeo.metaDescription ||
              `SEO meta description for ${sourceUrl}`,
            seoShortDescription:
              existingSeo.seoShortDescription ||
              `Short SEO summary for ${sourceUrl}`,
          },
          description_html:
            existingDescriptionHtml ||
            `<p>Sample description generated for ${sourceUrl}. Replace with real GPT output.</p>`,
          features:
            existingFeatures.length > 0
              ? existingFeatures
              : [
                  `Key feature for ${sourceUrl}`,
                  "Secondary feature",
                ],
        });
      }

      // Ensure minimal shape even if GPT omitted some fields
      const resultSeo = json.seo || {};
      const resultDescription = json.description_html || json.description || "";
      const resultFeatures = Array.isArray(json.features) ? json.features : [];

      return res.json({
        seo: {
          h1:
            resultSeo.h1 ||
            existingSeo.h1 ||
            `Product for ${sourceUrl}`,
          pageTitle:
            resultSeo.pageTitle ||
            resultSeo.title ||
            existingSeo.pageTitle ||
            existingSeo.title ||
            `SEO title for ${sourceUrl}`,
          metaDescription:
            resultSeo.metaDescription ||
            existingSeo.metaDescription ||
            `SEO meta description for ${sourceUrl}`,
          seoShortDescription:
            resultSeo.seoShortDescription ||
            existingSeo.seoShortDescription ||
            `Short SEO summary for ${sourceUrl}`,
          ...resultSeo,
        },
        description_html:
          resultDescription ||
          existingDescriptionHtml ||
          `<p>Sample description generated for ${sourceUrl}. Replace with real GPT output.</p>`,
        features:
          resultFeatures.length > 0
            ? resultFeatures
            : existingFeatures.length > 0
            ? existingFeatures
            : [
                `Key feature for ${sourceUrl}`,
                "Secondary feature",
              ],
      });
    } catch (err) {
      console.error("[central-gpt] internal error:", err);
      return res.status(500).json({
        error: "central_gpt_error",
        detail: String(err?.message || err),
      });
    }
  });

  console.log("[central-gpt] POST /central-gpt mounted");
}

