// require('./describe-handler')(app)
// Minimal handler: validate x-engine-key and return expected normalized shape.

module.exports = function describeHandler(app) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || 'dev-secret';

  app.post('/describe', (req, res) => {
    const key = req.header('x-engine-key');
    if (!key || key !== ENGINE_SECRET) {
      console.warn('describe: unauthorized key', { headerKeyProvided: !!key });
      return res.status(401).json({ error: 'unauthorized: invalid engine key' });
    }

    const body = req.body || {};
    const name = body.name || 'Sample product';
    const shortDescription = body.shortDescription || 'Short description';

    const response = {
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
      raw: { request: body },
    };

    return res.json(response);
  });

  // help debug: GET /describe
  app.get('/describe', (req, res) => {
    res.status(200).send('POST /describe is supported; send JSON body.');
  });
};
