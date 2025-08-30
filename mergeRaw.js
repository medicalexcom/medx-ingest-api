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

      // Remove headings or instructions from user manuals that should not appear in feature lists.
      // Many scraped pages include manual lines like "Dealer: This manual must be given to the user",
      // "User: Before using this bed, read this manual and save for future reference", and similar.
      // Drop any line that starts with these generic labels or safety warnings.
      if (/^(dealer\s*:|user\s*:|warning|notice|special notes|save these instructions|important|safety summary)/i.test(lower)) return false;
      // Remove lines that instruct the reader to read the manual or caution about using the product.
      if (/(read\s+this\s+manual|before\s+using\s+this|before\s+attempting\s+to\s+use|before\s+attempting\s+to\s+operate)/i.test(lower)) return false;
      // Remove generic headings commonly found in manuals or product pages that do not describe the product itself.
      // Examples include "parts diagram", "technical resources", "download catalog", "accessories", "specification",
      // "specifications", "product specifications", "dimensions" and "features/benefits".  These headings often accompany
      // non‑feature content such as links or tables and should not be emitted as features.
      if (/(parts\s+diagram|technical\s+resources|technical\s+documents|technical\s+downloads|owners?\s+manual|owner's\s+manual|download\s+catalog|accessories\b|hcpcs\s+reimbursement|specification(s)?\b|product\s+specifications?|dimension(s)?\b|features\s*\/\s*benefits|features\s+and\s+benefits)/i.test(lower)) return false;
      // Remove lines that are entirely uppercase and contain more than two words.
      // Such lines are often section headings or navigation prompts rather than product features.
      if (/^[^a-z]*$/.test(text) && text.trim().split(/\s+/).length > 2) return false;

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
    // Encode spaces in PDF URLs so downstream fetchers can retrieve
    // documents with spaces in their filenames (e.g. "Product Information.pdf").
    rec.pdf_docs = rec.manuals.map(url => {
      if (typeof url !== 'string') return url;
      // Only replace literal spaces; avoid double‑encoding already encoded strings.
      return url.replace(/ /g, '%20');
    });
  }

  // If pdf_docs already exists, ensure spaces are encoded for consistency
  if (Array.isArray(rec.pdf_docs)) {
    rec.pdf_docs = rec.pdf_docs.map(url => {
      if (typeof url !== 'string') return url;
      return url.replace(/ /g, '%20');
    });
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
      // Filter out obvious instruction lines or warnings from manuals which are not
      // true product features.  Heuristics: exclude lines that include common
      // instructional words (e.g. "do not", "warning", "caution", "manual"),
      // or that are excessively long (over ~150 characters) or contain
      // newline characters.
      if (/do\s+not|warning|caution|manual|future\s+reference|pendant|control|allow\s+a\s+slight/.test(normalised)) {
        return false;
      }
      if (typeof item === 'string' && (item.length > 150 || /\n/.test(item))) {
        return false;
      }
      seen.add(normalised);
      return true;
    });

    // Combine fragmented feature lines back together and remove obvious non-feature
    // entries.  Many product pages break a single feature across multiple list
    // items (e.g. "Split-pan design with removable bed ends is easy", "to setup.").
    // Merge such fragments by appending lines that begin with lowercase letters
    // to the previous line when the previous line does not end in punctuation.
    if (Array.isArray(rec.features_raw)) {
      const merged = [];
      let current = '';
      for (const rawItem of rec.features_raw) {
        if (!rawItem || typeof rawItem !== 'string') continue;
        const trimmed = rawItem.trim();
        if (!trimmed) continue;
        if (current === '') {
          current = trimmed;
          continue;
        }
        // Append fragments that start with lowercase letters when the current
        // line does not end with punctuation, or when the fragment begins
        // with a conjunction or preposition (e.g. "and", "as", "to", "for").
        const isLowerStart = /^[a-z].*/.test(trimmed);
        const isContinuation = /^(and|as|to|for|with|in|on)\b/.test(trimmed);
        if ((!/[.!?]$/.test(current.trim()) && isLowerStart) || isContinuation) {
          current = `${current} ${trimmed}`;
        } else {
          merged.push(current);
          current = trimmed;
        }
      }
      if (current) merged.push(current);
      // Remove entries that look like specification labels or key/value pairs.
      rec.features_raw = merged.filter(item => {
        const text = item.trim().toLowerCase();
        // Exclude spec-like items such as dimensions or warranty statements.
        if (/^(bed height|sleep surface|weight capacity|max patient weight|assembled bed|assembled bed weight|limited warranty)/i.test(text)) return false;
        // Exclude items containing a colon (these are likely spec key/value pairs).
        if (item.includes(':')) return false;
        return true;
      });
    }
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

  // Populate specs from feature lines when no specs were extracted.  Some sites
  // embed technical specifications within the bullet list rather than in a
  // dedicated table.  When the `specs` object is empty, attempt to parse
  // colon-separated or measurement lines from the features and move them
  // into the specs map.
  if (rec.specs && typeof rec.specs === 'object' && Object.keys(rec.specs).length === 0 && Array.isArray(rec.features_raw)) {
    const extractedSpecs = {};
    const remaining = [];
    for (const item of rec.features_raw) {
      const line = (item || '').trim();
      let matched = false;
      // Match patterns like "Key: Value" or "Key – Value" (colon or en dash). Only
      // treat it as a specification if the value contains digits or known
      // measurement units. This helps avoid capturing feature sentences that
      // happen to contain a colon (e.g. marketing taglines).
      let m = line.match(/^([^:–]+):\s*(.+)$/);
      if (m) {
        const keyRaw = m[1].trim();
        const value = m[2].trim();
        const valLower = value.toLowerCase();
        if (keyRaw && value && (/[0-9]/.test(value) || /(lb|lbs|kg|g|oz|ft|in|cm|mm|inch|inches|year|warranty|pcs|pieces)/i.test(valLower))) {
          const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
          extractedSpecs[key] = value;
          matched = true;
        }
      } else {
        // Match patterns like "Key - Value" only when the hyphen has spaces on both sides.
        m = line.match(/^(.+?)\s+-\s+(.+)$/);
        if (m) {
          const keyRaw = m[1].trim();
          const value = m[2].trim();
          const valLower = value.toLowerCase();
          if (keyRaw && value && (/[0-9]/.test(value) || /(lb|lbs|kg|g|oz|ft|in|cm|mm|inch|inches|year|warranty|pcs|pieces)/i.test(valLower))) {
            const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
            extractedSpecs[key] = value;
            matched = true;
          }
        } else {
          // Match patterns like "Total weight capacity 700 lbs" or similar.  Only
          // parse lines with numbers and measurement units to avoid capturing
          // descriptive sentences.
          const m2 = line.match(/^(.*?)(?:\s+)(\d+\s*(?:lb|lbs|kg|g|oz|ft|in|cm|mm|"|inch|inches)\b.*)$/i);
          if (m2) {
            const keyRaw = m2[1].trim();
            const value = m2[2].trim();
            if (keyRaw && value) {
              const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
              extractedSpecs[key] = value;
              matched = true;
            }
          }
        }
      }
      if (!matched) remaining.push(item);
    }
    if (Object.keys(extractedSpecs).length > 0) {
      rec.specs = { ...extractedSpecs };
      rec.features_raw = remaining;
    }
  }

  // ---------------------------------------------------------------------------
  // Sanitize the browser's visible_text property.  Some scraped pages leak
  // navigation menus or category lists into `_browse.visible_text`, which makes
  // it unreadable and irrelevant for GPT.  Detect obviously noisy visible text
  // and replace it with a human‑readable fallback (typically the product
  // description) without altering any other fields.  This logic triggers only
  // when the visible text is very long, contains many newline‑separated lines,
  // and does not appear to mention the product's name.  Otherwise, the
  // original visible_text is preserved.
  if (rec._browse && typeof rec._browse.visible_text === 'string') {
    const vt = rec._browse.visible_text.trim();
    // Count newline‑separated lines; noisy category lists often have dozens
    // of single‑word lines.
    const lines = vt.split(/\n+/);
    // Extract salient words from the product name (words longer than 3 chars)
    const nameWords = Array.isArray(rec.name_raw ? rec.name_raw.split(/\s+/) : [])
      ? rec.name_raw.split(/\s+/).filter(w => w.length > 3).map(w => w.toLowerCase())
      : [];
    const lowerVt = vt.toLowerCase();
    const containsName = nameWords.some(w => lowerVt.includes(w));
    // Compute punctuation and name mention ratios to detect navigation menus or
    // category lists.  These lists typically have many lines, very few
    // punctuation marks, and rarely mention the product name.
    const punctuationLines = lines.filter(l => /[.,;:!?]/.test(l));
    const punctuationRatio = lines.length > 0 ? (punctuationLines.length / lines.length) : 0;
    const nameMentionLinesCount = lines.filter(l => nameWords.some(w => l.toLowerCase().includes(w))).length;
    const nameMentionRatio = lines.length > 0 ? (nameMentionLinesCount / lines.length) : 0;
    const looksLikeMenu = lines.length > 10 && punctuationRatio < 0.15 && nameMentionRatio < 0.2;
    // If the visible text looks like a long list of categories or navigation links,
    // or if there are more than 30 lines and none of the product name words
    // appear, treat it as noise and fall back to a known description.
    if ((lines.length > 30 && !containsName) || looksLikeMenu) {
      // Prefer description_raw for the fallback; otherwise use the cleaned
      // description from sections or leave empty.  Do not remove the existing
      // description or other fields.
      let fallback = '';
      if (rec.description_raw && typeof rec.description_raw === 'string') {
        fallback = rec.description_raw.trim();
      } else if (rec.description_md && typeof rec.description_md === 'string') {
        fallback = rec.description_md.trim();
      } else if (rec.sections && typeof rec.sections.description === 'string') {
        fallback = rec.sections.description.trim();
      }
      // Only set visible_text if a fallback is available.  If no fallback is
      // present, leave the existing visible_text unchanged.
      if (fallback) {
        rec._browse.visible_text = fallback;
      }
    }
  }

  return rec;
}

// Export removeNoise for use in other modules (e.g., server.js)
export { removeNoise };
