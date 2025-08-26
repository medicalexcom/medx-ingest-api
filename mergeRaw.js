// mergeRaw.js
// Utility to combine the existing raw scraper output with the
// output from the Playwright browser collector. The merge is
// deliberately non-destructive: existing fields on the original
// object take precedence, and new data from the browser is added
// under the `_browse` namespace as well as convenience lifts.

/**
 * Merge two raw objects into a single result. The `raw_existing`
 * object should be the output from the current scraper pipeline.
 * `raw_browse` should be the object returned from browseProduct.
 *
 * @param {object} param0
 * @param {object} param0.raw_existing The original raw scrape.
 * @param {object} param0.raw_browse The browser-collected data.
 */
export function mergeRaw({ raw_existing = {}, raw_browse = {} }) {
  const out = { ...raw_existing };
  // Namespaced capsule for browser output
  out._browse = raw_browse;
  // Lift certain fields if missing in the original
  if (!out.full_html && raw_browse.full_html) out.full_html = raw_browse.full_html;
  if (!out.visible_text && raw_browse.visible_text) out.visible_text = raw_browse.visible_text;
  // Ensure lists are unique
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
  const bLinks = raw_browse.links || {};
  out.images = uniq([...(out.images || []), ...(bLinks.images || [])]);
  out.pdfs = uniq([...(out.pdfs || []), ...(bLinks.pdfs || [])]);
  out.links = uniq([...(out.links || []), ...(bLinks.anchors || [])]);
  // Merge sections non-destructively
  out.sections = {
    ...(out.sections || {}),
    description: out.sections?.description || raw_browse.sections?.description || '',
    specifications: out.sections?.specifications || raw_browse.sections?.specifications || '',
    features: out.sections?.features || raw_browse.sections?.features || '',
    included: out.sections?.included || raw_browse.sections?.included || '',
  };
  return out;
}
