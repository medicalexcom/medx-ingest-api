/* queueRoutes.js
 *
 * This module registers endpoints for queue management on your ingest API.
 * It integrates with Google Sheets to retrieve rows awaiting ingestion.
 * To use, set the following environment variables:
 *   SHEET_ID - the ID of the Google Sheet storing your ingest queue
 *   GOOGLE_SERVICE_ACCOUNT - the service account email for Google Sheets API
 *   GOOGLE_PRIVATE_KEY - the private key for the service account (with \n newlines)
 *
 * Optionally you can set SHEET_RANGE to restrict the range to read (e.g. "Sheet1!A1:Z1000").
 */

import { google } from 'googleapis';

function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('Missing Google Sheets credentials. Set GOOGLE_SERVICE_ACCOUNT and GOOGLE_PRIVATE_KEY in env.');
  }
  const auth = new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function getPendingRows() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) {
    throw new Error('SHEET_ID environment variable must be set');
  }
  const sheets = getSheetsClient();
  const range = process.env.SHEET_RANGE || 'Sheet1';
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range
  });
  const values = result.data.values || [];
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
  // Return pending rows from the Google Sheet
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
  // Accepts a row payload, runs scraping + GPT, and returns the result
  app.post('/ingest-and-return', async (req, res) => {
    try {
      const row = req.body || {};
      // TODO: integrate with your scraping and GPT pipeline.
      // For now, simply echo the original input with placeholder fields.
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
