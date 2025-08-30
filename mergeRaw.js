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
      // Do not remove lines mentioning insurance or eligibility, as they may
      // be important features (e.g. HSA eligibility).  Preserve them.
      // Remove review/testimonial prompts or quoted testimonials
      if (/reviews?|review|write a review|customer reviews|testimonial/.test(lower)) return false;
      // Remove common testimonial phrases (e.g. "I have recommended", "I am able", "Thank you", etc.).  Also drop
      // specific sentences like "While I wish my insurance" which are testimonials rather than features.
      if (/\bi have recommended\b|\bi am able\b|\ball rights reserved\b|\bthank you\b|\bbased on\b|\bi wish my insurance\b/.test(lower)) return false;
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
      // Preserve section headings such as "details", "specifications", "size & weight", etc.
      // These headings may be followed by content and should not be removed.
      // Similarly, do not remove single-word labels; keep them intact so they can
      // accompany their content in downstream processing.
      // Remove part numbers (combination of letters and digits) only if they do not
      // match the product SKU or model.  Keep the main product SKU in features.
      if (/\b[A-Za-z]{2,}[\d]{2,}/.test(text)) {
        const sku = rec.sku ? String(rec.sku).toLowerCase() : '';
        const model = rec.specs && rec.specs.model ? String(rec.specs.model).toLowerCase() : '';
        if (lower === sku || lower === model) {
          // keep
        } else {
          return false;
        }
      }
      // Remove copyright, domain names, or company names
      if (/©|\bcom\b|\.com|all rights reserved/.test(lower)) return false;

      // Remove lines that duplicate specification details (e.g., 'Rechargeable: Portable with built-in battery.')
      if (/^(rechargeable|massage mode|display|adjustable suction|closed system|ultra-quiet|night light)[^:]*:/i.test(text)) return false;

      // Preserve fragmented or add-on lines.  Do not remove lines starting with
      // "with" or lines like "commode pail only"; these may be part of a valid
      // description.


      // Remove e‑commerce or promotional noise: stock status, quantity prompts, eligibility checks, reviews or accessories
      if (/\bin\s*stock\b/.test(lower)) return false;
      if (/add to cart|quantity|check if you'?re eligible|recommended by professionals|customer reviews|write a review|use & operation|parts & accessories|sold out|use and operation|customer review/i.test(lower)) return false;

      // Remove other storefront and account prompts or marketing copy that leaks into features/specs.
      // Keep descriptive phrases like "vacuum suction up to" as part of the feature set.
      if (/shopping cart|wish list|compare|create an account|sign in|log in|checkout|assembly|eligibility|hsa|simple store|replacement bags|covid|19 update/i.test(lower)) return false;

      // Remove additional storefront navigation, account prompts and other e‑commerce noise.
      // These phrases commonly leak into scraped feature lists from page chrome (menus,
      // account controls, legal footers, etc.). They do not describe the product itself.
      if (/add to favorites|favorites? list|error occurred|product is already in the cart|view product options|close product options|sign in to view price|quantity|share this|stock status|item #|upc #|my account|order status|cancellations & returns|terms & conditions|privacy policy|contact us|homecare providers|long term care professionals|healthcare professionals|government professionals|retailers|who we serve|who we are|account|cart|checkout|login|log in|logout|register|create account|locate providers|faqs|press releases|articles & blogs|blog|submit a product idea|patents|support & resources|support & services|knowledge base|bath safety|beds|commodes|mobility|patient room|personal care|respiratory|sleep therapy|therapeutic support surfaces|new arrivals|support and resources|support and services|knowledge base|parts diagram|owners manual|owner's manual|download catalog page|download pdf|pdf|sds|stock photos|view all accessories|view less accessories|view all products|back to products|add up to|frequently viewed|compare products?/i.test(lower)) return false;

      // Remove lines that contain multiple language/country selectors or international site indicators.
      // These appear in navigation footers and are not relevant to product details.
      if (/us\s+en|canada\s*-\s*english|canada\s*-\s*french|uk\s*-\s*english|germany\s*-\s*deutsch|france\s*-\s*french|drive\s+devilbiss|international|specialised orthotic services/i.test(lower)) return false;

      // Preserve headings like "weight capacity" and "commode pail"; these belong in the
      // specifications or description sections and should not be removed.
      // Do not drop lines that end with "only"; these may legitimately describe
      // a component (e.g., "Commode Pail Only").
      // Do not drop lines simply because all of their tokens match spec keys or values.
      // Some features may duplicate spec terms and should still be kept.
      // Remove only obvious e‑commerce phrases like "check out faster".  Keep
      // other labels (e.g. "features & benefits", "assembly", "very quiet", etc.)
      if (/check out faster/i.test(lower)) return false;
      // Do not drop lines that start with model identifiers or technical descriptors
      // like "Seidentopf", "WF10X", "Built-in", "4x, 10x", or "Vacuum suction up". These
      // belong in the specification or description.

      // Remove specific stray labels or fragments that are not useful as features, particularly
      // for the ProBasics commode product.  These include generic headings duplicated from
      // diagrams or multilingual PDFs.
      if (/^three-in-one$|^commode$|^weight capacity:?$|^backrest support/i.test(lower)) return false;
      if (/^respaldo$|^soporte de|^commode pail$|^with splash guard$|^commode pail only$/i.test(lower)) return false;

      // Remove generic tab headings from microscope product feature lists (these belong in sections)
      if (/^details$|^specifications$|^accessories\s*&\s*components$|^size\s*&\s*weight$/i.test(lower)) return false;
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

  // Deduplicate feature lists to prevent duplicate bullets leaking into
  // downstream content. Some sites repeat the same feature text multiple
  // times (e.g. in summary and feature sections). We normalise by
  // trimming and comparing lower‑cased strings and then filter the
  // arrays in place. Do this for both the raw and cleaned feature lists
  // when present on the record.
  if (Array.isArray(rec.features_raw)) {
    const seen = new Set();
    rec.features_raw = rec.features_raw.filter(item => {
      const normalised = typeof item === 'string' ? item.trim().toLowerCase() : '';
      if (normalised === '') return false;
      if (seen.has(normalised)) return false;
      seen.add(normalised);
      return true;
    });
  }
  if (Array.isArray(rec.features)) {
    const seen = new Set();
    rec.features = rec.features.filter(item => {
      const normalised = typeof item === 'string' ? item.trim().toLowerCase() : '';
      if (normalised === '') return false;
      if (seen.has(normalised)) return false;
      seen.add(normalised);
      return true;
    });
  }

  return rec;
}

// Export removeNoise for use in other modules (e.g., server.js)
export { removeNoise };
