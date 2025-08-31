// lib/cleanForGPT.js
//
// This module cleans and normalises product records scraped from e‑commerce
// sites prior to processing by GPT.  It is based off the upstream
// `cleanForGPT.js` in the medx‑ingest‑api repository but extended with two
// key enhancements:
//
//   1. **Bullet fusion** — Many product pages split a single feature across
//      multiple DOM nodes (for example, a bold prelude followed by a
//      sentence).  The `fuseBullets` helper stitches short or trailing
//      fragments onto the next line so that features are never truncated.
//
//   2. **Unit normalisation** — Product specifications frequently mix
//      synonyms for the same units (e.g. “inches”, “inch”, “lbs”).  The
//      `normalizeUnits` helper rewrites these into canonical short forms
//      (e.g. `in`, `lb`, `mm`).  Normalisation happens on a per‑value basis
//      inside `cleanSpecs` so downstream consumers get consistent data.

const URL_RX = /https?:\/\/[^\s)]+/gi;

// Sections whose names should cause the entire section to be skipped when
// cleaning specs.  These keys come from the upstream implementation.
const NOISE_SECTIONS = new Set([
  'details',
  'specifications',
  'accessories',
  'accessories & components',
  'size & weight',
  "what's in the box",
  'features',
  'included'
]);

// Phrases that, if found in a line of text, cause that line to be
// disregarded.  These are typically marketing boilerplate or noise.
const DROP_PHRASES = [
  'add to cart',
  'add to wish list',
  'add to compare',
  'qty',
  'in stock',
  'checkout',
  'checkout faster',
  'track order',
  'create an account',
  'sign in',
  'cart',
  'shopping cart',
  'price',
  '$',
  'msrp',
  'sku:',
  'check with insurance',
  'hsa',
  'eligible',
  'upsell',
  'bundle',
  'add to',
  'show details',
  '©',
  'all rights reserved',
  'privacy policy',
  'terms of use',
  'copyright',
  'newsletter',
  'to order: phone',
  'fax',
  'phone',
  'call us',
  'contact us at',
  '@',
  'www.',
  'content security policy directive',
  'unrecognized feature',
  'console',
  'warning',
  'error',
  'covid',
  'update',
  // Additional noise phrases to filter out UI/commerce chrome and unrelated marketing boilerplate.
  // These catch common interstitial prompts, accessory navigational labels and other site furniture that should never
  // appear in a product description or feature list.
  'product is already in the cart',
  'add to favorites',
  'added to favorites',
  'go to favorites',
  'remove from favorites',
  'sign in to view price',
  'sign in to see pricing',
  'log in to order',
  'share this',
  'copy link',
  'thanks for sharing',
  'current tab:',
  'view product options',
  'close product options',
  'view all accessories',
  'view less accessories',
  'download catalog page',
  'owners manual',
  'parts diagram',
  'frequently viewed together',
  'compare products',
  'clear compare',
  'who we are',
  'who we serve',
  'support & resources',
  'knowledge base',
  'terms & conditions',
  'mdsap certificate',
  'ec certificate',
  'locate providers',
  'inspired by drive',
  'flu season is coming',
  'covid-19 vaccines are available',
  'inventory management',
  'distribution',
  'lab management',
  // Additional UI/navigation phrases observed on various supplier sites.  These
  // strings are lowercase because we normalize the text before matching.  See
  // the comprehensive noise guidelines in code comments for context.
  'privacy policy',
  'us en',
  'canada - english',
  'canada - french',
  'uk - english',
  'germany - deutsch',
  'france - french',
  'chat',
  'subscribe'
];

const DROP_RE = new RegExp(
  `\\b(${DROP_PHRASES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

// Match section headings that appear as standalone words at the start of
// bullet lists.  These are removed so we don’t treat them as real content.
// Added “parts” to cover Drive/McKesson tab labels such as “Parts”.
const HEADING_RE = /^(details|spec(ification|s)?|features|included|accessories|parts|size\s*&\s*weight|warranty|notes)\s*:?$/i;

/**
 * Parse a Markdown table into a flat specification object.  Only the
 * first two columns of each row are considered (the header row is
 * ignored).  This is designed to handle simple `| Spec | Value |` tables
 * found in some Compass Health product pages.  Keys and values are
 * trimmed of surrounding whitespace.  If duplicate keys are present,
 * later entries will overwrite earlier ones.
 *
 * @param {string|undefined} md
 * @returns {Object}
 */
function parseSpecsMarkdown(md) {
  const specs = {};
  if (typeof md !== 'string') return specs;
  const lines = md.split(/\r?\n/);
  // Skip header row and separator row; assume any row starting with '|' and
  // containing at least two '|' separators is a data row
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const parts = line.split('|').map(p => p.trim());
    // parts[0] is empty due to leading '|', remove it
    if (parts.length < 3) continue;
    const [, key, value] = parts;
    if (key && value) {
      specs[key] = value;
    }
  }
  return specs;
}

/**
 * Parse a Markdown bullet list into an array of feature strings.  Lines
 * starting with a dash (`-`) have the dash removed; blank lines are
 * ignored.  The returned list preserves the original order.
 *
 * @param {string|undefined} md
 * @returns {string[]}
 */
function parseFeaturesMarkdown(md) {
  if (typeof md !== 'string') return [];
  return md
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      return line.startsWith('-') ? line.replace(/^\s*-\s*/, '') : line;
    });
}
const PARTNO_LINE_RE = /(^|[\s(])([A-Z]{2,5}\d{2,5}(?:[-_]\d{2,5})+)\b/;
const PARTNO_KEY_RE = /^(?:[a-z]{2,5}\d{2,6}(?:[_-]\d{2,6})+|item#|upc_uom|upcuom)$/i;

// Top‑level keys to drop entirely from the returned record
const ALWAYS_DROP_KEYS = new Set([
  // Internal/debug keys we never surface downstream
  '_browse',
  'console',
  '_debug',
  // Markdown fields are parsed into structured fields elsewhere; drop raw Markdown
  'features_md',
  'specs_md',
  'description_md',
  'pdf_kv',
  'pdf_text_md',
  // Many Compass Health pages include a `visible_text` field containing
  // navigational furniture or category lists rather than meaningful
  // product content.  Historically this key was dropped to avoid leaking
  // noise.  However, some suppliers also expose important human‑readable
  // description content via `visible_text`.  We therefore no longer
  // unconditionally drop this key.  Downstream code should decide how
  // to handle `visible_text` on a case‑by‑case basis.
  // 'visible_text',
]);

// Allowlist of spec keys.  If a key does not match any of these
// expressions and does not contain a numeric unit, it is ignored.
const SPEC_ALLOWLIST_RX = [
  /^(model|sku|mpn|gtin|gtin8|upc|ean)$/i,
  /(brand|color|finish|material|frame|warranty)/i,
  /(weight(_capacity)?|shipping_weight|product_weight)/i,
  /(size|dimensions|overall_dimensions|shipping_size)/i,
  /(seat(_dimensions|_opening)?|width_between_arms|adjustable_seat_height)/i,
  /(eyepiece|objectives?|head|stage|condenser|illuminator)/i,
  /(battery|rechargeable|voltage|power|motor|controller)/i,
  /(noise|decibel|db)/i,
  /(closed_system|backflow|suction|vacuum|cycle|night_light|lcd|display)/i
];

// Minimum length (in characters) for a feature line to be kept
// Minimum length for a feature line.  Previously this was set to 20,
// which filtered out legitimately short features such as "Bed Rail" or
// "Bariatric Bed".  Reduce this threshold to 8 characters so that
// multi‑word, concise features are retained while still excluding
// extremely short fragments like "N/A" or "X".
const FEATURE_MIN_CHAR = 8;

/**
 * Normalise curly quotes, em/en dashes and whitespace.  Returns a
 * trimmed string.
 *
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return String(s || '')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove known site names and URLs from a string.  Also collapses
 * multiple spaces into one and trims the result.
 *
 * @param {string} s
 * @returns {string}
 */
function stripSiteNames(s) {
  let t = norm(s)
    .replace(/\b(unicosci\.com|compasshealthbrands\.com|spectrababyusa\.com|unimomus\.com)\b/ig, '')
    .replace(URL_RX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

/**
 * Determine whether a line of text is noise and should be skipped
 * entirely.  Uses a combination of pattern checks and length
 * heuristics derived from the upstream implementation.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isNoiseLine(line) {
  const L = norm(line);
  if (!L) return true;
  if (HEADING_RE.test(L)) return true;
  if (DROP_RE.test(L)) return true;
  if (PARTNO_LINE_RE.test(L)) return true;
  if (/^(?:details|specs?|accessor|size|weight|warranty)\b.*$/i.test(L) && L.split(' ').length < 3) return true;
  if (L.replace(/[^\w]/g, '').length < 4) return true;
  return false;
}

/**
 * Fuse truncated or prefixed bullet lines into complete sentences.  Many
 * product pages split a bold lead (“Powerful:”) from the following
 * description.  This helper concatenates such fragments to avoid
 * treating them as separate features.  A fragment is detected when a
 * line ends with a colon or hyphen or has very few words; it is then
 * appended to the next non‑noise line.
 *
 * @param {string[]} arr An array of raw feature strings
 * @returns {string[]} A new array with fused feature lines
 */
function fuseBullets(arr = []) {
  const fused = [];
  let buffer = '';
  for (let i = 0; i < arr.length; i++) {
    let line = stripSiteNames(arr[i]).replace(/^[\s•\-–—]+/, '').trim();
    if (isNoiseLine(line)) continue;
    // If there is buffered text from the previous iteration, prepend it
    if (buffer) {
      line = `${buffer} ${line}`.trim();
      buffer = '';
    }
    // Consider the line a prefix if it ends with a colon/dash or is very
    // short (<=3 words).  Buffer it and continue to the next line.
    if ((/[:–—-]\s*$/.test(line) || line.split(' ').length <= 3) && i < arr.length - 1) {
      buffer = line.replace(/[:–—-]\s*$/, '').trim();
      continue;
    }
    fused.push(line);
  }
  if (buffer) fused.push(buffer.trim());
  return fused;
}

/**
 * Normalise units within a specification value.  Converts various
 * synonyms to canonical short forms (e.g. inches → in, pounds → lb).
 * Also normalises multiplication signs to a consistent “×” delimiter
 * with surrounding spaces.
 *
 * @param {string} v
 * @returns {string}
 */
function normalizeUnits(v) {
  let s = String(v);
  // Replace inch quotes and synonyms with "in"
  s = s.replace(/\b(inches|inch|in\.?)\b/gi, 'in');
  // Replace double prime symbol (″) with in
  s = s.replace(/\u2033/g, 'in');
  // Replace pound synonyms with "lb"
  s = s.replace(/\b(pounds|pound|lbs|lb\.? )\b/gi, 'lb');
  // Replace kilogram synonyms with "kg"
  s = s.replace(/\b(kilograms|kilogram|kgs|kg\.? )\b/gi, 'kg');
  // Replace millimetre synonyms with "mm"
  s = s.replace(/\b(millimetres|millimeters|millimeter|mm\.? )\b/gi, 'mm');
  // Replace centimetre synonyms with "cm"
  s = s.replace(/\b(centimetres|centimeters|centimeter|cm\.? )\b/gi, 'cm');
  // Replace ounce synonyms with "oz"
  s = s.replace(/\b(ounces|ounce|oz\.? )\b/gi, 'oz');
  // Replace watt synonyms with "W"
  s = s.replace(/\b(watts|watt)\b/gi, 'W');
  // Replace volt synonyms with "V"
  s = s.replace(/\b(volts|volt)\b/gi, 'V');
  // Replace ampere synonyms with "A"
  s = s.replace(/\b(amps|ampere|amperes|amp)\b/gi, 'A');
  // Normalise degrees symbols
  s = s.replace(/°\s*F\b/gi, '°F').replace(/°\s*C\b/gi, '°C');
  // Normalise multiplication signs (x/×) with spaces
  s = s.replace(/\s*[x×]\s*/gi, ' × ');
  // Collapse multiple spaces
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

/**
 * Clean an array of feature strings.  Applies bullet fusion, noise
 * filtering, de‑duplication and length filtering.  Only the first
 * 24 unique features are returned.
 *
 * @param {string[]} arr
 * @returns {string[]}
 */
function cleanFeatures(arr) {
  const fused = fuseBullets(arr || []);
  const out = [];
  const seen = new Set();
  fused.forEach(raw => {
    let line = raw;
    if (isNoiseLine(line)) return;
    line = line.replace(/^[\s•\-–—]+/, '').trim();
    if (line.length < FEATURE_MIN_CHAR) return;
    const key = line.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  });
  return out.slice(0, 24);
}

/**
 * Clean a raw specs object.  Drops disallowed keys, filters out
 * obviously non‑spec values, applies an allowlist, normalises keys
 * and values, and normalises units.  Returns a new object with
 * canonical keys and cleaned values.
 *
 * @param {Object} specsRaw
 * @returns {Object}
 */
function cleanSpecs(specsRaw = {}) {
  const specs = {};
  for (const [kRaw, vRaw] of Object.entries(specsRaw)) {
    const k = norm(kRaw);
    let v = stripSiteNames(vRaw);
    if (!k || !v) continue;
    if (ALWAYS_DROP_KEYS.has(k)) continue;
    if (PARTNO_KEY_RE.test(k)) continue;
    if (DROP_RE.test(v)) continue;
    // Skip entire noise sections
    if (NOISE_SECTIONS.has(k.toLowerCase())) continue;
    // Only allow keys that match the allowlist or contain numeric units or common terms
    const allow = SPEC_ALLOWLIST_RX.some(rx => rx.test(k)) ||
      /\b(\d+(\.\d+)?\s*(mmhg|mm|cm|in|inch|inches|lb|lbs|kg|oz|w|v|a|mah|db|hz|°f|°c))\b/i.test(v) ||
      /\b(binocular|trinocular|plan|achromat|closed system|rechargeable|halogen)\b/i.test(v);
    if (!allow) continue;
    const keyCanon = k
      .replace(/\s+/g, '_')
      .replace(/__+/g, '_')
      .toLowerCase();
    v = normalizeUnits(v);
    specs[keyCanon] = v;
  }
  return specs;
}

/**
 * Filter and clean an array of image URLs.  Keeps only valid HTTP
 * image links (png/jpeg/webp/gif) and removes duplicates.  At most
 * sixteen images are returned.
 *
 * @param {Array} arr
 * @returns {Array<{url: string}>}
 */
function cleanImages(arr = []) {
  const keep = [];
  const seen = new Set();
  for (const item of arr) {
    const url = item?.url || item;
    if (typeof url !== 'string') continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (!/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(url)) continue;
    const key = url.split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push({ url });
  }
  return keep.slice(0, 16);
}

/**
 * Filter and clean an array of manual links.  Retains only PDF URLs
 * and de‑duplicates based on the base URL.  Up to eight manuals are
 * returned.
 *
 * @param {Array} arr
 * @returns {string[]}
 */
function cleanManuals(arr = []) {
  const out = [];
  const seen = new Set();
  for (const url of arr) {
    const u = typeof url === 'string' ? url : url?.url;
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (!/\.pdf(\?|#|$)/i.test(u) && !/manual|instructions|ifus?/i.test(u)) continue;
    const key = u.split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, 8);
}

/**
 * Clean and summarise a raw description.  Removes section headings and
 * boilerplate, splits into sentences, de‑duplicates and limits the
 * length of the returned string to approximately 900 characters.
 *
 * @param {string} descRaw
 * @returns {string}
 */
function cleanDescription(descRaw = '') {
  const text = stripSiteNames(descRaw)
    .replace(/\b(?:details|specifications|accessories.*|size\s*&\s*weight)\b\s*:?.*/ig, '')
    .replace(PARTNO_LINE_RE, '')
    .replace(DROP_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text) return '';
  const sents = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s && s.length > 20 && !HEADING_RE.test(s) && !PARTNO_LINE_RE.test(s));
  const out = [];
  const seen = new Set();
  for (const s of sents) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.join(' ').length > 900) break;
  }
  return out.join(' ');
}

/**
 * Attempt to extract a normalised warranty term from multiple sources.  It
 * looks in the `specs` object, the explicit `warranty` field and the
 * `pdf_text` field for a phrase like “5 years” or “12 months”.
 *
 * @param {Object} param0
 * @returns {string|undefined}
 */
function extractWarranty({ specs = {}, warranty, pdf_text }) {
  const candidates = [
    warranty,
    specs.warranty,
    specs.warranty_period,
    specs.warranty_terms,
    pdf_text
  ]
    .filter(Boolean)
    .map(norm);
  for (const c of candidates) {
    const m = c.match(/\b(\d+)\s*(year|years|yr|yrs|month|months|mo)\b/i);
    if (m) {
      const n = m[1];
      const unit = /month/i.test(m[2])
        ? n === '1'
          ? '1 month'
          : `${n} months`
        : n === '1'
          ? '1 year'
          : `${n} years`;
      return unit;
    }
  }
  return undefined;
}

/**
 * Remove noise keys from the top level of a raw product record.  This is
 * used by the `cleanProductRecord` entrypoint.
 *
 * @param {Object} rec
 * @returns {Object}
 */
function pruneTopLevelNoise(rec) {
  const copy = { ...rec };
  for (const k of Object.keys(copy)) {
    if (ALWAYS_DROP_KEYS.has(k)) delete copy[k];
  }
  delete copy.console;
  delete copy._debug;
  delete copy._browse;
  delete copy.features_md;
  delete copy.specs_md;
  delete copy.description_md;
  delete copy.pdf_kv;
  return copy;
}

/**
 * Clean a raw product record into a normalised structure suitable for
 * consumption by GPT.  Applies all of the above helpers to produce
 * cleaned names, descriptions, features, specs, images, manuals and
 * warranty terms.  Only fields with non‑empty values are returned.
 *
 * @param {Object} input
 * @returns {Object}
 */
export function cleanProductRecord(input = {}) {
  // Extract features and specs from Markdown before we drop those keys.
  const featuresFromMd = parseFeaturesMarkdown(input.features_md);
  const specsFromMd = parseSpecsMarkdown(input.specs_md);

  // Remove noisy keys and create a shallow copy for downstream cleaning.
  const rec = pruneTopLevelNoise(input);

  // Merge parsed Markdown features into the raw features field.  If a
  // features array already exists, append; otherwise fall back to
  // features list if present.  This preserves original order: the
  // Markdown-derived features appear after any existing ones.
  if (featuresFromMd.length) {
    if (Array.isArray(rec.features_raw)) {
      rec.features_raw = rec.features_raw.concat(featuresFromMd);
    } else if (Array.isArray(rec.features)) {
      // If features_raw doesn't exist but a features list does, append to it.
      rec.features_raw = rec.features.concat(featuresFromMd);
      delete rec.features;
    } else {
      rec.features_raw = featuresFromMd.slice();
    }
  }

  // Merge parsed Markdown specs into the specs object.  Values from
  // Markdown override existing keys when there is a conflict.
  if (Object.keys(specsFromMd).length) {
    rec.specs = Object.assign({}, rec.specs || {}, specsFromMd);
  }
  const name = norm(rec.name_raw || rec.name || '');
  const sku = norm(rec.sku || rec.model || rec.specs?.model || '');
  const brand = norm(rec.brand || '');
  const description = cleanDescription(rec.description_raw || rec.description || '');
  const features = cleanFeatures(rec.features_raw || rec.features || []);
  const specs = cleanSpecs(rec.specs || {});
  const images = cleanImages(rec.images || []);
  const manuals = cleanManuals(rec.manuals || (rec._browse?.links?.pdfs || []));
  const warranty = extractWarranty({ specs, warranty: rec.warranty, pdf_text: rec.pdf_text });
  return {
    source: rec.source || rec._browse?.source_url || '',
    name,
    brand: brand || undefined,
    sku: sku || undefined,
    description,
    features,
    specs,
    images,
    manuals,
    warranty
  };
}
