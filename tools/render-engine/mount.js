// ESM-compatible mount for the render engine routes.
// Usage: dynamic import from your main server.js and call default(app).
//
// This file tries to import request-logger / describe-handler / describe-proxy
// (handling both ESM and CommonJS exports) and falls back to a safe internal
// /describe implementation that validates x-engine-key and returns the normalized shape.

const log = (...args) => console.log('[render-engine]', ...args);
const warn = (...args) => console.warn('[render-engine]', ...args);
const errlog = (...args) => console.error('[render-engine]', ...args);

export default async function mountRenderEngine(app) {
  log('mountRenderEngine starting');

  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || 'dev-secret';
  const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // Helper to normalize import (handles CJS default export or ESM default)
  const normalizeImport = (m) => (m && (m.default || m));

  // Try request-logger
  try {
    const mod = normalizeImport(await import('./request-logger.js')).default ? normalizeImport(await import('./request-logger.js')) : normalizeImport(await import('./request-logger.js'));
    if (typeof mod === 'function') {
      mod(app);
      log('request-logger loaded');
    }
  } catch (e) {
    log('no request-logger or failed to load:', e?.message || e);
  }

  // Try describe-handler (prefer)
  try {
    const mod = normalizeImport(await import('./describe-handler.js'));
    if (typeof mod === 'function') {
      mod(app);
      log('describe-handler loaded (external)');
      return;
    }
  } catch (e) {
    log('describe-handler not found or failed to load:', e?.message || e);
  }

  // Try describe-proxy
  try {
    const mod = normalizeImport(await import('./describe-proxy.js'));
    if (typeof mod === 'function') {
      mod(app, { targetPath: '/api/v1/describe' });
      log('describe-proxy loaded (external)');
      return;
    }
  } catch (e) {
    log('describe-proxy not found or failed to load:', e?.message || e);
  }

  // Fallback: mount /healthz and /describe directly on the main app
  log('mounting fallback /describe (OpenAI if OPENAI_API_KEY set, else deterministic mock)');

  app.get('/healthz', (_, res) => res.json({ ok: true }));

  app.post('/describe', async (req, res) => {
    try {
      const key = req.header('x-engine-key');
      if (!key || key !== ENGINE_SECRET) {
        warn('unauthorized describe request (missing or incorrect x-engine-key)');
        return res.status(401).json({ error: 'unauthorized: invalid engine key' });
      }

      const body = req.body || {};
      const name = body.name || 'Sample product';
      const shortDescription = body.shortDescription || 'Short description';

      if (OPENAI_KEY) {
        try {
          const { Configuration, OpenAIApi } = await import('openai');
          const cfg = new Configuration({ apiKey: OPENAI_KEY });
          const client = new OpenAIApi(cfg);

          const prompt = `You are a normalization pipeline. Input:
name: ${name}
shortDescription: ${shortDescription}
brand: ${body.brand || ""}
specs: ${JSON.stringify(body.specs || {})}
format: ${body.format || "avidia_standard"}
---
Return ONLY JSON with fields: descriptionHtml, sections, seo, normalizedPayload, raw.`;

          const completion = await client.createChatCompletion({
            model: OPENAI_MODEL,
            messages: [{ role: 'system', content: 'You output machine-readable JSON according to instructions.' }, { role: 'user', content: prompt }],
            max_tokens: 1000,
            temperature: 0.2,
          });

          const text = completion.data?.choices?.[0]?.message?.content ?? '';
          try {
            const parsed = JSON.parse(text);
            return res.json(parsed);
          } catch (parseErr) {
            warn('openai returned non-json, returning fallback shaped response');
            return res.json({
              descriptionHtml: `<p>${shortDescription}</p>`,
              sections: {
                overview: shortDescription,
                features: [`Feature A for ${name}`, `Feature B`],
                specsSummary: body.specs || {},
                includedItems: [],
                manualsSectionHtml: '',
              },
              seo: {
                h1: name,
                pageTitle: `${name} — Buy now`,
                metaDescription: shortDescription,
                seoShortDescription: shortDescription,
              },
              normalizedPayload: { name, brand: body.brand ?? null, specs: body.specs ?? null, format: body.format ?? 'avidia_standard' },
              raw: { modelText: text, request: body },
            });
          }
        } catch (openErr) {
          errlog('OpenAI call failed:', openErr?.message || openErr);
          return res.status(500).json({ error: 'render internal error', details: String(openErr) });
        }
      }

      // No OpenAI: deterministic mock
      const response = {
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
      return res.json(response);
    } catch (ex) {
      errlog('fallback /describe unexpected error:', ex?.stack || ex);
      return res.status(500).json({ error: 'internal', details: String(ex) });
    }
  });

  app.get('/describe', (_, res) => res.status(200).send('POST /describe with x-engine-key required'));

  log('fallback /describe mounted');
}
