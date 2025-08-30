import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { kvPairs, pickBySynonyms, parsePdfFromUrl } from './pdfParser.js';

// We no longer implement our own PDF fetch fallback here.
// Instead, use parsePdfFromUrl from pdfParser.js which handles multiple candidate URLs
// and adds browser-like headers. Leaving this comment in place for context.

export async function enrichFromManuals(norm, { maxManuals = 3, maxCharsText = 20000 } = {}) {
  const manuals = Array.isArray(norm.manuals) ? norm.manuals.slice(0, maxManuals) : [];
  // Always set pdf_text: if there are no manuals, indicate no documents
  if (!manuals.length) {
    norm.pdf_text = 'No documents available';
    return norm;
  }
  const pdf_text_all = [];
  const pdf_tables_all = [];
  const pdf_kv_all = [];

  // Initialise per-source feature and spec containers if not already present.
  // These arrays capture provenance for downstream processing and should not
  // replace existing fields. They accumulate all features and specs
  // extracted from PDF manuals. If the caller already provided
  // features_pdf/specs_pdf on the norm object (e.g. from a previous run),
  // reuse them rather than overwriting.
  norm.features_pdf = Array.isArray(norm.features_pdf) ? norm.features_pdf : [];
  norm.specs_pdf = Array.isArray(norm.specs_pdf) ? norm.specs_pdf : [];

  for (const url of manuals) {
    try {
      // Use the shared parser from pdfParser.js which already implements fallback and headers.
      const parsed = await parsePdfFromUrl(url);
      if (!parsed) continue;
      if (parsed.kv && typeof parsed.kv === 'object') {
        // Merge key/value pairs into the unified specs map and also record
        // them under specs_pdf for provenance.  Keys in parsed.kv are
        // assumed to already be normalised by the pdfParser; copy them
        // directly and avoid overwriting existing keys on norm.specs.
        norm.specs = { ...(norm.specs || {}) };
        for (const [k, v] of Object.entries(parsed.kv)) {
          if (v == null) continue;
          // Only set the key in the unified specs if it is undefined; do not
          // clobber values from other sources.
          if (!(k in norm.specs)) {
            norm.specs[k] = v;
          }
          // Always push into specs_pdf; later deduplication can remove
          // duplicates.
          norm.specs_pdf.push({ key: k, value: v });
        }
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
          // Use a set to avoid inserting duplicate lines across runs.
          const seen = new Set((norm.features_raw || []).map(v => String(v).toLowerCase()));
          for (const f of feats) {
            const lower = f.toLowerCase();
            if (!seen.has(lower)) {
              (norm.features_raw ||= []).push(f);
              norm.features_pdf.push(f);
              seen.add(lower);
            } else {
              // Even if the feature already exists in features_raw, record it
              // in features_pdf for provenance so that PDF‑sourced lines can be
              // separated later.
              norm.features_pdf.push(f);
            }
            // Limit the total number of raw features to avoid runaway lists.
            if (norm.features_raw.length >= 20) break;
          }
        }
      }
      if (parsed.text) {
        pdf_text_all.push(parsed.text);
      }
      if (Array.isArray(parsed.tables) && parsed.tables.length) {
        pdf_tables_all.push(...parsed.tables);
        // Extract additional specification rows from PDF tables.  Many manuals
        // encode specs as two‑column tables (label/value).  Convert each
        // row into key/value entries and append to norm.specs and
        // norm.specs_pdf.  Only the first two columns are considered; any
        // extra columns are ignored.
        for (const tbl of parsed.tables) {
          if (!Array.isArray(tbl) || tbl.length === 0) continue;
          for (const row of tbl) {
            if (!Array.isArray(row) || row.length < 2) continue;
            const keyRaw = String(row[0] || '').trim();
            const valueRaw = String(row[1] || '').trim();
            if (!keyRaw || !valueRaw) continue;
            const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
            // Only record new specs if the key does not exist yet.
            if (!(key in norm.specs)) {
              norm.specs[key] = valueRaw;
            }
            norm.specs_pdf.push({ key, value: valueRaw });
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }
  // Do not merge PDF text into the description. Always set pdf_text, even if empty.
  if (pdf_text_all.length) {
    norm.pdf_text = pdf_text_all.join('\n\n');
  } else {
    // If no text extracted, indicate no documents available
    norm.pdf_text = 'No documents available';
  }
  if (pdf_kv_all.length) norm.pdf_kv = pdf_kv_all;
  if (pdf_tables_all.length) norm.pdf_tables = pdf_tables_all;
  return norm;
}
