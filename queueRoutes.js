/* queueRoutes.js
 *
 * This module registers endpoints for queue management on your ingest API.
 * It integrates with Google Sheets to retrieve rows awaiting ingestion.
 * To use, set the following environment variables:
 *   SHEET_ID - the ID of the Google Sheet storing your ingest queue
 *   GOOGLE_SERVICE_ACCOUNT - the service account email for Sheets access
 *   GOOGLE_PRIVATE_KEY - the private key for the service account
 *   SHEET_RANGE (optional) - the A1 notation range to read
 */

import { google } from 'googleapis';

// Helper to get an authenticated Sheets client using a service account.
async function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT;
  const privateKey  = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT and GOOGLE_PRIVATE_KEY must be set');
  }
  const jwt = new google.auth.JWT(
    clientEmail,
    null,
    privateKey.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

// Read rows marked pending_scrape from the sheet. Returns an array of
// objects with rowNumber, url, sku, and the raw row values.
async function getPendingRows() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID environment variable must be set');
  const range   = process.env.SHEET_RANGE || 'Sheet1!A1:Z1000';
  const sheets  = await getSheetsClient();
  const resp    = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range
  });
  const values = resp.data.values || [];
  if (!values.length) return [];
  const header = values[0].map(h => String(h).trim());
  const statusIndex = header.findIndex(h => h.toLowerCase() === 'ingest status');
  const urlIndex    = header.findIndex(h => h.toLowerCase() === 'product url' || h.toLowerCase() === 'url');
  const skuIndex    = header.findIndex(h => h.toLowerCase() === 'sku');
  const pending = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const status = (row[statusIndex] || '').toString().toLowerCase();
    if (status === 'pending_scrape') {
      pending.push({
        rowNumber: i + 1,
        url: urlIndex >= 0 ? row[urlIndex] : undefined,
        sku: skuIndex >= 0 ? row[skuIndex] : undefined,
        row
      });
    }
  }
  return pending;
}

export default function setupQueueRoutes(app) {
  // GET /scrape-queue
  app.get('/scrape-queue', async (req, res) => {
    try {
      const items = await getPendingRows();
      return res.json({ pending: items });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /ingest-and-return
  // Expects a JSON body with at least { rowNumber, url, row }
  // Calls the local /ingest route to scrape the product page and returns
  // a simplified result object with description, meta tags, keywords, and audit log.
  app.post('/ingest-and-return', async (req, res) => {
    try {
      const row = req.body || {};
      const url = row.url || (row.row && row.row[0]);
      if (!url) {
        return res.status(400).json({ error: 'Missing product URL in request body' });
      }
      // Build URL to call the local ingest route. Use process.env.PORT or default to 3000.
      const port = process.env.PORT || 3000;
      const ingestUrl = `http://localhost:${port}/ingest?url=${encodeURIComponent(url)}&harvest=true&sanitize=true`;
      const ingResp = await fetch(ingestUrl);
      if (!ingResp.ok) {
        const text = await ingResp.text();
        return res.status(500).json({ error: `Ingest request failed: ${ingResp.status} ${ingResp.statusText} - ${text}` });
      }
      const data = await ingResp.json();
      if (data.error) {
        return res.status(422).json({ error: data.error });
      }
      // Construct a simple result using scraped fields. Use raw descriptions and names.
      const rawDescription = data.description_raw || data.description || '';
      const descText   = String(rawDescription).replace(/\n+/g, ' ').trim();
      const description = String(rawDescription).replace(/\n/g, '<br/>').trim();
      const metaTitle   = data.name_raw || data.name || '';
      const metaDesc    = descText.slice(0, 155);
      // Collect keywords from spec keys and features
      const specKeys = Object.keys(data.specs || {});
      const features = Array.isArray(data.features_raw) ? data.features_raw : [];
      const keywordsArray = [...specKeys, ...features].map(s => String(s).toLowerCase());
      const keywords = keywordsArray.join(', ');
      const result = {
        description,
        metaTitle,
        metaDesc,
        keywords,
        auditLog: data.warnings ? { warnings: data.warnings } : {},
        gptAttempts: 0,
        status: 'processed',
        original: row
      };
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });
}
