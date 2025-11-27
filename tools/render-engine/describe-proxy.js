// require('./describe-proxy')(app, { targetPath: '/api/v1/describe' })
// Proxy that calls your local internal endpoint (assumes server listens locally on process.env.PORT)
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

module.exports = function setupDescribeProxy(app, options = {}) {
  const targetPath = options.targetPath || '/api/v1/describe';
  const engineSecret = process.env.RENDER_ENGINE_SECRET || '';

  app.post('/describe', async (req, res) => {
    try {
      const host = 'http://127.0.0.1:' + (process.env.PORT || 8080);
      const forwardUrl = host + targetPath;
      const forwardRes = await fetch(forwardUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-engine-key': engineSecret,
        },
        body: JSON.stringify(req.body),
      });
      const text = await forwardRes.text();
      res.status(forwardRes.status);
      // forward content-type if present
      if (forwardRes.headers.get('content-type')) res.set('Content-Type', forwardRes.headers.get('content-type'));
      res.send(text);
    } catch (err) {
      console.error('describe-proxy error', err);
      res.status(500).json({ error: 'proxy error', details: String(err) });
    }
  });

  app.get('/describe', (req, res) => {
    res.status(200).send('POST /describe is proxied to ' + targetPath);
  });
};
