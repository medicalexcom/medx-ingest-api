import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { kvPairs, pickBySynonyms, parsePdfFromUrl } from './pdfParser.js';

// We no longer implement our own PDF fetch fallback here.
// Instead, use parsePdfFromUrl from pdfParser.js which handles multiple candidate URLs
// and adds browser-like headers. Leaving this comment in place for context.

export async function enrichFromManuals(norm, { maxManuals = 3, maxCharsText = 20000 } = {}) {
  const manuals = Array.isArray(norm.manuals) ? norm.manuals.slice(0, maxManuals) : [];
  if (!manuals.length) return norm;
  const pdf_text_all = [];
  const pdf_tables_all = [];
  const pdf_kv_all = [];

  for (const url of manuals) {
    try {
      // Use the shared parser from pdfParser.js which already implements fallback and headers.
      const parsed = await parsePdfFromUrl(url);
      if (!parsed) continue;
      if (parsed.kv && typeof parsed.kv === 'object') {
        norm.specs = { ...(norm.specs || {}), ...parsed.kv };
        pdf_kv_all.push(parsed.kv);
      }
      const featuresFromText = (t) => String(t || '')
        .split(/\n+/)
        .map(s => s.trim())
        .filter(s => s.length >= 7 && s.length <= 180 && /[A-Za-z]/.test(s) && !/^page\s*\d+$/i.test(s))
        .slice(0, 50);
      if (parsed.text) {
        const feats = featuresFromText(parsed.text);
        if (feats.length) {
          const seen = new Set((norm.features_raw || []).map(v => String(v).toLowerCase()));
          for (const f of feats) {
            const k = f.toLowerCase();
            if (!seen.has(k)) { (norm.features_raw ||= []).push(f); seen.add(k); }
            if (norm.features_raw.length >= 20) break;
          }
        }
      }
      if (parsed.text) {
        pdf_text_all.push(parsed.text);
      }
      if (Array.isArray(parsed.tables) && parsed.tables.length) {
        pdf_tables_all.push(...parsed.tables);
      }
    } catch (e) {
      // ignore
    }
  }
      if (pdf_text_all.length) {
        // Join all PDF texts together and merge with any existing description.
        const joined = pdf_text_all.join('\n');
        // Break into individual lines, normalise whitespace and trim.
        const lines = (norm.description_raw || '' ? norm.description_raw + '\n' : '')
          .concat(joined)
          .split(/\n+/)
          .map(s => s.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const seen = new Set();
        const merged = [];
        for (const l of lines) {
          // Normalise the key for duplicate detection by removing non-alphanumeric
          // characters and collapsing to lowercase. This dedupes lines that differ
          // only by punctuation, case or extra spaces. Example: "High-strength
          // aluminum frame." and "High Strength Aluminum Frame" will be treated
          // as the same description.
          const key = l.toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(l);
          }
          // Stop early if the merged description exceeds maxCharsText characters.
          if (merged.join('\n').length >= maxCharsText) break;
        }
        norm.description_raw = merged.join('\n');
      }
  if (pdf_text_all.length) norm.pdf_text = pdf_text_all.join('\n\n');
  if (pdf_kv_all.length) norm.pdf_kv = pdf_kv_all;
  if (pdf_tables_all.length) norm.pdf_tables = pdf_tables_all;
  return norm;
}
