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

// Use node-fetch for HTTP requests (native fetch is available in recent Node versions).
// If running on older Node (<18), install node-fetch and import it instead.

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
      // Base fields extracted from the scraped data
      const rawDescription = data.description_raw || data.description || '';
      const descText   = String(rawDescription).replace(/\n+/g, ' ').trim();
      const baseDescription = String(rawDescription).replace(/\n/g, '<br/>').trim();
      const baseMetaTitle   = data.name_raw || data.name || '';
      const baseMetaDesc    = descText.slice(0, 155);
      // Collect keywords from spec keys and features
      const specKeys = Object.keys(data.specs || {});
      const features = Array.isArray(data.features_raw) ? data.features_raw : [];
      const keywordsArray = [...specKeys, ...features].map(s => String(s).toLowerCase());
      const baseKeywords = keywordsArray.join(', ');

      // Initialize result object with defaults
      const result = {
        description: baseDescription,
        metaTitle: baseMetaTitle,
        metaDesc: baseMetaDesc,
        keywords: baseKeywords,
        warranty: '',
        variants: '',
        generatedUrl: '',
        auditLog: data.warnings ? { warnings: data.warnings } : {},
        gptAttempts: 0,
        status: 'processed',
        original: row
      };

      // Optionally call OpenAI to generate enhanced copy
      const apiKey = process.env.OPENAI_API_KEY;
      // Read custom GPT instructions from environment variable if provided
      const customInstructions = process.env.GPT_INSTRUCTIONS || '';
      if (apiKey) {
        try {
          // Compose prompt for GPT: include instructions and scraped data. Ask for JSON output with required keys.
          const promptLines = [];
          if (customInstructions) {
            promptLines.push(customInstructions);
          } else {
            promptLines.push('You are a product description generator. Use the provided scraped product information to craft a rich HTML product description, an SEO-friendly meta title (max 60 characters), a meta description (max 155 characters), search keywords, variant options (if available), and warranty information. If a field cannot be determined, leave it blank.');
          }
          promptLines.push('Return your answer strictly as a JSON object with these keys: description, metaTitle, metaDesc, keywords, warranty, variants, generatedUrl.');
          promptLines.push(`Scraped Name: ${data.name_raw || data.name || ''}`);
          promptLines.push(`Scraped Description: ${rawDescription}`);
          promptLines.push(`Scraped Specs: ${JSON.stringify(data.specs || {})}`);
          promptLines.push(`Scraped Features: ${JSON.stringify(data.features_raw || [])}`);
          const userPrompt = promptLines.join('\n\n');
          const messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: userPrompt }
          ];
          const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: process.env.OPENAI_MODEL || 'gpt-4o',
              messages,
              temperature: 0.5
            })
          });
          if (openaiRes.ok) {
            const openaiJson = await openaiRes.json();
            const content = openaiJson.choices?.[0]?.message?.content || '';
            try {
              const gptData = JSON.parse(content);
              // Merge GPT-generated fields into result, preserving defaults when blank
              if (gptData.description) result.description = gptData.description;
              if (gptData.metaTitle) result.metaTitle = gptData.metaTitle;
              if (gptData.metaDesc) result.metaDesc = gptData.metaDesc;
              if (gptData.keywords) result.keywords = gptData.keywords;
              if (gptData.warranty) result.warranty = gptData.warranty;
              if (gptData.variants) result.variants = gptData.variants;
              if (gptData.generatedUrl) result.generatedUrl = gptData.generatedUrl;
              result.gptAttempts = 1;
            } catch (e) {
              // If parsing fails, include raw message in audit log
              result.auditLog = { ...result.auditLog, gpt_raw: content };
            }
          } else {
            const errText = await openaiRes.text();
            result.auditLog = { ...result.auditLog, gpt_error: `${openaiRes.status} ${openaiRes.statusText} - ${errText}` };
          }
        } catch (gptErr) {
          result.auditLog = { ...result.auditLog, gpt_error: gptErr.message };
        }
      }

      // Generate slug for Generated URL if not provided by GPT
      if (!result.generatedUrl) {
        const slug = (data.name_raw || data.name || '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        result.generatedUrl = `/${slug}`;
      }
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });
}
