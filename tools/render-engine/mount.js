// Mountable Render engine routes for embedding into the main Express app.
// Usage from main server.js: require('./tools/render-engine/mount')(app);
const { Configuration, OpenAIApi } = (() => {
  try { return require('openai'); } catch (e) { return {}; }
})();

module.exports = function mountRenderEngine(app) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || 'dev-secret';
  const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

  // If a describe-handler.js exists that exports a function(app), prefer it.
  try {
    /* eslint-disable global-require */
    const handler = require('./describe-handler');
    if (typeof handler === 'function') {
      handler(app);
      console.log('render-engine: mounted external describe-handler');
      return;
    }
  } catch (e) {
    console.log('render-engine: no external describe-handler');
  }

  // If a describe-proxy.js exists that exports function(app, opts), prefer it.
  try {
    const proxy = require('./describe-proxy');
    if (typeof proxy === 'function') {
      proxy(app, { targetPath: '/api/v1/describe' });
      console.log('render-engine: mounted describe-proxy');
      return;
    }
  } catch (e) {
    console.log('render-engine: no describe-proxy found');
  }

  // Fallback: mount /healthz (idempotent) and /describe (will call OpenAI if key present, else return deterministic mock)
  app.get('/healthz', (_, res) => res.json({ ok: true }));

  app.post('/describe', async (req, res) => {
    try {
      const key = req.header('x-engine-key');
      if (!key || key !== ENGINE_SECRET) {
        return res.status(401).json({ error: 'unauthorized: invalid engine key' });
      }

      const body = req.body || {};
      const name = body.name || 'Sample product';
      const shortDescription = body.shortDescription || 'Short description';

      // If OpenAI key present, call it; otherwise return deterministic mock
      if (OPENAI_KEY && typeof Configuration !== 'undefined') {
        try {
          const client = new OpenAIApi(new Configuration({ apiKey: OPENAI_KEY }));
          const prompt = `You are a render engine that returns JSON only. Input:
name: ${name}
shortDescription: ${shortDescription}
brand: ${body.brand || ""}
specs: ${JSON.stringify(body.specs || {})}
format: ${body.format || "avidia_standard"}
Return only valid JSON with keys: descriptionHtml, sections, seo, normalizedPayload, raw.`;
          const completion = await client.createChatCompletion({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'Return only valid JSON.' }, { role: 'user', content: prompt }],
            max_tokens: 1000,
            temperature: 0.2,
          });
          const text = completion.data?.choices?.[0]?.message?.content ?? '';
          try {
            const parsed = JSON.parse(text);
            return res.json(parsed);
          } catch (e) {
            // parse failed -> fall back to mock shaped response including model text
            console.warn('render-engine: OpenAI returned non-JSON; returning fallback');
            return res.json({
              descriptionHtml: `<p>${shortDescription}</p>`,
              sections: {
                overview: shortDescription,
                features: [`Feature A for ${name}`, 'Feature B'],
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
        } catch (err) {
          console.error('render-engine: openai error', err);
          return res.status(500).json({ error: 'render internal error', details: String(err) });
        }
      }

      // No OpenAI key -> deterministic mock response
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
    } catch (err) {
      console.error('render-engine: unexpected error', err);
      return res.status(500).json({ error: 'internal', details: String(err) });
    }
  });

  // Optional GET /describe for debug
  app.get('/describe', (_, res) => res.status(200).send('POST /describe with x-engine-key required'));
};
