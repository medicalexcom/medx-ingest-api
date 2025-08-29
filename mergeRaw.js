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
      // Preserve any line that mentions warranty details.  Product pages often
      // include features about parts warranties or pump warranties, which
      // should be retained even if other patterns might flag them as noise.
      if (/warranty/i.test(lower)) return true;

      // Remove price or quantity info, or upsell prompts
      if (/\$\s*\d/.test(lower) || /\bprice\b/.test(lower) || /\bqty\b/.test(lower) || /sale|discount|clearance/.test(lower)) return false;
      // Remove add to cart, checkout, or shopping cart prompts
      if (/add to cart|add to wishlist|add to compare|checkout|shopping cart|add to bag/.test(lower)) return false;
      // Remove insurance or eligibility notes
      if (/insurance|eligible/.test(lower)) return false;
      // Remove review/testimonial prompts or quoted testimonials
      if (/reviews?|review|write a review|customer reviews|testimonial/.test(lower)) return false;
      if (/\bi have recommended\b|\bi am able\b|\ball rights reserved\b|\bthank you\b|\bbased on\b/.test(lower)) return false;
      // Remove phone or fax numbers and contact info
      if (/phone|fax|tel|telephone|call us|contact us|\d{3}[\s.-]\d{3}[\s.-]\d{4}/.test(lower)) return false;
      // Remove covid or pandemic updates
      if (/covid|\b19 update\b/.test(lower)) return false;
      // Remove HCPCS codes or similar
      if (/hcpcs|hcpcs code/.test(lower)) return false;
      // Remove language-specific labels or duplicates (e.g., multiple translations)
      if (/\bsoporte de|embouts|dossier|puntas de la|silla inodoro|tres en uno|couvercle|trois-en-un/i.test(lower)) return false;
      // Remove lines containing quoted text (e.g., testimonials)
      if (/"|“|”/.test(text)) return false;
      // Remove headings or non-descriptive labels
      if (/^details$|^specifications$|^size & weight$|^accessories & components$|^features$|^what's in the box$|^features & benefits:?$/i.test(text)) return false;
      // Remove generic single-word labels (allow two-word feature titles like "Night Light")
      // Previously lines with fewer than three words were discarded, which removed
      // meaningful two-word feature names. Only drop lines containing a single word.
      if (text.split(/\s+/).length < 2) return false;
      // Remove part numbers (combination of letters and digits)
      if (/\b[A-Za-z]{2,}[\d]{2,}/.test(text)) return false;
      // Remove copyright, domain names, or company names
      if (/©|\bcom\b|\.com|all rights reserved/.test(lower)) return false;

      // Remove lines that duplicate specification details (e.g., 'Rechargeable: Portable with built-in battery.')
      if (/^(rechargeable|massage mode|display|adjustable suction|closed system|ultra-quiet|night light)[^:]*:/i.test(text)) return false;

      // Remove fragmented or multi-language feature lines that don't stand alone (e.g. 'with splash guard', 'Commode Pail only')
      if (/support.*soporte|puntas de la|dossier|leg tip|commode pail only|with splash guard/i.test(lower)) return false;
      // Remove lines starting with 'with ' that are too short (less than five words) and likely incomplete
      if (/^with\s+/i.test(lower) && text.split(/\s+/).length <= 5) return false;


      // Remove e‑commerce or promotional noise: stock status, quantity prompts, eligibility checks, reviews or accessories
      if (/\bin\s*stock\b/.test(lower)) return false;
      if (/add to cart|quantity|check if you'?re eligible|recommended by professionals|customer reviews|write a review|use & operation|parts & accessories|sold out|use and operation|customer review/i.test(lower)) return false;

      // Remove other storefront and account prompts or marketing copy that leaks into features/specs
      if (/shopping cart|wish list|compare|create an account|sign in|log in|checkout|vacuum suction up to|assembly|eligibility|hsa|simple store|replacement bags|covid|19 update/i.test(lower)) return false;

      // Remove headings or labels that are not product features, such as "weight capacity:" or "commode pail"
      if (/^weight\s+capacity:?$/i.test(lower)) return false;
      if (/^commode\s+pail$/i.test(lower)) return false;
      // Remove lines ending in 'only' with few words (likely incomplete)
      if (/only$/i.test(lower) && text.split(/\s+/).length <= 4) return false;
      // Remove spec-like lines that duplicate spec keys or values
      if (rec.specs && typeof rec.specs === 'object') {
        // Build a set of lowercase tokens from spec keys and values
        const specTokens = new Set();
        for (const [k, v] of Object.entries(rec.specs)) {
          specTokens.add(String(k).toLowerCase());
          if (typeof v === 'string') {
            for (const w of v.toLowerCase().split(/\s+/)) {
              specTokens.add(w);
            }
          }
        }
        const tokens = lower.split(/\s+/);
        if (tokens.every((t) => specTokens.has(t))) return false;
      }
      // Remove lines that look like headings or assembly/benefits labels
      if (/features\s*&?\s*benefits|assembly|very quiet|single pumping|dual pumping|s1 plus|check out faster/i.test(lower)) return false;
      // Remove lines consisting solely of spec keys (e.g. 'seidentopf binocular head', 'built-in mechanical stage with abbe na1.25 condenser &iris')
      if (/^(seidentopf|wf10x|built-in|4x,?\s*10x|vacuum suction up)/i.test(text)) return false;
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
      // Remove store pricing and special promotion keys (e.g. simple_store_replacement_bags, covid updates)
      if (/simple_store|covid/.test(lowerKey)) {
        delete rec.specs[key];
        continue;
      }

      // Remove unnatural spec keys that resemble sentences or have multiple underscores.
      // Heuristic: remove keys starting with 'the_' (e.g. 'the_most_advanced_hospital'),
      // or having more than two underscores, or containing generic descriptor words like
      // 'pump', 'modes', or 'grade'. Such keys are likely descriptive text rather than
      // actual specification names.
      const underscoreCount = (key.match(/_/g) || []).length;
      if (/^the_/i.test(key) || underscoreCount > 2 || /pump|modes|grade/.test(lowerKey)) {
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
