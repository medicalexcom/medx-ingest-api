// Removed cleanProductRecord import – send full merged object directly to GPT

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
  // Attach the browser-collected data under the `_browse` namespace. Do not merge
  // any of the browser fields into the top-level object; keep the original
  // arrangement of the scraped data intact. Clients can access `_browse` to
  // consume the dynamic content separately.
  out._browse = raw_browse;
  // Clean out noise from features, specs, and browse console
  return removeNoise(out);
}

/**
 * Remove noise from a merged record.
 * Filters out e-commerce clutter, pricing, part numbers, and other non-product data.
 *
 * @param {object} record The merged product record.
 * @returns {object} A cleaned product record.
 */
function removeNoise(record) {
  const rec = record;

  // Clean features_raw: remove blank, price, add-to-cart, phone/fax, generic headings, part numbers
  if (Array.isArray(rec.features_raw)) {
    rec.features_raw = rec.features_raw.filter((line) => {
      const text = String(line || '').trim();
      if (!text) return false;
      const lower = text.toLowerCase();
      // Remove price or quantity info
      if (/\$\s*\d/.test(lower) || /\bprice\b/.test(lower)) return false;
      // Remove add to cart or checkout prompts
      if (/add to cart|add to wishlist|add to compare|checkout|shopping cart/.test(lower)) return false;
      // Remove insurance or eligibility notes
      if (/insurance|eligible/.test(lower)) return false;
      // Remove review/testimonial prompts
      if (/reviews?|write a review|customer reviews/.test(lower)) return false;
      // Remove phone or fax numbers
      if (/phone|fax/.test(lower)) return false;
      // Remove headings or non-descriptive labels
      if (/^details$|^specifications$|^size & weight$|^accessories & components$|^features$/i.test(text)) return false;
      // Remove generic one-word or two-word labels
      if (text.split(/\s+/).length < 3) return false;
      // Remove part numbers (combination of letters and digits)
      if (/\b[A-Za-z]{2,}[\d]{2,}/.test(text)) return false;
      // Remove copyright or domain names
      if (/©|\bcom\b|\.com/.test(lower)) return false;
      return true;
    });
  }

  // Clean specs: remove keys that look like part numbers or ordering info
  if (rec.specs && typeof rec.specs === 'object') {
    for (const key of Object.keys(rec.specs)) {
      const lowerKey = key.toLowerCase();
      // Part number keys: contain digits and underscores (e.g. ip730_2101) or are obviously ordering references
      if (/(\d.*_.*\d)|(_\d+$)/.test(key)) {
        delete rec.specs[key];
        continue;
      }
      if (/item#|case_quantity|hcpcs|productid/.test(lowerKey)) {
        delete rec.specs[key];
        continue;
      }
      // Remove warranty details from specs; keep high-level warranty separately
      if (/warranty/.test(lowerKey)) {
        delete rec.specs[key];
        continue;
      }
    }
  }

  // Remove browse console logs (warnings/errors)
  if (rec._browse && rec._browse.console) {
    delete rec._browse.console;
  }

  // Surface manual PDF URLs as `pdf_docs` for downstream GPT usage.
  // If the record already has a `manuals` array and no `pdf_docs` field,
  // copy the manuals array into a new property `pdf_docs`. This makes it
  // explicit that these documents are intended to be referenced alongside the
  // scraped data when generating SEO content. Do not rename or remove the
  // original `manuals` array to preserve backwards compatibility with any
  // existing consumers of the API.
  if (Array.isArray(rec.manuals) && !rec.pdf_docs) {
    rec.pdf_docs = [...rec.manuals];
  }

  return rec;
}

// Export removeNoise for use in other modules (e.g., server.js)
export { removeNoise };
