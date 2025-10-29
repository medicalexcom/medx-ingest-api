/* Modified queueRoutes.js
 *
 * This file demonstrates how to integrate the new variantExtractor module into the
 * ingest pipeline. The variantExtractor extracts variant options (size, color,
 * dimensions, etc.) from the scraped product data before sending that data to GPT.
 * The modifications include importing the variantExtractor, calling
 * extractVariants() on the scraped page data, and populating the variants field
 * in the result object accordingly. If any variants are detected, they are
 * serialized to a JSON string for compatibility with the queue and Google Sheets.
 */

import { google } from 'googleapis';
// Import the variant extractor from the repository root. Adjust the path if your
// project structure is different. This assumes variantExtractor.js is located
// alongside this file at the project root.
import { extractVariants } from './variantExtractor.js';

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

      // Use the variant extractor to detect variant options before any GPT call. This
      // function scans the scraped product data and returns an array of variant
      // objects matching the expected schema (sku, price, option_values, image_url).
      const extractedVariants = extractVariants(data);
      // Attach the variants array back onto the data object so it can be used
      // later in the result or included in the GPT prompt for context. If no
      // variants are found, it will be an empty array.
      data.variants = extractedVariants || [];

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
      // Include productName as its own field. Default to the base meta title (scraped name).
      const result = {
        productName: baseMetaTitle,
        description: baseDescription,
        metaTitle: baseMetaTitle,
        metaDesc: baseMetaDesc,
        keywords: baseKeywords,
        warranty: '',
        // Convert extractedVariants array to a JSON string for queue compatibility
        variants: extractedVariants && extractedVariants.length > 0 ? JSON.stringify(extractedVariants) : '',
        generatedUrl: '',
        auditLog: data.warnings ? { warnings: data.warnings } : {},
        gptAttempts: 0,
        status: 'processed',
        original: row
      };

      // Optionally call OpenAI to generate enhanced copy
      const apiKey = process.env.OPENAI_API_KEY;

      // Determine custom GPT instructions with debug logging
      let customInstructions = '';

      console.log("🧪 GPT_INSTRUCTIONS_FILE_ID:", process.env.GPT_INSTRUCTIONS_FILE_ID);

      if (process.env.GPT_INSTRUCTIONS_FILE_ID) {
        try {
          console.log("🧪 Attempting to load GPT instructions from Google Drive...");
          customInstructions = await getDriveFileContent(process.env.GPT_INSTRUCTIONS_FILE_ID);
          console.log("✅ Loaded GPT instructions from Drive. Length:", customInstructions.length);
        } catch (err) {
          console.error("❌ Failed to load instructions from Drive:", err.message);
        }
      }

      if (!customInstructions) {
        console.warn("⚠️ Falling back to GPT_INSTRUCTIONS env var.");
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
          // Always instruct the model to return a pure JSON object (no markdown fences). Include productName as a separate field.
          promptLines.push('Return your answer strictly as a pure JSON object with these keys: description, productName, metaTitle, metaDesc, keywords, warranty, variants, generatedUrl. Do not wrap the JSON in code fences or markdown.');
          // Include scraped data so GPT can generate relevant text
          promptLines.push(`Scraped Name: ${data.name_raw || data.name || ''}`);
          promptLines.push(`Scraped Description: ${rawDescription}`);
          promptLines.push(`Scraped Specs: ${JSON.stringify(data.specs || {})}`);
          promptLines.push(`Scraped Features: ${JSON.stringify(data.features_raw || [])}`);
          // If variants were detected, include them in the prompt to give GPT full context.
          if (extractedVariants && extractedVariants.length > 0) {
            promptLines.push(`Detected Variants: ${JSON.stringify(extractedVariants)}`);
          }
          const userPrompt = promptLines.join('\n\n');
          // Record the custom instructions and the full prompt used for debugging purposes
          result.auditLog = {};
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
              // Record the cleaned GPT response for debugging
              result.auditLog = { ...result.auditLog, gpt_response: content };
              const gptData = JSON.parse(content);
              // Merge GPT-generated fields into result. Convert arrays/objects to strings for Sheets compatibility.
              if (gptData.description) result.description = gptData.description;
              // Use metaTitle and/or productName from GPT. If a separate productName field is provided, prefer it; otherwise, mirror metaTitle.
              if (gptData.metaTitle) {
                result.metaTitle = gptData.metaTitle;
                result.productName = gptData.metaTitle;
              }
              if (gptData.productName) {
                result.productName = gptData.productName;
                // Keep metaTitle in sync if provided separately
                if (!gptData.metaTitle) {
                  result.metaTitle = gptData.productName;
                }
              }
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
      result.sku = data.sku || row.sku || '';
      result.weight = data.specs?.weight || data.weight || '';

      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });
}
