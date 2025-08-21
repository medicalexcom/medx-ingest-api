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
        // m[2] may be undefined if the value is missing; use empty string in that case
        out[key] = m[2] ? m[2].trim() : '';
      }
    });
  return out;
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

