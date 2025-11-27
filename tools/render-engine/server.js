// Minimal Render engine implementing POST /describe
// - Validates x-engine-key header against RENDER_ENGINE_SECRET
// - Calls OpenAI (if OPENAI_API_KEY is set) to generate a structured response
// - Returns normalized JSON expected by AvidiaDescribe
// Env:
//   RENDER_ENGINE_SECRET  (required in production)
//   OPENAI_API_KEY        (optional; if set engine will call OpenAI)
//   PORT                  (optional)

const express = require('express');
const app = express();
require('./request-logger')(app);
require('./describe-handler')(app);
require('./describe-proxy')(app, { targetPath: '/api/v1/describe' });

const bodyParser = require("body-parser");
const { Configuration, OpenAIApi } = require("openai");

const PORT = process.env.PORT || 8081;
const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || "dev-secret";
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

app.use(bodyParser.json());

// health
app.get("/healthz", (req, res) => res.json({ ok: true }));

// POST /describe
app.post("/describe", async (req, res) => {
  const key = req.header("x-engine-key");
  if (!key || key !== ENGINE_SECRET) {
    return res.status(401).json({ error: "unauthorized: invalid engine key" });
  }

  const body = req.body || {};
  const name = body.name || "Sample product";
  const shortDescription = body.shortDescription || "Short description";

  try {
    let response;
    if (OPENAI_KEY) {
      const configuration = new Configuration({ apiKey: OPENAI_KEY });
      const client = new OpenAIApi(configuration);

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
        messages: [{ role: "system", content: "You output machine-readable JSON according to instructions." }, { role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.2,
      });

      const text = completion.data.choices?.[0]?.message?.content ?? "";
      try {
        response = JSON.parse(text);
      } catch (e) {
        response = {
          descriptionHtml: `<p>${shortDescription}</p>`,
          sections: {
            overview: `${shortDescription}`,
            features: [`Feature A for ${name}`, `Feature B`],
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
          normalizedPayload: { name, brand: body.brand || null, specs: body.specs || null, format: body.format || "avidia_standard" },
          raw: { modelText: text, request: body },
        };
      }
    } else {
      response = {
        descriptionHtml: `<p>${shortDescription}</p>`,
        sections: {
          overview: `${shortDescription}`,
          features: [`Feature A for ${name}`, `Feature B`],
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
        normalizedPayload: { name, brand: body.brand || null, specs: body.specs || null, format: body.format || "avidia_standard" },
        raw: { request: body },
      };
    }

    return res.json(response);
  } catch (err) {
    console.error("render engine error:", err);
    return res.status(500).json({ error: "internal render error", details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Render engine listening on :${PORT}, expects RENDER_ENGINE_SECRET set`);
});
