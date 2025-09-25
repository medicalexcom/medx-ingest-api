/*
 * queueWorker.js
 *
 * This script runs as a background worker for the ingest queue. It
 * polls the ingest API for rows marked `pending_scrape` in your
 * Google Sheet, sends each row to the `/ingest-and-return` endpoint
 * to perform scraping and GPT generation, and then writes the
 * resulting status back to the sheet.  It can be run on a schedule
 * (e.g. via cron or a Render background worker) to keep your queue
 * flowing without manual intervention.
 *
 * Usage:
 *   export INGEST_API_URL=https://your-ingest-api.example.com
 *   export SHEET_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   export GOOGLE_SHEETS_API_KEY=your_sheets_api_key
 *   node queueWorker.js
 *
 * Environment variables:
 *   INGEST_API_URL          – Base URL of your ingest API (no trailing slash).
 *   SHEET_ID                – Google Sheets ID for the ingest queue.
 *   GOOGLE_SHEETS_API_KEY   – API key for reading/writing the sheet.
 *   SHEET_RANGE (optional)  – A1 range to read/write (default: Sheet1!A1:Z1000).
 *   SHEET_NAME  (optional)  – Sheet name (default: Sheet1).
 *
 * Note: This script uses the native fetch API available in recent
 * versions of Node.js (18+).  If running on an older Node version,
 * install and import `node-fetch` instead.
 */

const baseUrl = process.env.INGEST_API_URL;
const sheetId = process.env.SHEET_ID;
const apiKey  = process.env.GOOGLE_SHEETS_API_KEY;
const sheetRange = process.env.SHEET_RANGE || 'Sheet1!A1:Z1000';
const sheetName  = process.env.SHEET_NAME  || 'Sheet1';

if (!baseUrl) {
  throw new Error('INGEST_API_URL environment variable is required');
}
if (!sheetId) {
  throw new Error('SHEET_ID environment variable is required');
}
if (!apiKey) {
  throw new Error('GOOGLE_SHEETS_API_KEY environment variable is required');
}

/**
 * Fetch the header and data rows from the ingest queue sheet.
 * Returns an object with `header` and `rows` arrays.  Each row
 * includes the raw values and the 1-based row number in the sheet.
 */
async function readSheet() {
  const encodedRange = encodeURIComponent(sheetRange);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodedRange}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to read sheet: ${res.status} ${res.statusText} – ${text}`);
  }
  const data = await res.json();
  const values = data.values || [];
  if (values.length === 0) {
    return { header: [], rows: [] };
  }
  const header = values[0].map((h) => String(h).trim());
  const rows   = [];
  for (let i = 1; i < values.length; i++) {
    rows.push({ rowNumber: i + 1, values: values[i] });
  }
  return { header, rows };
}

/**
 * Write one or more cells back to the sheet.  Accepts an array of
 * updates, each with `row`, `col`, and `value`.  Uses the Google
 * Sheets API `values.update` endpoint for each cell.  If you have
 * multiple cells in the same row, it may be more efficient to batch
 * them together; this implementation keeps things simple.
 *
 * @param {Array<{row:number, col:number, value:any}>} updates
 */
async function writeSheetCells(updates) {
  for (const { row, col, value } of updates) {
    const columnLetter = indexToColumn(col);
    const range = `${sheetName}!${columnLetter}${row}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW&key=${apiKey}`;
    const body = JSON.stringify({ values: [[value]] });
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to write cell ${range}: ${res.status} ${res.statusText} – ${text}`);
    }
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
 * Process a single pending row: POST it to the ingest API and write
 * back the status, audit log, and GPT attempts.  The ingest API
 * response should include a `status` field (e.g. "processed",
 * "error"), an `auditLog` object, and `gptAttempts` number.  If it
 * doesn’t, the worker will simply mark the row as processed.
 *
 * @param {Object} header  Header row array
 * @param {Object} rowData Row data { rowNumber, values }
 */
async function processPendingRow(header, rowData) {
  const { rowNumber, values } = rowData;
  // Find column indices (1-based) for key fields
  const statusIndex = header.findIndex((h) => h.toLowerCase() === 'ingest status') + 1;
  const auditIndex  = header.findIndex((h) => h.toLowerCase() === 'audit log') + 1;
  const attemptsIdx = header.findIndex((h) => h.toLowerCase() === 'gpt attempts') + 1;
  // Construct the payload: include row number and original values
  const payload = {
    rowNumber,
    row: values,
  };
  const res = await fetch(`${baseUrl}/ingest-and-return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`Ingest API returned ${res.status} for row ${rowNumber}`);
    return;
  }
  const result = await res.json();
  // Prepare cell updates
  const updates = [];
  if (statusIndex > 0) {
    updates.push({ row: rowNumber, col: statusIndex, value: result.status || 'processed' });
  }
  if (auditIndex > 0) {
    const logVal = result.auditLog ? JSON.stringify(result.auditLog) : '';
    updates.push({ row: rowNumber, col: auditIndex, value: logVal });
  }
  if (attemptsIdx > 0) {
    updates.push({ row: rowNumber, col: attemptsIdx, value: result.gptAttempts != null ? String(result.gptAttempts) : '' });
  }
  await writeSheetCells(updates);
  console.log(`Row ${rowNumber} processed with status ${result.status || 'processed'}`);
}

async function runWorker() {
  console.log('Reading sheet…');
  const { header, rows } = await readSheet();
  if (!header.length) {
    console.log('Sheet is empty or missing header row');
    return;
  }
  // Identify pending rows (case-insensitive)
  const statusIndex = header.findIndex((h) => h.toLowerCase() === 'ingest status');
  if (statusIndex === -1) {
    console.log('No “Ingest Status” column found; nothing to process');
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
      console.error(`Error processing row ${rowData.rowNumber}:`, err.message);
    }
  }
}

// Run the worker if executed directly
if (require.main === module) {
  runWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
