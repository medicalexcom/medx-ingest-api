// lib/cleanForGPT.js
const URL_RX = /https?:\/\/[^\s)]+/ig;

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
  'update'
];

const DROP_RE = new RegExp(
  `\\b(${DROP_PHRASES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

const HEADING_RE = /^(details|spec(ification|s)?|features|included|accessories|size\s*&\s*weight|warranty|notes)\s*:?$/i;
const PARTNO_LINE_RE = /(^|[\s(])([A-Z]{2,5}\d{2,5}(?:[-_]\d{2,5})+)\b/;
const PARTNO_KEY_RE = /^(?:[a-z]{2,5}\d{2,6}(?:[_-]\d{2,6})+|item#|upc_uom|upcuom)$/i;

const ALWAYS_DROP_KEYS = new Set([
  '_browse',
  'console',
  'features_md',
  'specs_md',
  'description_md',
  'pdf_kv',
  'pdf_text_md',
  '_debug'
]);

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

const FEATURE_MIN_CHAR = 20;

function norm(s) {
  return String(s || '')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSiteNames(s) {
  let t = norm(s)
    .replace(/\b(unicosci\.com|compasshealthbrands\.com|spectrababyusa\.com|unimomus\.com)\b/ig, '')
    .replace(URL_RX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

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

function cleanFeatures(arr) {
  const out = [];
  const seen = new Set();
  (arr || []).forEach(raw => {
    let line = stripSiteNames(raw);
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

function cleanSpecs(specsRaw = {}) {
  const specs = {};
  for (const [kRaw, vRaw] of Object.entries(specsRaw)) {
    const k = norm(kRaw);
    const v = stripSiteNames(vRaw);
    if (!k || !v) continue;
    if (ALWAYS_DROP_KEYS.has(k)) continue;
    if (PARTNO_KEY_RE.test(k)) continue;
    if (DROP_RE.test(v)) continue;
    if ([
      'details',
      'specifications',
      'accessories',
      'accessories & components',
      'size & weight',
      'features',
      'included'
    ].includes(k.toLowerCase())) continue;
    const allow = SPEC_ALLOWLIST_RX.some(rx => rx.test(k)) ||
      /\b(\d+(\.\d+)?\s*(mmhg|mm|cm|in|inch|inches|lb|lbs|kg|oz|w|v|a|mah|db|hz|°f|°c))\b/i.test(v) ||
      /\b(binocular|trinocular|plan|achromat|closed system|rechargeable|halogen)\b/i.test(v);
    if (!allow) continue;
    const keyCanon = k
      .replace(/\s+/g, '_')
      .replace(/__/g, '_')
      .toLowerCase();
    specs[keyCanon] = v;
  }
  return specs;
}

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

export function cleanProductRecord(input = {}) {
  const rec = pruneTopLevelNoise(input);
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
