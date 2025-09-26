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
    privateKey.replace(/\n/g, '\n'),
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

// New helper to get authenticated Drive client using existing Sheets credentials
async function getDriveClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT;
  const privateKey  = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT and GOOGLE_PRIVATE_KEY must be set');
  }
  const jwt = new google.auth.JWT(
    clientEmail,
    null,
    privateKey.replace(/\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive.readonly']
  );
  await jwt.authorize();
  return google.drive({ version: 'v3', auth: jwt });
}

// Fetch a file's content from Google Drive by its ID. Returns plain text.
async function getDriveFileContent(fileId) {
  const drive = await getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media' });
  return res.data;
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
      const baseDescription = String(rawDescription).replace(/\n/g, ' ').trim();
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
      // Determine custom GPT instructions
      let customInstructions = '';
      if (process.env.GPT_INSTRUCTIONS_FILE_ID) {
        try {
          // Prefer loading instructions from a Google Drive file when FILE_ID is provided
          customInstructions = await getDriveFileContent(process.env.GPT_INSTRUCTIONS_FILE_ID);
        } catch (err) {
          console.error('Failed to fetch GPT instructions from Google Drive:', err.message);
        }
      }
      // Fallback to plain environment variable if no file-based instructions found
      if (!customInstructions) {
        customInstructions = process.env.GPT_INSTRUCTIONS || '';
      }

      if (apiKey) {
        try {
          // Compose prompt for GPT: always include custom instructions if available and direct the model to output pure JSON.
          const promptLines = [];
          if (customInstructions) {
            // Trim whitespace to avoid unwanted leading/trailing spaces
            promptLines.push(customInstructions.trim());
          }
          // Always instruct the model to return a pure JSON object (no markdown fences)
          promptLines.push('Return your answer strictly as a pure JSON object with these keys: description, metaTitle, metaDesc, keywords, warranty, variants, generatedUrl. Do not wrap the JSON in code fences or markdown.');
          // Include scraped data so GPT can generate relevant text
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
            let content = openaiJson.choices?.[0]?.message?.content || '';
            try {
              // Remove potential markdown code fences from the response before parsing
              content = content.trim();
              if (content.startsWith('```')) {
                content = content.replace(/^```(?:json)?\n/, '').replace(/```$/, '');
              }
              const gptData = JSON.parse(content);
              // Merge GPT-generated fields into result. Convert arrays/objects to strings for Sheets compatibility.
              if (gptData.description) result.description = gptData.description;
              if (gptData.metaTitle) result.metaTitle = gptData.metaTitle;
              if (gptData.metaDesc) result.metaDesc = gptData.metaDesc;
              if (gptData.keywords) {
                // If keywords is an array, join with commas; otherwise use as-is
                if (Array.isArray(gptData.keywords)) {
                  result.keywords = gptData.keywords.join(', ');
                } else {
                  result.keywords = gptData.keywords;
                }
              }
              if (gptData.warranty) result.warranty = gptData.warranty;
              if (gptData.variants) {
                // Convert variants to a string representation. If already a string, keep it; else stringify.
                if (typeof gptData.variants === 'string') {
                  result.variants = gptData.variants;
                } else {
                  try {
                    result.variants = JSON.stringify(gptData.variants);
                  } catch {
                    result.variants = String(gptData.variants);
                  }
                }
              }
              if (gptData.generatedUrl) result.generatedUrl = gptData.generatedUrl;
              result.gptAttempts = 1;
            } catch (e) {
              // If parsing fails, include the raw content in the audit log for troubleshooting
              result.auditLog = { ...result.auditLog, gpt_raw: content };
            }
          } else {
            const errText = await openaiRes.text();
            result.auditLog = { ...result.auditLog, gpt_error: `${openaiRes.status} ${openaiRes.statusText} - ${errText}` };
          }
        } catch (gptErr) {
          // Capture any errors thrown during the GPT call
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
