// require('./request-logger')(app) - attach early, before route handlers
const express = require('express');

module.exports = function requestLogger(app) {
  // Ensure JSON parsing so we can log request bodies
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const now = new Date().toISOString();
    const safeHeaders = { ...req.headers };
    if (safeHeaders['x-engine-key']) safeHeaders['x-engine-key'] = '***REDACTED***';
    console.log(`[render:request] ${now} ${req.method} ${req.originalUrl} headers=${JSON.stringify(safeHeaders)}`);

    if (req.body) {
      try {
        console.log(`[render:request] body=${JSON.stringify(req.body)}`);
      } catch (e) {
        console.log(`[render:request] body=<unserializable>`);
      }
    }

    res.on('finish', () => {
      console.log(`[render:response] ${now} ${req.method} ${req.originalUrl} status=${res.statusCode}`);
    });

    next();
  });
};
