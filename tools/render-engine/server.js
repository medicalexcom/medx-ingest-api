// Robust Render engine entrypoint for medx-ingest-api
// - Loads request-logger (if present)
// - Prefer a local describe-handler (if present)
// - Otherwise, prefer a describe-proxy (if present)
// - Otherwise, expose an internal /describe implementation (calls OpenAI if OPENAI_API_KEY set, else returns a deterministic mock)
// - Listens on process.env.PORT and binds to 0.0.0.0
//
// Notes:
// - Ensure RENDER_ENGINE_SECRET is set in Render and matches Vercel.
// - Start command on Render should be: node server.js (or node tools/render-engine/server.js if using a subfolder).
// - This file is intentionally defensive and logs module load status so you can confirm the running code in Render logs.

const express = require('express');
const bodyParser = require('body-parser');

const { Configuration, OpenAIApi } = require('openai');

const app = express();

// Ensure we parse JSON bodies before any handlers (request-logger may expect req.body)
app.use(express.json({ limit: '2mb' }));
app.use(bodyParser.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8081;
const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || 'dev-secret';
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

// Try to load request-logger (optional)
try {
  // If you placed it in a subfolder adjust the path, e.g. './tools/render-engine/request-logger'
  require('./request-logger')(app);
  console.log('request-logger loaded');
} catch (e) {
  console.warn('request-logger not found or failed to load:', e?.message || e);
}

// If a dedicated describe-handler exists, prefer it and do not mount internal fallback
let hasDescribeHandler = false;
try {
  require('./describe-handler')(app);
  hasDescribeHandler = true;
  console.log('describe-handler loaded (external)');
} catch (e) {
  console.warn('describe-handler not found or failed to load:', e?.message || e);
}

// If a describe-proxy exists and no external handler, load it (it will mount /describe)
let hasDescribeProxy = false;
if (!hasDescribeHandler) {
  try {
    require('./describe-proxy')(app, { targetPath: '/api/v1/describe' });
    hasDescribeProxy = true;
    console.log('describe-proxy loaded (will proxy /describe to internal path)');
  } catch (e) {
    console.warn('describe-proxy not found or failed to load:', e?.message || e);
  }
}

// If neither describe-handler nor describe-proxy were loaded, mount an internal /describe implementation
if (!hasDescribeHandler && !hasDescribeProxy) {
  console.log('No external describe handler or proxy found — mounting internal /describe implementation');

  // Health endpoint (also present in other files)
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.post('/describe', async (req, res) => {
    const key = req.header('x-engine-key');
    if (!key || key !== ENGINE_SECRET) {
      console.warn('describe: unauthorized key', { headerKeyProvided: !!key });
      return res.status(401).json({ error: 'unauthorized: invalid engine key' });
    }

    const body = req.body || {};
    const name = body.name || 'Sample product';
    const shortDescription = body.shortDescription || 'Short description';

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
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You output machine-readable JSON according to instructions.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1000,
          temperature: 0.2,
        });

        const text = completion.data.choices?.[0]?.message?.content ?? '';
        try {
          response = JSON.parse(text);
        } catch (e) {
          console.warn('OpenAI returned non-JSON; falling back to deterministic shape', e?.message);
          response = {
            descriptionHtml: `<p>${shortDescription}</p>`,
            sections: {
              overview: `${shortDescription}`,
              features: [`Feature A for ${name}`, `Feature B`],
              specsSummary: body.specs || {},
              includedItems: [],
              manualsSectionHtml: '',
            },
            seo: {
              h1: name,
              pageTitle: `${name} - Buy now`,
              metaDescription: shortDescription,
              seoShortDescription: shortDescription,
            },
            normalizedPayload: { name, brand: body.brand ?? null, specs: body.specs ?? null, format: body.format ?? 'avidia_standard' },
            raw: { modelText: text, request: body },
          };
        }
      } else {
        // No OpenAI key: return deterministic mock
        response = {
          descriptionHtml: `<p>${shortDescription}</p>`,
          sections: {
            overview: `${shortDescription}`,
            features: [`Feature A for ${name}`, `Feature B`],
            specsSummary: body.specs || {},
            includedItems: [],
            manualsSectionHtml: '',
          },
          seo: {
            h1: name,
            pageTitle: `${name} - Buy now`,
            metaDescription: shortDescription,
            seoShortDescription: shortDescription,
          },
          normalizedPayload: { name, brand: body.brand ?? null, specs: body.specs ?? null, format: body.format ?? 'avidia_standard' },
          raw: { request: body },
        };
      }

      return res.json(response);
    } catch (err) {
      console.error('render engine error:', err);
      return res.status(500).json({ error: 'internal render error', details: String(err) });
    }
  });

  // Help GET for debugging
  app.get('/describe', (req, res) => {
    res.status(200).send('POST /describe is supported; send JSON body with x-engine-key header.');
  });
} else {
  // Ensure /healthz exists even if external modules were loaded
  app.get('/healthz', (req, res) => res.json({ ok: true }));
}

// Start listening - bind to 0.0.0.0 (Render requires this)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Render engine listening on :${PORT}, expects RENDER_ENGINE_SECRET=${ENGINE_SECRET ? 'set' : 'not-set'}`);
});
