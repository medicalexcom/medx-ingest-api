/* queueRoutes.js
 *
 * This module registers endpoints for queue management on your ingest API.
 * It integrates with Google Sheets to retrieve rows awaiting ingestion.
 * To use, set the following environment variables:
 *   SHEET_ID - the ID of the Google Sheet storing your ingest queue
 *   GOOGLE_SHEETS_API_KEY - the API key to access Google Sheets
 *   SHEET_RANGE (optional) - the A1 notation range to read
 */

async function getPendingRows() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) {
    throw new Error('SHEET_ID environment variable must be set');
  }
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_SHEETS_API_KEY environment variable must be set');
  }
  const range = encodeURIComponent(process.env.SHEET_RANGE || 'Sheet1!A1:Z1000');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch sheet: ${response.status} ${response.statusText} - ${text}`);
  }
  const data = await response.json();
  const values = data.values || [];
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
  app.post('/ingest-and-return', async (req, res) => {
    try {
      const row = req.body || {};
      // TODO: integrate with your scraping and GPT pipeline.
      const result = {
        description: '',
        metaTitle: '',
        metaDesc: '',
        keywords: '',
        auditLog: {},
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
