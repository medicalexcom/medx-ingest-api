/*
 * pdfParser.js
 *
 * This module adds PDF parsing support using the `pdf-parse` library.  It exposes
 * a single function, `parsePdfFromUrl`, which accepts a publicly accessible
 * PDF URL, fetches the document, extracts the raw text, derives key/value
 * pairs from simple "Key: Value" or "Key - Value" lines, and normalises
 * common product spec names via a synonym map.  The parsing logic is
 * adapted from the original `pdf‑smoke-test.mjs` script in the medx-ingest-api
 * repository.
 */
process.env.AUTO_KENT_DEBUG = 'false';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
// Additional imports for OCR fallback
import pdfjs from 'pdfjs-dist';
const { getDocument } = pdfjs;
import { createCanvas } from 'canvas';
import { createWorker } from 'tesseract.js';

// Normalise curly quotes, long dashes and whitespace
function normText(t) {
  return String(t)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract simple key/value pairs from a block of text.
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
        out[key] = m[2] ? m[2].trim() : '';
      }
    });
  return out;
}

/**
 * Perform an OCR pass over a PDF when traditional PDF text extraction fails.
 */
async function ocrScanPdf(buffer) {
  const doc = await getDocument({ data: buffer }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    const renderContext = { canvasContext: ctx, viewport };
    await page.render(renderContext).promise;
    const imgBuffer = canvas.toBuffer();
    const worker = await createWorker();
    try {
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      const { data: { text } } = await worker.recognize(imgBuffer);
      fullText += text + '\n';
    } finally {
      await worker.terminate();
    }
  }
  return fullText;
}

/* KEYMAP contents omitted for brevity … the original synonym map remains unchanged. */

function pickBySynonyms(pairs, rawText) {
  const hits = {};
  for (const [canon, syns] of Object.entries(KEYMAP)) {
    const candidates = Object.entries(pairs).filter(([k]) =>
      syns instanceof RegExp
        ? syns.test(k.replace(/_/g, ' '))
        : syns.some(rx => rx.test(k.replace(/_/g, ' ')))
    );
    if (candidates.length) {
      const best = candidates.sort((a, b) => b[1].length - a[1].length)[0][1];
      hits[canon] = best;
      continue;
    }
    const rx = syns instanceof RegExp ? syns : syns[0];
    const m = normText(rawText).match(new RegExp(`(${rx.source})[:\\s-]+([^\\n]{2,80})`, 'i'));
    if (m) {
      hits[canon] = m[2] ? m[2].trim() : '';
    }
  }
  return hits;
}

/**
 * Fetch a PDF from a URL and extract structured data.
 */
export async function parsePdfFromUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('A valid PDF URL must be provided');
  }
  // Build a list of candidate URLs by stripping known proxy segments and other download wrappers.
  const candidateSet = new Set();
  try {
    const u = new URL(url);
    const { hostname } = u;
    candidateSet.add(url);
    // Remove www. prefix if present
    if (hostname && hostname.startsWith('www.')) {
      const bare = hostname.replace(/^www\./, '');
      candidateSet.add(url.replace(`//${hostname}`, `//${bare}`));
    }
    const parts = u.pathname.split('/').filter(Boolean);
    // Extended skip segments to remove common proxy wrappers:contentReference[oaicite:0]{index=0}.
    const skipSegments = new Set([
      'download', 'view', 'asset', 'file', 'document', 'documents',
      'content', 'downloadfile', 'docs', 'doc', 'media'
    ]);
    // Remove each segment individually
    for (let i = 0; i < parts.length; i++) {
      if (skipSegments.has(parts[i].toLowerCase())) {
        const newParts = parts.filter((_, j) => j !== i);
        candidateSet.add(u.origin + '/' + newParts.join('/') + u.search);
      }
    }
    // Remove all skip segments at once
    const stripped = parts.filter(p => !skipSegments.has(p.toLowerCase()));
    if (stripped.length < parts.length) {
      candidateSet.add(u.origin + '/' + stripped.join('/') + u.search);
    }
  } catch {
    candidateSet.add(url);
  }
  const candidates = Array.from(candidateSet);

  // Base headers used for fetching
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; medx-ingest-bot/1.0)',
    Accept: 'application/pdf, application/octet-stream;q=0.9'
  };

  let resp;
  let lastErr;
  // Try each candidate
  for (const candidate of candidates) {
    try {
      resp = await fetch(candidate, { headers });
      if (resp.ok) break;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }

  // If no candidate succeeded, perform fallbacks
  if (!resp || !resp.ok) {
    let fallbackResp = null;
    // 1) Retry with Referer header pointing back to the PDF’s origin
    const referer = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return '';
      }
    })();
    if (referer) {
      try {
        fallbackResp = await fetch(url, { headers: { ...headers, Referer: referer } });
      } catch (e) {
        lastErr = e;
      }
    }
    // 2) Retry with a Firefox user agent and Accept-Language:contentReference[oaicite:1]{index=1}.
    if (!fallbackResp || !fallbackResp.ok) {
      const altHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:113.0) Gecko/20100101 Firefox/113.0',
        Accept: headers.Accept,
        'Accept-Language': 'en-US,en;q=0.8'
      };
      try {
        fallbackResp = await fetch(url, { headers: altHeaders });
      } catch (e) {
        lastErr = e;
      }
    }
    // 3) NEW: Retry with a Chrome user agent and slightly different language preferences:contentReference[oaicite:2]{index=2}.
    if (!fallbackResp || !fallbackResp.ok) {
      const altHeaders2 = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        Accept: headers.Accept,
        'Accept-Language': 'en-US,en;q=0.6'
      };
      try {
        fallbackResp = await fetch(url, { headers: altHeaders2 });
      } catch (e) {
        lastErr = e;
      }
    }
    if (fallbackResp && fallbackResp.ok) {
      resp = fallbackResp;
    } else {
      throw new Error(`Failed to fetch PDF: ${lastErr?.message || 'unknown error'}`);
    }
  }

  // If the response isn’t a PDF, parse as HTML to discover embedded PDF links.
  let pdfResp = resp;
  try {
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    let needHtmlParse = false;
    if (!/application\/pdf|application\/octet-stream/.test(ct)) {
      let isPdf = false;
      const cd = resp.headers.get('content-disposition') || '';
      if (/\.pdf\b/i.test(cd)) {
        isPdf = true;
      } else {
        try {
          const arr = await resp.clone().arrayBuffer();
          const sig = Buffer.from(arr.slice(0, 5)).toString('ascii');
          if (sig === '%PDF-') isPdf = true;
        } catch {}
      }
      needHtmlParse = !isPdf;
    }
    if (needHtmlParse) {
      const html = await resp.text();
      const pdfLinks = [];
      // Extract absolute and relative PDF links from the HTML
      const absRe = new RegExp('https?:\\/\\/[^\\"\\'<>\\s]+?\\.pdf(?:\\?[^\\"\\'<>\\s]*)?', 'gi');
      let m;
      while ((m = absRe.exec(html))) pdfLinks.push(m[0]);
      const relRe = new RegExp('(?:href|src)\\s*=\\s*["\']([^"\']+?\\.pdf(?:\\?[^"\']*)?)["\']', 'gi');
      while ((m = relRe.exec(html))) {
        try {
          const u2 = new URL(m[1], resp.url).href;
          pdfLinks.push(u2);
        } catch {}
      }
      const seen = new Set();
      let foundPdf = false;
      for (const link of pdfLinks) {
        if (seen.has(link)) continue;
        seen.add(link);
        try {
          let candidateResp = await fetch(link, { headers });
          if (!candidateResp || !candidateResp.ok) {
            // Try again with a referer header
            const ref = (() => {
              try { return new URL(link).origin; } catch { return ''; }
            })();
            if (ref) {
              candidateResp = await fetch(link, {
                headers: { ...headers, Referer: ref }
              });
            }
          }
          if (candidateResp && candidateResp.ok) {
            const ct2 = (candidateResp.headers.get('content-type') || '').toLowerCase();
            let candidateIsPdf = /application\/pdf|application\/octet-stream/.test(ct2);
            if (!candidateIsPdf) {
              const cd2 = candidateResp.headers.get('content-disposition') || '';
              if (/\.pdf\b/i.test(cd2)) candidateIsPdf = true;
              else {
                try {
                  const arr2 = await candidateResp.clone().arrayBuffer();
                  const sig2 = Buffer.from(arr2.slice(0, 5)).toString('ascii');
                  if (sig2 === '%PDF-') candidateIsPdf = true;
                } catch {}
              }
            }
            if (candidateIsPdf) {
              pdfResp = candidateResp;
              foundPdf = true;
              break;
            }
          }
        } catch {}
      }
      if (!foundPdf) {
        throw new Error('HTML page did not contain a reachable PDF');
      }
    }
  } catch (err) {
    throw err;
  }

  // Parse the PDF
  const buffer = Buffer.from(await pdfResp.arrayBuffer());
  const data = await pdfParse(buffer);
  let text = data.text || '';
  if (!text || !text.trim()) {
    try {
      text = await ocrScanPdf(buffer);
    } catch {
      // ignore OCR errors
    }
  }
  const pairs = kvPairs(text);
  const hits = pickBySynonyms(pairs, text);
  const kv = pairs;
  const tables = Array.isArray(data.tables) ? data.tables : [];
  return { text, pairs, kv, tables, hits };
}

// Keep the KEYMAP extensions and helper exports unchanged.
Object.assign(KEYMAP, {
  // environmental spec synonyms...
});
export { kvPairs, pickBySynonyms, normText };
