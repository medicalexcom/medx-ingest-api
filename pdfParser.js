/*
 * pdfParser.js
 *
 * This module adds PDF parsing support using the `pdf-parse` library.  It exposes
 * a single function, `parsePdfFromUrl`, which accepts a publicly accessible
 * PDF URL, fetches the document, extracts the raw text, derives key/value
 * pairs from simple "Key: Value" or "Key - Value" lines, and normalises
 * common product spec names via a synonym map.  The parsing logic is
 * adapted from the original `pdf‑smoke-test.mjs` script in the medx-ingest-api
 * repository【62585107086987†L24-L37】【62585107086987†L41-L58】.
 */
process.env.AUTO_KENT_DEBUG = 'false';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// Normalise curly quotes, long dashes and whitespace
function normText(t) {
  return String(t)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract simple key/value pairs from a block of text.  Handles both
// "Key: Value" and "Key - Value" patterns on a single line【62585107086987†L24-L37】.
function kvPairs(text) {
  const out = {};
  normText(text)
    .split(/(?<=\.)\s+|[\r\n]+/g)
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(line => {
      const m = line.match(/^([^:–—-]{2,60})[:–—-]\s*(.{2,300})$/);
      if (m) {
        const key = m[1].toLowerCase().replace(/\s+/g, '_');
        out[key] = m[2].trim();
      }
    });
  return out;
}

// Minimal synonym map for common product specifications【62585107086987†L41-L58】.
const KEYMAP = {
  weight_capacity: [/weight\s*capacity/i, /\bcapacity\b/i],
  product_weight: [/product\s*weight|unit\s*weight/i],
  shipping_weight: [/shipping\s*weight/i],
  dimensions: [/overall\s*dimensions\b|\bdimensions\b/i],
  seat_dimensions: [/seat\s*dimensions?|seat\s*(width|depth)/i],
  seat_opening: [/seat\s*opening/i],
  adjustable_seat_height: [/adjustable\s*seat\s*height|seat\s*height/i],
  top_speed: [/top\s*speed/i],
  turning_radius: [/turning\s*radius/i],
  batteries: /\bbatter(y|ies)\b/i,
  motor: /\bmotor\b/i,
  warranty: /\bwarranty\b/i,
  color: /\bcolor\b/i,
  controller: /\bcontroller\b/i,
  ground_clearance: /\bground\s*clearance\b/i,
};

// Select the canonical spec names based on synonyms.  Falls back to a raw
// regex search if no direct key matches are found【62585107086987†L60-L79】.
function pickBySynonyms(pairs, rawText) {
  const hits = {};
  for (const [canon, syns] of Object.entries(KEYMAP)) {
    const candidates = Object.entries(pairs).filter(([k]) =>
      syns instanceof RegExp
        ? syns.test(k.replace(/_/g, ' '))
        : syns.some(rx => rx.test(k.replace(/_/g, ' ')))
    );
    if (candidates.length) {
      // choose the longest value (often most complete)
      const best = candidates.sort((a, b) => b[1].length - a[1].length)[0][1];
      hits[canon] = best;
      continue;
    }
    // fallback: raw text search to catch patterns like "Top Speed 4.25 mph"
    const rx = syns instanceof RegExp ? syns : syns[0];
    const m = normText(rawText).match(new RegExp(`(${rx.source})[:\s-]+([^\n]{2,80})`, 'i'));
    if (m) hits[canon] = m[2].trim();
  }
  return hits;
}

/**
 * Fetch a PDF from a URL and extract structured data.
 *
 * @param {string} url - The full URL to the PDF document.
 * @returns {Promise<{ text: string, pairs: Record<string,string>, hits: Record<string,string> }>} Parsed data
 */
export async function parsePdfFromUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('A valid PDF URL must be provided');
  }
  // Use the global fetch available in Node.js >= 18 to retrieve the PDF
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${resp.status}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const data = await pdfParse(buffer);
  const text = data.text || '';
  const pairs = kvPairs(text);
  const hits = pickBySynonyms(pairs, text);
  return { text, pairs, hits };
}

// Named exports for helper functions (optional)
export { kvPairs, pickBySynonyms, normText };
