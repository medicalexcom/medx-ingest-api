// pdfEnrichment.js
import { parsePdfFromUrl } from './pdfParser.js';

/**
 * Enrich a normalised product object with data from PDF manuals.
 *
 * - Processes all manual URLs (no hard cap) unless a lower limit is passed.
 * - Records all manual URLs under `pdf_manual_urls`.
 * - Records any failed manual fetches under `manuals_failed` for debugging.
 * - If no text is extracted but manuals exist, sets pdf_text to an empty string
 *   rather than 'No documents available' so downstream consumers still know
 *   manuals were present.
 */
export async function enrichFromManuals(
  norm,
  { maxManuals = Infinity, maxCharsText = 49750 } = {}
) {
  // Slice to respect maxManuals if provided
  const manuals = Array.isArray(norm.manuals)
    ? norm.manuals.slice(0, maxManuals)
    : [];
  // Always record the list of manual URLs
  norm.pdf_manual_urls = manuals.slice();
  // Initialise failure log
  norm.manuals_failed = [];

  // If there are no manuals, make that explicit and return
  if (!manuals.length) {
    norm.pdf_text = 'No documents available';
    return norm;
  }

  const pdf_text_all = [];
  const pdf_tables_all = [];
  const pdf_kv_all = [];

  // Initialise per-source containers
  norm.features_pdf = Array.isArray(norm.features_pdf)
    ? norm.features_pdf
    : [];
  norm.specs_pdf = Array.isArray(norm.specs_pdf) ? norm.specs_pdf : [];
  norm.specs = norm.specs || {};

  for (const url of manuals) {
    try {
      const parsed = await parsePdfFromUrl(url);
      if (!parsed) {
        norm.manuals_failed.push(url);
        continue;
      }

      // merge kv pairs
      if (parsed.kv && typeof parsed.kv === 'object') {
        for (const [k, v] of Object.entries(parsed.kv)) {
          if (v == null) continue;
          if (!(k in norm.specs)) {
            norm.specs[k] = v;
          }
          norm.specs_pdf.push({ key: k, value: v });
        }
        pdf_kv_all.push(parsed.kv);
      }

      // derive features from text lines
      const featuresFromText = (t) =>
        String(t || '')
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(
            (s) =>
              s.length >= 7 &&
              s.length <= 180 &&
              /[A-Za-z]/.test(s) &&
              !/^page\s*\d+$/i.test(s)
          )
          .slice(0, 50);
      if (parsed.text) {
        const feats = featuresFromText(parsed.text);
        if (feats.length) {
          const seen = new Set(
            (norm.features_raw || []).map((v) => String(v).toLowerCase())
          );
          for (const f of feats) {
            const lower = f.toLowerCase();
            if (!seen.has(lower)) {
              (norm.features_raw ||= []).push(f);
              norm.features_pdf.push(f);
              seen.add(lower);
              if (norm.features_raw.length >= 20) break;
            } else {
              // still record provenance
              norm.features_pdf.push(f);
            }
          }
        }
        pdf_text_all.push(parsed.text);
      }

      // capture tables and convert two‑column rows into specs
      if (Array.isArray(parsed.tables) && parsed.tables.length) {
        pdf_tables_all.push(...parsed.tables);
        for (const tbl of parsed.tables) {
          if (!Array.isArray(tbl) || !tbl.length) continue;
          for (const row of tbl) {
            if (!Array.isArray(row) || row.length < 2) continue;
            const keyRaw = String(row[0] || '').trim();
            const valueRaw = String(row[1] || '').trim();
            if (!keyRaw || !valueRaw) continue;
            const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
            if (!(key in norm.specs)) {
              norm.specs[key] = valueRaw;
            }
            norm.specs_pdf.push({ key, value: valueRaw });
          }
        }
      }
    } catch (err) {
      // log failure; do not abort remaining manuals
      norm.manuals_failed.push(url);
    }
  }

  // Consolidate results
  if (pdf_text_all.length) {
    norm.pdf_text = pdf_text_all.join('\n\n');
  } else {
    // If no text but manuals exist, set pdf_text to empty to indicate presence
    norm.pdf_text = '';
  }
  if (pdf_kv_all.length) norm.pdf_kv = pdf_kv_all;
  if (pdf_tables_all.length) norm.pdf_tables = pdf_tables_all;

  return norm;
}
