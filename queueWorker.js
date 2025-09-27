/*
 * queueWorker.js
 *
 * This script runs as a background worker for the ingest queue.
 * It polls the ingest API for rows marked `pending_scrape` in your
 * Google Sheet, sends each row to the `/ingest-and-return` endpoint
 * to perform scraping and GPT generation, and then writes the
 * resulting status back to the sheet.  It can be run on a schedule
 * (e.g. via cron or a Render background worker) to keep your queue
 * flowing without manual intervention.
 *
 * Authentication: This version uses a Google service account to
 * authenticate to the Google Sheets API for both reading and writing.
 * You must set the environment variables GOOGLE_SERVICE_ACCOUNT
 * (service account email) and GOOGLE_PRIVATE_KEY (private key with
 * newline characters escaped as \n).  The service account must be
 * shared as an editor on your queue sheet.
 *
 * Environment variables:
 *   INGEST_API_URL          – Base URL of your ingest API (no trailing slash).
 *   SHEET_ID                – Google Sheets ID for the ingest queue.
 *   GOOGLE_SERVICE_ACCOUNT  – Service account email (required).
 *   GOOGLE_PRIVATE_KEY      – Service account private key (required).
 *   SHEET_RANGE (optional)  – A1 range to read/write (default: Sheet1!A1:Z1000).
 *   SHEET_NAME  (optional)  – Sheet name (default: Sheet1).
 *   QUEUE_POLL_INTERVAL     – Delay between queue checks in ms (default: 30000).
 */

import { google } from 'googleapis';

// Base URL of your ingest API (no trailing slash)
const baseUrl = process.env.INGEST_API_URL;
// Google Sheets ID for your queue
const sheetId = process.env.SHEET_ID;
// Service account credentials
const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT;
const privateKey = process.env.GOOGLE_PRIVATE_KEY;
// Sheet range and name
const sheetRange = process.env.SHEET_RANGE || 'Sheet1!A1:Z1000';
const sheetName  = process.env.SHEET_NAME  || 'Sheet1';

// Validate required environment variables
if (!baseUrl) {
  throw new Error('INGEST_API_URL environment variable is required');
}
if (!sheetId) {
  throw new Error('SHEET_ID environment variable is required');
}
if (!serviceAccount || !privateKey) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT and GOOGLE_PRIVATE_KEY environment variables are required');
}

/**
 * Create an authenticated Google Sheets client using a service account.
 * The private key may have embedded newlines escaped as \n; these are
 * converted back to real newlines.  The client is cached for a short
 * period because googleapis will reuse the JWT automatically.
 */
async function getSheetsClient() {
  const auth = new google.auth.JWT(
    serviceAccount,
    null,
    privateKey.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

/**
 * Read the header row and data rows from the queue sheet.  Returns
 * an object with `header` (array of column names) and `rows` (array
 * of objects with `rowNumber` and `values`).  The returned row
 * numbers are 1-based (including the header row at index 1).
 */
async function readSheet() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: sheetRange,
  });
  const values = res.data.values || [];
  if (values.length === 0) {
    return { header: [], rows: [] };
  }
  const header = values[0].map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    rows.push({ rowNumber: i + 1, values: values[i] });
  }
  return { header, rows };
}

/**
 * Write one or more cells back to the sheet.  Accepts an array of
 * updates where each element has the form `{ row, col, value }`.
 * Uses the Google Sheets API `values.update` endpoint for each cell.
 */
async function writeSheetCells(updates) {
  const sheets = await getSheetsClient();
  for (const { row, col, value } of updates) {
    const columnLetter = indexToColumn(col);
    const range = `${sheetName}!${columnLetter}${row}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  }
}

/**
 * Convert a 1-based column index to an Excel-style column letter.
 * E.g. 1 → A, 26 → Z, 27 → AA.
 */
function indexToColumn(index) {
  let result = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * Process a single pending row: post it to the ingest API and then
 * write the resulting status, audit log, and GPT attempt count back
 * to the sheet.  Any error communicating with the ingest API is
 * logged and skipped; the sheet update will still occur with a
 * default status.
 */
async function processPendingRow(header, rowData) {
  const { rowNumber, values } = rowData;
  // Find the relevant columns (1-based)
  const statusIndex   = header.findIndex((h) => h.toLowerCase() === 'ingest status') + 1;
  const auditIndex    = header.findIndex((h) => h.toLowerCase() === 'audit log') + 1;
  const attemptsIdx   = header.findIndex((h) => h.toLowerCase() === 'gpt attempts') + 1;
  const descIndex     = header.findIndex((h) => h.toLowerCase() === 'description') + 1;
  const variantsIndex = header.findIndex((h) => h.toLowerCase() === 'variants') + 1;
  const warrantyIndex = header.findIndex((h) => h.toLowerCase() === 'warranty') + 1;
  const metaTitleIndex   = header.findIndex((h) => h.toLowerCase() === 'meta title') + 1;
  const metaDescIndex    = header.findIndex((h) => h.toLowerCase() === 'meta description') + 1;
  const genUrlIndex      = header.findIndex((h) => h.toLowerCase() === 'generated url') + 1;
  const keywordsIndex    = header.findIndex((h) => h.toLowerCase() === 'search keywords' || h.toLowerCase() === 'keywords') + 1;
  const productNameIndex = header.findIndex((h) => h.toLowerCase() === 'product name') + 1;
  // Build payload for ingest API
  const payload = {
    rowNumber,
    row: values,
  };
  let result = {};
  try {
    const res = await fetch(`${baseUrl}/ingest-and-return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      result = await res.json();
      console.log(`🧪 GPT Result for row ${rowNumber}:\n`, JSON.stringify(result, null, 2));
    } else {
      console.error(`Ingest API returned ${res.status} for row ${rowNumber}`);
    }
  } catch (err) {
    console.error(`Error calling ingest API for row ${rowNumber}:`, err);
  }
  // Prepare sheet updates
  const updates = [];
  // Always update status
  if (statusIndex > 0) {
    updates.push({ row: rowNumber, col: statusIndex, value: result.status || 'processed' });
  }
  // Update audit log
  if (auditIndex > 0) {
    const logVal = result.auditLog ? JSON.stringify(result.auditLog) : '';
    updates.push({ row: rowNumber, col: auditIndex, value: logVal });
  }
  // Update GPT attempts
  if (attemptsIdx > 0) {
    updates.push({ row: rowNumber, col: attemptsIdx, value: result.gptAttempts != null ? String(result.gptAttempts) : '' });
  }
  // Update description
  if (descIndex > 0) {
    updates.push({ row: rowNumber, col: descIndex, value: result.description || '' });
  }
  // Update variants
  if (variantsIndex > 0) {
    updates.push({ row: rowNumber, col: variantsIndex, value: result.variants || '' });
  }
  // Update warranty
  if (warrantyIndex > 0) {
    updates.push({ row: rowNumber, col: warrantyIndex, value: result.warranty || '' });
  }
  // Update meta title
  if (metaTitleIndex > 0) {
    updates.push({ row: rowNumber, col: metaTitleIndex, value: result.metaTitle || '' });
  }
  // Update meta description
  if (metaDescIndex > 0) {
    updates.push({ row: rowNumber, col: metaDescIndex, value: result.metaDesc || '' });
  }
  // Update generated URL
  if (genUrlIndex > 0) {
    updates.push({ row: rowNumber, col: genUrlIndex, value: result.generatedUrl || '' });
  }
  // Update search keywords
  if (keywordsIndex > 0) {
    updates.push({ row: rowNumber, col: keywordsIndex, value: result.keywords || '' });
  }
  // Update product name
  if (productNameIndex > 0) {
  updates.push({ row: rowNumber, col: productNameIndex, value: result.productName || '' });
  }
  await writeSheetCells(updates);
  console.log(`Row ${rowNumber} processed with status ${result.status || 'processed'}`);
}

/**
 * Scan the sheet for rows with Ingest Status = 'pending_scrape' (case
 * insensitive) and process each one.  Logs the number of rows found
 * and any errors encountered while processing.
 */
async function runWorker() {
  console.log('Reading sheet…');
  const { header, rows } = await readSheet();
  if (!header.length) {
    console.log('Sheet is empty or missing header row');
    return;
  }
  const statusIndex = header.findIndex((h) => h.toLowerCase() === 'ingest status');
  if (statusIndex === -1) {
    console.log('No "Ingest Status" column found; nothing to process');
    return;
  }
  const pendingRows = rows.filter(({ values }) => {
    const status = values[statusIndex] || '';
    return String(status).trim().toLowerCase() === 'pending_scrape';
  });
  if (pendingRows.length === 0) {
    console.log('No rows marked pending_scrape');
    return;
  }
  console.log(`Found ${pendingRows.length} pending row(s)`);
  for (const rowData of pendingRows) {
    try {
      await processPendingRow(header, rowData);
    } catch (err) {
      console.error(`Error processing row ${rowData.rowNumber}:`, err);
    }
  }
}

/**
 * Main loop: continuously poll the queue and process pending rows.
 * Uses QUEUE_POLL_INTERVAL (ms) environment variable or defaults to
 * 30 seconds.  The loop runs indefinitely and logs any iteration
 * failures.
 */
async function main() {
  const pollMs = parseInt(process.env.QUEUE_POLL_INTERVAL, 10);
  const delay = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 30000;
  while (true) {
    try {
      await runWorker();
    } catch (err) {
      console.error('Worker iteration failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// In ES modules, require is undefined, so call main() unconditionally
main().catch((err) => {
  console.error(err);
});
