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
// Additional imports for OCR fallback
// pdfjs‑dist is published as a CommonJS module, which does not expose named
// exports in a way that Node's ESM loader can import directly.  Attempting
// `import { getDocument } from 'pdfjs-dist';` will throw a syntax error at
// runtime (see Render build logs).  To work around this, import the
// CommonJS module as a default (`pdfjs`) and then destructure the desired
// function.  This follows the guidance from Node's error message:
//   import pkg from 'pdfjs-dist';
//   const { getDocument } = pkg;
// See: https://github.com/mozilla/pdf.js/tree/master/examples/node
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
        // m[2] may be undefined if the value is missing; use empty string in that case
        out[key] = m[2] ? m[2].trim() : '';
      }
    });
  return out;
}

/**
 * Perform an OCR pass over a PDF when traditional PDF text extraction fails.
 * This function renders each page to a canvas using pdfjs-dist and then uses
 * tesseract.js to extract text from the rendered image. The text from all
 * pages is concatenated and returned.
 *
 * @param {Buffer} buffer - The raw PDF file contents
 * @returns {Promise<string>} The concatenated OCR text of the PDF
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

// Minimal synonym map for common product specifications【62585107086987†L41-L58】.
// Expanded synonym map for a wide range of product specifications.  Each
// canonical field maps to an array of regular expressions that match
// different phrasing or abbreviations found in manuals.  See README for
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
    /\bpayload\b/i,
    /\bmax(?:imum)?\s*user\s*weight\b/i,
    /maximum\s*load\b/i,
    /rated\s*load\b/i,
  ],

  /* Materials & construction */
  material: [
    /\bmaterials?\b/i,
    /body\s*material\b/i,
    /composition\b/i,
  ],
  frame_material: [
    /frame\s*material\b/i,
    /chassis\s*material\b/i,
  ],
  seat_material: [
    /seat\s*material\b/i,
    /cover\s*material\b/i,
    /upholstery\b/i,
    /\bfabric\b/i,
  ],
  finish: [
    /\bfinish\b/i,
    /\bcoating\b/i,
    /\bplating\b/i,
    /\banodizing\b/i,
    /powder\s*coat\b/i,
  ],

  /* Wheels, tires & mobility */
  wheel_size: [
    /wheel\s*(?:size|diameter|width)\b/i,
  ],
  tire_size: [
    /tire\s*(?:size|diameter|width)\b/i,
  ],
  caster_size: [
    /caster\s*(?:size|diameter)\b/i,
  ],
  rear_wheel: [ /rear\s*wheel\b/i ],
  front_wheel: [ /front\s*wheel\b/i ],
  front_caster: [ /front\s*caster\b/i ],
  rear_caster: [ /rear\s*caster\b/i ],
  tread_type: [ /tread\s*type\b/i ],
  tread_width: [ /tread\s*width\b/i ],
  tread_depth: [ /tread\s*depth\b/i ],
  bearing_type: [
    /bearing\s*type\b/i,
    /wheel\s*bearings\b/i,
  ],

  /* Electrical & power */
  power_rating: [
    /\bpower\b/i,
    /power\s*rating\b/i,
    /power\s*consumption\b/i,
    /input\s*power\b/i,
    /output\s*power\b/i,
  ],
  current: [
    /\bcurrent\b/i,
    /amperage\b/i,
    /amp\s*draw\b/i,
    /\bamp(?:s)?\b/i,
  ],
  voltage: [
    /\bvoltage\b/i,
    /input\s*voltage\b/i,
    /output\s*voltage\b/i,
    /\bV\b/i,
  ],
  frequency: [
    /\bfrequency\b/i,
    /\bHz\b/i,
  ],
  battery_type: [
    /\bbattery\b/i,
    /battery\s*type\b/i,
  ],
  battery_voltage: [
    /battery\s*voltage\b/i,
  ],
  battery_capacity: [
    /battery\s*capacity\b/i,
    /amp-hours\b/i,
    /watt-hours\b/i,
    /\bAh\b/i,
    /\bWh\b/i,
  ],
  runtime: [
    /\brun\s*time\b/i,
    /\bruntime\b/i,
    /battery\s*life\b/i,
    /operating\s*time\b/i,
  ],
  charge_time: [
    /charge\s*time\b/i,
    /charging\s*time\b/i,
    /charge\s*cycle\b/i,
  ],
  power_source: [
    /power\s*source\b/i,
    /adapter\s*type\b/i,
    /\bcharger\b/i,
    /power\s*brick\b/i,
    /plug\s*type\b/i,
    /cord\s*length\b/i,
  ],

  /* Performance & specs */
  speed: [
    /\b(?:speed|max\s*speed|rated\s*speed|travel\s*speed)\b/i,
  ],
  rpm: [
    /\brpm\b/i,
    /rotations\s*per\s*minute\b/i,
  ],
  flow_rate: [
    /flow\s*rate\b/i,
    /throughput\b/i,
    /\bL\/min\b/i,
    /\bGPH\b/i,
  ],
  pressure: [
    /\bpressure\b/i,
    /max\s*pressure\b/i,
    /operating\s*pressure\b/i,
    /\bpsi\b/i,
    /\bbar\b/i,
  ],
  torque: [
    /\btorque\b/i,
    /\bNm\b/i,
    /ft[-\s]*lb\b/i,
  ],
  horsepower: [
    /\bhorsepower\b/i,
    /\bHP\b/i,
  ],
  efficiency: [
    /\befficiency\b/i,
    /energy\s*efficiency\s*rating\b/i,
  ],

  /* Environmental & safety */
  operating_temperature: [
    /operating\s*temperature\b/i,
    /temperature\s*range\b/i,
  ],
  storage_temperature: [
    /storage\s*temperature\b/i,
  ],
  humidity_range: [
    /humidity\s*range\b/i,
  ],
  ip_rating: [
    /\bIP\s*rating\b/i,
    /ingress\s*protection\b/i,
    /\bNEMA\s*rating\b/i,
  ],
  warnings: [
    /\bwarnings?\b/i,
    /\bcautions?\b/i,
    /safety\s*information\b/i,
    /\bprecautions?\b/i,
    /contraindications\b/i,
    /hazard\s*statements\b/i,
    /\bdanger\b/i,
    /\bwarning\b/i,
    /\bcaution\b/i,
    /user\s*instructions\b/i,
    /operating\s*instructions\b/i,
    /usage\s*guidelines\b/i,
  ],

  /* Included items & packaging */
  included_items: [
    /what'?s\s*included\b/i,
    /in\s*the\s*box\b/i,
    /box\s*contents\b/i,
    /package\s*contents\b/i,
    /included\s*items\b/i,
    /bundle\s*contents\b/i,
    /kit\s*contents\b/i,
    /accessories\s*included\b/i,
  ],
  shipping_dimensions: [
    /shipping\s*dimensions\b/i,
    /carton\s*size\b/i,
    /box\s*dimensions\b/i,
    /package\s*size\b/i,
  ],

  /* Warranty & service */
  warranty: [
    /\bwarranty\b/i,
    /warranty\s*period\b/i,
    /limited\s*warranty\b/i,
    /warranty\s*coverage\b/i,
  ],
  guarantee: [
    /\bguarantee\b/i,
    /guarantee\s*period\b/i,
    /satisfaction\s*guarantee\b/i,
  ],
  service_life: [
    /service\s*life\b/i,
    /expected\s*life\b/i,
    /\bMTBF\b/i,
    /mean\s*time\s*between\s*failures\b/i,
  ],

  /* Section/heading phrases (used for multi‑line extraction if desired) */
  specs_section: [
    /specifications?\b/i,
    /technical\s*spec/i,
    /spec\s*sheet\b/i,
    /data\s*sheet\b/i,
    /product\s*specifications\b/i,
    /product\s*specs\b/i,
    /detailed\s*specs\b/i,
    /general\s*specs\b/i,
    /core\s*specs\b/i,
    /specs\s*&\s*details\b/i,
  ],
  features_section: [
    /\bfeatures?\b/i,
    /key\s*features\b/i,
    /main\s*features\b/i,
    /product\s*features\b/i,
    /standout\s*features\b/i,
    /notable\s*features\b/i,
    /unique\s*features\b/i,
    /exclusive\s*features\b/i,
    /\bbenefits?\b/i,
    /key\s*benefits\b/i,
    /product\s*benefits\b/i,
    /selling\s*points\b/i,
  ],
  overview_section: [
    /\boverview\b/i,
    /product\s*overview\b/i,
    /\bdescription\b/i,
    /about\s*this\s*item\b/i,
    /\bdetails\b/i,
    /product\s*details\b/i,
    /introduction\b/i,
    /features\s*overview\b/i,
  ],
  included_section: [
    /what'?s\s*included\b/i,
    /in\s*the\s*box\b/i,
    /included\s*items\b/i,
    /bundle\s*contents\b/i,
    /kit\s*contents\b/i,
    /package\s*contents\b/i,
    /accessories\b/i,
  ],
  safety_section: [
    /\bwarnings?\b/i,
    /\bcautions?\b/i,
    /safety\s*information\b/i,
    /precautions\b/i,
    /user\s*manual\b/i,
    /\binstructions\b/i,
    /hazard\s*information\b/i,
  ],
  warranty_section: [
    /\bwarranty\b/i,
    /limited\s*warranty\b/i,
    /\bguarantee\b/i,
    /warranty\s*&\s*service\b/i,
    /warranty\s*details\b/i,
    /guarantee\s*information\b/i,
  ],
  mixed_section: [
    /specs\s*&\s*features\b/i,
    /specifications\s*&\s*features\b/i,
    /features\s*&\s*specifications\b/i,
    /features\s*&\s*benefits\b/i,
    /benefits\s*&\s*features\b/i,
    /highlights\s*&\s*specs\b/i,
    /specs\s*\+\s*features\b/i,
    /specs\s*\+\s*benefits\b/i,
    /full\s*specs\s*&\s*highlights\b/i,
  ],
  
  /* Miscellaneous fields retained from original map */
  seat_dimensions: [/seat\s*dimensions?|seat\s*(width|depth)/i],
  seat_opening: [/seat\s*opening/i],
  adjustable_seat_height: [/adjustable\s*seat\s*height|seat\s*height/i],
  top_speed: [/top\s*speed/i],
  turning_radius: [/turning\s*radius/i],
  batteries: /\bbatter(?:y|ies)\b/i,
  motor: /\bmotor\b/i,
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
    const m = normText(rawText).match(new RegExp(`(${rx.source})[:\\s-]+([^\\n]{2,80})`, 'i'));
      if (m) {
        hits[canon] = m[2] ? m[2].trim() : '';
      }
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
  // Build a list of candidate URLs to try. Start with the original URL and
  // optionally a version without the leading www. Some hosts only serve PDFs
  // from the bare domain. We'll also generate additional candidates by
  // stripping common "download" or "view" segments from the path. This is
  // important for sites that proxy PDF downloads through intermediate
  // endpoints like /download/ or /view/ but ultimately serve the same file
  // when that segment is removed. Duplicates are automatically deduped by
  // using a Set. See notes in README for examples (e.g. motifmedical.com).
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
    // Also generate a candidate with *all* skip segments removed. This handles
    // cases where multiple proxy segments (e.g. /file/download/file/) appear in the URL.
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
        return "";
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
          // Use a RegExp constructor instead of a regex literal to avoid issues with
          // escape sequences being interpreted inconsistently across Node versions.
          // This pattern matches fully qualified PDF URLs (e.g. https://example.com/file.pdf)
          // and allows optional query parameters.
          const absRe = new RegExp(
            "https?:\\\/\\\/[^\"'<>\\s]+?\\.pdf(?:\\?[^\"'<>\\s]*)?",
            "gi"
          );
          let m;
          while ((m = absRe.exec(html))) {
            pdfLinks.push(m[0]);
          }
          // Relative links in href/src attributes
          // Similar RegExp constructor for relative href/src attributes linking to PDF files.
          const relRe = new RegExp(
            "(?:href|src)\\s*=\\s*[\"']([^\"']+?\\.pdf(?:\\?[^\"']*)?)[\"']",
            "gi"
          );
          while ((m = relRe.exec(html))) {
            try {
              const u = new URL(m[1], resp.url).href;
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
      let text = data.text || '';
      // If no text was extracted, perform an OCR fallback on the scanned PDF.
      if (!text || !text.trim()) {
        try {
          text = await ocrScanPdf(buffer);
        } catch (err) {
          // ignore OCR errors; keep text as empty string
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

