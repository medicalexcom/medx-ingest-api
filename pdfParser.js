/*
 * pdfParser.js
 *
 * This module adds PDF parsing support using the `pdf-parse` library.  It
 * exposes a single function, `parsePdfFromUrl`, which accepts a publicly
 * accessible PDF URL, fetches the document, extracts the raw text,
 * derives key/value pairs from simple "Key: Value" or "Key - Value"
 * lines, and normalises common product spec names via a synonym map.
 * The parsing logic is adapted from the original `pdf‑smoke-test.mjs`
 * script in the medx-ingest-api repository.  In addition to the basic
 * pdf-parse extraction, this upgraded version includes an OCR fallback
 * for scanned manuals: if no text is extracted from the PDF, we render
 * each page to an image using `pdfjs-dist` and `canvas` and run
 * Tesseract via `tesseract.js` to recognise the text.  The rest of the
 * parsing pipeline (normalising text, extracting key/value pairs, and
 * mapping synonyms) remains unchanged.
 */
process.env.AUTO_KENT_DEBUG = 'false';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
// New imports to support OCR fallback for scanned PDFs
import { getDocument } from 'pdfjs-dist';
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

// Extract simple key/value pairs from a block of text. Handles both
// "Key: Value" and "Key - Value" patterns on a single line.
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
        // m[2] may be undefined if the value is missing; use empty string in that case
        out[key] = m[2] ? m[2].trim() : '';
      }
    });
  return out;
}

// Minimal synonym map for common product specifications
// Expanded synonym map for a wide range of product specifications.  Each
// canonical field maps to an array of regular expressions that match
// different phrasing or abbreviations found in manuals. See README for
// details on how these were derived from the mega‑list provided by the user.
const KEYMAP = {
  /* Identity & codes */
  model_number: [
    /model(?:\s*(?:no\.?|number|#))?/i,
    /product\s*model/i,
    /product\s*code/i,
    /product\s*id\b/i,
    /item\s*id\b/i,
  ],
  part_number: [
    /part(?:\s*(?:no\.?|number|#))?/i,
    /part\s*code/i,
  ],
  serial_number: [
    /serial\s*(?:no\.?|number)/i,
    /\bs\/?n\b/i,
  ],
  mpn: [
    /\bmpn\b/i,
    /manufacturer\s*part\s*number/i,
    /mfr\s*part\s*(?:no\.?|#)/i,
  ],
  sku: [
    /\bsku\b/i,
    /sku\s*id\b/i,
    /stock\s*keeping\s*unit/i,
    /manufacturer\s*sku/i,
    /mfr\s*sku/i,
    /item\s*number/i,
  ],
  upc: [/\bupc\b/i],
  ean: [/\bean\b/i],
  gtin: [
    /\bgtin\b/i,
    /global\s*trade\s*item\s*number/i,
  ],

  /* Dimensions & size */
  dimensions: [
    /\boverall\s*dimensions\b/i,
    /\bdimensions?\b/i,
    /\bsize\b/i,
    /\bsizing\b/i,
    /l\s*[×x]\s*w\s*[×x]\s*h/i,
    /length\s*[×x]\s*width\s*[×x]\s*(?:height|depth)/i,
    /\bmeasurements?\b/i,
    /measurement\s*details/i,
  ],
  length: [
    /\blength\b/i,
    /overall\s*length/i,
  ],
  width: [
    /\bwidth\b/i,
    /overall\s*width/i,
  ],
  depth: [
    /\bdepth\b/i,
    /overall\s*depth/i,
  ],
  height: [
    /\bheight\b/i,
    /overall\s*height/i,
  ],
  thickness: [
    /\bthickness\b/i,
    /\bgauge\b/i,
    /\bprofile\b/i,
  ],
  diameter: [
    /\bdiameter\b/i,
    /outer\s*diameter\b/i,
    /inner\s*diameter\b/i,
    /\bod\b/i,
    /\bid\b/i,
    /\bradius\b/i,
  ],
  footprint: [
    /\bfootprint\b/i,
    /chassis\s*width\b/i,
    /frame\s*width\b/i,
  ],
  clearance: [
    /\bclearance\b/i,
    /travel\s*distance\b/i,
    /stroke\s*length\b/i,
  ],
  mounting_hole_spacing: [
    /mounting\s*hole\s*spacing\b/i,
    /bolt\s*circle\s*diameter\b/i,
    /\bBCD\b/i,
  ],
  seat_width: [ /seat\s*width\b/i ],
  seat_depth: [ /seat\s*depth\b/i ],
  seat_height: [ /seat\s*height\b/i ],
  seat_length: [ /seat\s*length\b/i ],
  seat_thickness: [ /seat\s*thickness\b/i ],
  back_height: [
    /back\s*height\b/i,
    /backrest\s*height\b/i,
  ],
  back_width: [ /back\s*width\b/i ],
  back_thickness: [ /back\s*thickness\b/i ],
  armrest_height: [ /armrest\s*height\b/i ],
  armrest_width: [ /armrest\s*width\b/i ],
  handle_height: [ /handle\s*height\b/i ],
  handle_length: [
    /handle\s*length\b/i,
    /grip\s*length\b/i,
  ],

  /* Weight & capacity */
  weight: [
    /\bweight\b/i,
    /unit\s*weight\b/i,
    /net\s*weight\b/i,
    /gross\s*weight\b/i,
    /tare\s*weight\b/i,
  ],
  shipping_weight: [
    /shipping\s*weight\b/i,
    /carton\s*weight\b/i,
    /package\s*weight\b/i,
  ],
  weight_capacity: [
    /weight\s*capacity\b/i,
    /maximum\s*weight\s*capacity\b/i,
    /load\s*capacity\b/i,
  ],
};

// Pick key/value pairs by matching against the synonym map. Only keys that
// match known fields are included in the output. This helper is reused
// downstream and is exported for use elsewhere in the codebase.
function pickBySynonyms(pairs, text) {
  const hits = {};
  for (const key of Object.keys(KEYMAP)) {
    const patterns = KEYMAP[key];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        hits[key] = pairs[key] ?? m[0];
        break;
      }
    }
  }
  return hits;
}

// Perform OCR on a PDF buffer by rendering each page to a canvas and
// recognising the text with Tesseract. This is only used as a fallback
// when the primary pdf-parse extraction returns no text (i.e. scanned PDFs).
async function ocrScanPdf(buffer) {
  // Load the PDF document from an in-memory buffer
  const pdf = await getDocument({ data: buffer }).promise;
  // Create a Tesseract worker once per document to improve performance
  const worker = await createWorker();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  let ocrText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    // Render the page to a canvas; a moderate scale improves OCR accuracy
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const { data: { text } } = await worker.recognize(canvas.toBuffer('image/png'));
    ocrText += text + '\n';
  }
  await worker.terminate();
  return ocrText;
}

/**
 * Fetch a PDF from a URL and extract structured data.
 *
 * @param {string} url - The full URL to the PDF document.
 * @returns {Promise<{ text: string, pairs: Record<string,string>, hits: Record<string,string>, kv: Record<string,string>, tables: any[] }>}
 */
export async function parsePdfFromUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('A valid PDF URL must be provided');
  }
  // Build a list of candidate URLs to try. Start with the original URL and
  // optionally a version without the leading www. Some hosts only serve PDFs
  // from the bare domain. We'll also generate additional candidates by
  // stripping common "download" or "view" segments from the path. This is
  // important for sites that proxy PDF downloads through intermediate
  // endpoints like /download/ or /view/ but ultimately serve the same file
  // when that segment is removed. Duplicates are automatically deduped by
  // using a Set.
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
    // Generate additional candidates by stripping common download/view segments
    const parts = u.pathname.split('/').filter(Boolean);
    const skipSegments = new Set(['download', 'view', 'asset', 'file', 'document', 'documents']);
    // Generate candidates by removing each skip segment individually
    for (let i = 0; i < parts.length; i++) {
      if (skipSegments.has(parts[i].toLowerCase())) {
        const newParts = parts.filter((_, j) => j !== i);
        const newPath = '/' + newParts.join('/');
        candidateSet.add(u.origin + newPath + u.search);
      }
    }
    // Also generate a candidate with *all* skip segments removed.
    const strippedParts = parts.filter(p => !skipSegments.has(p.toLowerCase()));
    if (strippedParts.length < parts.length) {
      const strippedPath = '/' + strippedParts.join('/');
      candidateSet.add(u.origin + strippedPath + u.search);
    }
  } catch (e) {
    candidateSet.add(url);
  }
  const candidates = Array.from(candidateSet);

  // Use a browser-like User-Agent and Accept header to bypass simplistic server checks.
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; medx-ingest-bot/1.0)',
    Accept: 'application/pdf, application/octet-stream;q=0.9',
  };
  let resp;
  let lastErr;
  for (const candidate of candidates) {
    try {
      resp = await fetch(candidate, { headers });
      if (resp.ok) break;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!resp || !resp.ok) {
    // Try fallback strategies to fetch the PDF. Some hosts may return
    // HTTP 403 unless a Referer or more generic User-Agent header is present.
    let fallbackResp = null;
    // 1) Try again with a Referer header set to the PDF's origin
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
    // 2) Try again with a different desktop User-Agent and Accept-Language
    if (!fallbackResp || !fallbackResp.ok) {
      const altHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:113.0) Gecko/20100101 Firefox/113.0',
        'Accept': headers['Accept'],
        'Accept-Language': 'en-US,en;q=0.8',
      };
      try {
        fallbackResp = await fetch(url, { headers: altHeaders });
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
  // At this point resp is an HTTP response that may or may not be a PDF.
  // Check the content-type header. If it's not a PDF, attempt to parse the
  // body as HTML and look for a PDF link. This allows us to handle
  // intermediate landing pages that link to a manual PDF rather than
  // serving the file directly (e.g. "User Manual" pages with a download
  // button). Only proceed to PDF parsing once we have a confirmed PDF
  // response.  If no PDF link can be found, throw an error so the caller
  // can decide how to handle missing manuals.
  let pdfResp = resp;
  try {
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    // If the response does not report a PDF content-type, attempt to detect
    // PDFs via the Content-Disposition filename or the raw file signature.
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
          if (sig === '%PDF-') {
            isPdf = true;
          }
        } catch {}
      }
      if (!isPdf) {
        needHtmlParse = true;
      } else {
        // treat resp as PDF; pdfResp remains resp
      }
    }
    if (needHtmlParse) {
      // Not a PDF – parse the HTML to find candidate PDF URLs. Use a simple
      // regex search for links ending in .pdf. Also handle relative URLs by
      // resolving them against the response URL. If multiple PDFs are
      // present, try each until one succeeds.
      const html = await resp.text();
      const pdfLinks = [];
      // Absolute URLs in the document
      const absRe = new RegExp(
        'https?:\\/\\/[^"\'"'"'<>\\s]+?\\.pdf(?:\\?[^"\'"'"'<>\\s]*)?',
        'gi'
      );
      let m;
      while ((m = absRe.exec(html)) !== null) {
        try {
          const u = new URL(m[0], resp.url).href;
          pdfLinks.push(u);
        } catch {}
      }
      // Dedupe while preserving order
      const seenUrls = new Set();
      const unique = pdfLinks.filter(u => {
        if (seenUrls.has(u)) return false;
        seenUrls.add(u);
        return true;
      });
      // Attempt to fetch each candidate PDF
      let foundPdf = false;
      for (const link of unique) {
        try {
          let candidateResp;
          // Use the same headers as before to fetch the PDF
          candidateResp = await fetch(link, { headers });
          if (!candidateResp || !candidateResp.ok) {
            // Try with referer header
            const ref = (() => {
              try { return new URL(link).origin; } catch { return ''; }
            })();
            if (ref) {
              try {
                candidateResp = await fetch(link, { headers: { ...headers, Referer: ref } });
              } catch {}
            }
          }
          if (candidateResp && candidateResp.ok) {
            const ct2 = (candidateResp.headers.get('content-type') || '').toLowerCase();
            let candidateIsPdf = /application\/pdf|application\/octet-stream/.test(ct2);
            if (!candidateIsPdf) {
              const cd2 = candidateResp.headers.get('content-disposition') || '';
              if (/\.pdf\b/i.test(cd2)) {
                candidateIsPdf = true;
              } else {
                try {
                  const b2 = await candidateResp.clone().arrayBuffer();
                  const sig2 = Buffer.from(b2.slice(0, 5)).toString('ascii');
                  if (sig2 === '%PDF-') {
                    candidateIsPdf = true;
                  }
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
    // If the HTML parsing or fallback fetching fails, rethrow the error to
    // indicate that the PDF could not be retrieved. Do not silently
    // continue with an invalid pdfResp.
    throw err;
  }
  // At this point pdfResp should contain an actual PDF response. Parse it.
  const buffer = Buffer.from(await pdfResp.arrayBuffer());
  const data = await pdfParse(buffer);
  // pdf-parse extracts machine-readable text from embedded PDF streams.
  // If the returned text is empty, attempt an OCR fallback to handle scanned PDFs.
  let text = data.text || '';
  if (!text || !text.trim()) {
    try {
      text = await ocrScanPdf(buffer);
    } catch (e) {
      // If OCR fails, leave text empty; continue processing to preserve existing behaviour.
      text = text || '';
    }
  }
  const pairs = kvPairs(text);
  const hits = pickBySynonyms(pairs, text);
  // Include kv and tables for downstream consumers
  const kv = pairs;
  const tables = Array.isArray(data.tables) ? data.tables : [];
  return { text, pairs, kv, tables, hits };
}

// Named exports for helper functions (optional)
export { kvPairs, pickBySynonyms, normText };
