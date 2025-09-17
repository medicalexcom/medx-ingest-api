// Removed cleanProductRecord import – send full merged object directly to GPT

// Import all exports from the Salesforce harvester module. We avoid
// destructuring a specific named export here because the runtime
// environment may not provide that export. Using a wildcard import
// prevents module resolution errors if the named helper is absent.
import * as salesforceHelper from './harvesters/salesforce.js';

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
      // Remove lines that are entirely uppercase only when they are very long (e.g., eight or more words).
      // Short uppercase headings such as "SAFETY AND WARNINGS" or "BINOCULAR ZOOM STEREO" should be preserved.
      if (/^[^a-z]*$/.test(text) && text.trim().split(/\s+/).length > 7) return false;

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
      // Filter out generic cart/quantity/review prompts, but keep "use & operation" and
      // "use and operation" since they may relate to legitimate product information.
      if (/add to cart|quantity|check if you'?re eligible|recommended by professionals|customer reviews|write a review|parts & accessories|sold out|customer review/i.test(lower)) return false;

      // Remove other storefront and account prompts or marketing copy that leaks into features/specs.
      // Keep descriptive phrases like "vacuum suction up to" as part of the feature set.
      if (/shopping cart|wish list|compare|create an account|sign in|log in|checkout|assembly|eligibility|hsa|simple store|replacement bags|covid|19 update/i.test(lower)) return false;

      // Remove additional storefront navigation, account prompts and other e‑commerce noise.
      // These phrases commonly leak into scraped feature lists from page chrome (menus,
      // account controls, legal footers, etc.). They do not describe the product itself.
      if (/add to favorites|favorites? list|error occurred|product is already in the cart|view product options|sign in to view price|quantity|share this|stock status|item #|upc #|my account|order status|cancellations & returns|terms & conditions|privacy policy|contact us|homecare providers|long term care professionals|healthcare professionals|government professionals|retailers|who we serve|who we are|account|cart|checkout|login|log in|logout|register|create account|locate providers|faqs|press releases|articles & blogs|blog|submit a product idea|patents|support & resources|support & services|knowledge base|bath safety|beds|commodes|mobility|patient room|personal care|respiratory|sleep therapy|therapeutic support surfaces|new arrivals|support and resources|support and services|knowledge base|parts diagram|owners manual|owner's manual|download catalog page|download pdf|pdf|sds|stock photos|view all accessories|view less accessories|view all products|back to products|add up to|frequently viewed|compare products?|view product options|expand product parts|close product parts|view all accessories|view less accessories|sign in to view price|limited shipping options|similar likeproducts|log in to order|sign in to see pricing|log in to order|stock|select quantity/i.test(lower)) return false;

      // Filter out navigation categories and corporate menu headings that often appear in
      // page footers or sidebars.  These include generic product or service categories
      // (e.g. inventory management, distribution, lab management, clinical & equipment
      // setup, training and compliance, patient care, remote monitoring, financial
      // services, analytics & reporting, ecommerce services and the like).  Removing
      // these avoids polluting the feature set with navigation text.
      if (/inventory management|vaccine management|biomedical equipment solutions|instrument management services|technology consultants|distribution|medical waste management|drug disposal and returns|patient home delivery|medical freight management|lab management|lab consulting|lab information systems|lab results|clinical and equipment setup|training and compliance|patient care and engagement|remote patient monitoring|financial services|revenue cycle management|invoice management|capital medical equipment|real estate solutions|analytics & reporting|analytics and reporting|ecommerce services|lab consulting|clinical and equipment|workforce training|bath benches|bath lifts|bathing systems|bathroom safety accessories|bathtub safety rails|grab bars|hand held shower sprays|raised toilet seats|shower bathtub mats|toilet safety|transfer benches|bariatric beds|bed rails|homecare beds|long term care beds|drop arm|specialty|standard accessories|walkers|wheelchairs|blood pressure|breast pumps|fitness & recovery|pain management|pulse oximeters|aerosol therapy|oxygen therapy|suction therapy|masks|sleep accessories|mattress overlay|mattress replacement|bariatrics|new arrivals|contact us|articles & blogs|press releases|patents|about us|leadership|work with us|who we serve|homecare providers|long term care professionals|healthcare professionals|government professionals|retailers|my account|order status|cancellations & returns|contact us|submit a product idea|faqs|support & resources|support & services|knowledge base/i.test(lower)) return false;

      // Remove lines that include HTML fragments or escaped tags (e.g. \u003cdiv).
      if (/\\u003c|<\/?(div|img|a|input|span|button|video|source|script|table|ul|li|footer|header|nav|form)/i.test(text)) return false;

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
      // Remove store pricing and special promotion keys (e.g. simple_store_replacement_bags, covid updates)
      if (/simple_store|covid/.test(lowerKey)) {
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

  // Clean up description_raw by stripping obvious navigation menu content and
  // marketing call‑outs that sometimes leak into the description from the
  // scraped page.  Some ecommerce sites embed large navigation lists (e.g.
  // "Inventory Management", "Patient Care and Engagement", etc.) or call
  // to action banners (e.g. "COVID‑19 vaccines are available", "Flu Season
  // is coming! PRE‑BOOK") directly into the product description block.
  // These are not part of the product description and should be removed.
  // Only perform this cleaning when description_raw is a string.  We make
  // sure to avoid removing legitimate phrases such as "use & operation",
  // "use and operation", or "close product options", as requested by
  // downstream consumers.
  if (typeof rec.description_raw === 'string' && rec.description_raw.trim()) {
    let desc = rec.description_raw;
    // Define a set of keyword phrases that indicate navigation or promotional
    // content.  The patterns are matched case‑insensitively and will
    // remove entire lines containing them.
    const navKeywords = [
      'inventory management',
      'vaccine management',
      'biomedical equipment solutions',
      'instrument management services',
      'technology consultants',
      'distribution',
      'medical waste management',
      'drug disposal',
      'patient home delivery',
      'medical freight management',
      'lab management',
      'lab consulting',
      'lab information systems',
      'lab results',
      'clinical and equipment setup',
      'training and compliance',
      'patient care and engagement',
      'remote patient monitoring',
      'financial services',
      'revenue cycle management',
      'invoice management',
      'capital medical equipment',
      'real estate solutions',
      'analytics & reporting',
      'analytics and reporting',
      'ecommerce services',
      'covid\\-19 vaccines',
      'flu season is coming',
      'order now',
      'pre\\-book',
      'view all accessories',
      'view less accessories',
      'share this:'
    ];
    // Split the description into lines to enable granular filtering.  We
    // deliberately preserve newlines so that rejoining lines maintains
    // reasonable formatting.
    const lines = desc.split(/\r?\n/);
    const filteredLines = [];
    outer: for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      // Preserve lines with certain phrases explicitly requested by the user
      // (e.g. "use & operation", "use and operation", "close product options").
      if (/use\s*&\s*operation/i.test(trimmed) || /use\s+and\s+operation/i.test(trimmed) || /close\s+product\s+options/i.test(trimmed)) {
        filteredLines.push(line);
        continue;
      }
      // Count the number of navigation keywords present in this line.  If
      // two or more keywords are present, treat the line as navigation or
      // promotional content and skip it entirely.  This approach avoids
      // removing lines that merely mention a single keyword in passing but
      // aggressively removes long blocks of category listings.
      let navMatchCount = 0;
      for (const kw of navKeywords) {
        if (lower.includes(kw)) {
          navMatchCount++;
        }
      }
      if (navMatchCount >= 2) {
        continue outer;
      }
      // As a fallback, remove lines that exactly match a single nav keyword.
      for (const kw of navKeywords) {
        const exact = kw.trim().toLowerCase();
        if (lower === exact) {
          continue outer;
        }
      }
      filteredLines.push(line);
    }
    desc = filteredLines.join('\n');
    // Collapse multiple blank lines into a single blank line and trim.
    desc = desc.replace(/\n{3,}/g, '\n\n').trim();
    rec.description_raw = desc;
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

      // ---------------------------------------------------------------------------
      // Additional enrichment and provenance tracking
      //
      // After the existing noise removal and deduplication logic, extract and
      // normalise feature/spec sections from the Playwright browse results,
      // categorise feature sentences, perform fuzzy deduplication across
      // sources, isolate HTML/structured features/specs, and compute a
      // simple quality score.  These enhancements preserve source provenance
      // while maintaining backwards‑compatible top‑level fields.

      // 1. Extract features and specs from the dynamic browse sections.
      if (rec._browse && rec._browse.sections && typeof rec._browse.sections === 'object') {
        const sections = rec._browse.sections;
        // Gather feature text from the 'features' and 'included' sections.  These
        // sections may be arrays of strings or a single string; split on
        // newlines to normalise.  Store the result in rec.features_browse.
        let featuresBrowseList = [];
        // specsFromTabs will hold specification key/value pairs extracted from dynamic tab panels.
        // It is defined here so it can be merged into rec.specs and rec.specs_browse after
        // parsing the specifications section.
        let specsFromTabs = {};
        const featureSources = ['features', 'included'];
        for (const key of featureSources) {
          const raw = sections[key];
          if (!raw) continue;
          if (Array.isArray(raw)) {
            for (const item of raw) {
              if (typeof item === 'string') {
                featuresBrowseList.push(...item.split(/\n+/));
              }
            }
          } else if (typeof raw === 'string') {
            featuresBrowseList.push(...raw.split(/\n+/));
          }
        }
        // Extract additional features and specs from Salesforce Lightning or other dynamic tabs
        // via the helper. Append any found features to featuresBrowseList and save specs.
        if (sections.tabs) {
          const helperFn = salesforceHelper.extractFeaturesAndSpecsFromBrowseTabs;
          const { features: tabFeatures = [], specs: tabSpecs = {} } =
            typeof helperFn === 'function' ? helperFn(sections.tabs) : { features: [], specs: {} };
          if (Array.isArray(tabFeatures) && tabFeatures.length) {
            featuresBrowseList.push(...tabFeatures);
          }
          specsFromTabs = tabSpecs;
        }
        featuresBrowseList = featuresBrowseList
          .map(s => String(s).trim())
          .filter(s => s.length > 0);
        // Assign to rec.features_browse after deduplication.  Do not remove
        // from rec.features_raw; the top‑level list should continue to
        // aggregate all features for backwards compatibility.
        if (featuresBrowseList.length) {
          const dedupedBrowse = deduplicateSimilarLines(featuresBrowseList);
          rec.features_browse = dedupedBrowse;
          // Push unique browse lines into features_raw if they are not already
          // present.  Maintain a set for quick lookups.
          const seen = new Set(Array.isArray(rec.features_raw) ? rec.features_raw.map(v => String(v).toLowerCase()) : []);
          for (const line of dedupedBrowse) {
            const norm = String(line).toLowerCase();
            if (!seen.has(norm)) {
              (rec.features_raw ||= []).push(line);
              seen.add(norm);
            }
          }
        }
        // Gather specifications from the 'specifications' section.  It may be an
        // array of strings or a single string containing multiple lines.  Parse
        // each line into key/value pairs using parseSpecLine.  Store them in
        // rec.specs_browse and also merge into rec.specs when the key is
        // absent.  Keys are normalised to lowercase with underscores.
        let specsBrowse = {};
        const specsRaw = sections.specifications;
        if (specsRaw) {
          let specLines = [];
          if (Array.isArray(specsRaw)) {
            for (const item of specsRaw) {
              if (typeof item === 'string') {
                specLines.push(...item.split(/\n+/));
              }
            }
          } else if (typeof specsRaw === 'string') {
            specLines = specsRaw.split(/\n+/);
          }
          for (const line of specLines) {
            const [key, value] = parseSpecLine(line);
            if (key && value) {
              specsBrowse[key] = value;
            }
          }
        }
        if (Object.keys(specsBrowse).length) {
          rec.specs_browse = specsBrowse;
          // Merge browse specs into unified specs without overwriting existing
          // keys.  rec.specs is expected to be an object.
          rec.specs = rec.specs && typeof rec.specs === 'object' ? rec.specs : {};
          for (const [k, v] of Object.entries(specsBrowse)) {
            if (!(k in rec.specs)) {
              rec.specs[k] = v;
            }
          }
        }

        // Merge any specifications derived from dynamic tabs into the browse specs and the unified specs.
        if (specsFromTabs && typeof specsFromTabs === 'object' && Object.keys(specsFromTabs).length) {
          rec.specs_browse = rec.specs_browse && typeof rec.specs_browse === 'object' ? rec.specs_browse : {};
          for (const [k, v] of Object.entries(specsFromTabs)) {
            if (!rec.specs_browse[k]) {
              rec.specs_browse[k] = v;
            }
            rec.specs = rec.specs && typeof rec.specs === 'object' ? rec.specs : {};
            if (!(k in rec.specs)) {
              rec.specs[k] = v;
            }
          }
        }
      }

      // 2. Ensure per-source arrays for PDF and structured data exist.  These
      // arrays may have been populated earlier by pdfEnrichment or other
      // modules.  Normalise undefined values to empty arrays.
      rec.features_pdf = Array.isArray(rec.features_pdf) ? rec.features_pdf : [];
      rec.specs_pdf = Array.isArray(rec.specs_pdf) ? rec.specs_pdf : [];
      rec.features_structured = Array.isArray(rec.features) ? [...rec.features] : [];
      // Compute specs_structured by subtracting keys that appear in specs_pdf and specs_browse.
      const pdfSpecKeys = new Set(rec.specs_pdf.map(obj => obj.key));
      const browseSpecKeys = rec.specs_browse ? new Set(Object.keys(rec.specs_browse)) : new Set();
      rec.specs_structured = {};
      if (rec.specs && typeof rec.specs === 'object') {
        for (const [k, v] of Object.entries(rec.specs)) {
          if (!pdfSpecKeys.has(k) && !browseSpecKeys.has(k)) {
            rec.specs_structured[k] = v;
          }
        }
      }

      // 3. Derive HTML features by subtracting PDF, browse and structured
      // features from the aggregate features_raw.  Use lowercase normalised
      // strings for set membership tests.  Keep ordering consistent with
      // features_raw.
      const pdfFeaturesSet = new Set(rec.features_pdf.map(f => String(f).toLowerCase()));
      const browseFeaturesSet = new Set(Array.isArray(rec.features_browse) ? rec.features_browse.map(f => String(f).toLowerCase()) : []);
      const structuredFeaturesSet = new Set(rec.features_structured.map(f => String(f).toLowerCase()));
      rec.features_html = [];
      if (Array.isArray(rec.features_raw)) {
        for (const feat of rec.features_raw) {
          const lower = String(feat).toLowerCase();
          if (!pdfFeaturesSet.has(lower) && !browseFeaturesSet.has(lower) && !structuredFeaturesSet.has(lower)) {
            rec.features_html.push(feat);
          }
        }
      }

      // 4. Fuzzy deduplication across all feature lists.  Use a high threshold
      // to collapse near-duplicate phrases without losing genuinely distinct
      // features.  Perform deduplication separately on each source list and
      // update the aggregate features_raw accordingly.
      rec.features_pdf = deduplicateSimilarLines(rec.features_pdf, 0.8);
      rec.features_browse = Array.isArray(rec.features_browse) ? deduplicateSimilarLines(rec.features_browse, 0.8) : rec.features_browse;
      rec.features_structured = deduplicateSimilarLines(rec.features_structured, 0.8);
      rec.features_html = deduplicateSimilarLines(rec.features_html, 0.8);
      // Rebuild features_raw as the union of per-source lists, preserving order.
      const combinedSeen = new Set();
      const combined = [];
      for (const list of [rec.features_structured, rec.features_pdf, rec.features_browse, rec.features_html]) {
        if (!Array.isArray(list)) continue;
        for (const line of list) {
          const norm = String(line).toLowerCase();
          if (!combinedSeen.has(norm)) {
            combined.push(line);
            combinedSeen.add(norm);
          }
        }
      }
      rec.features_raw = combined;

      // 5. Filter out non‑English lines using a simple heuristic.  Iterate
      // through features_raw and keep only lines that appear to be English.
      rec.features_raw = rec.features_raw.filter(item => isEnglishLine(String(item)));
      rec.features_pdf = rec.features_pdf.filter(item => isEnglishLine(String(item)));
      rec.features_browse = Array.isArray(rec.features_browse) ? rec.features_browse.filter(item => isEnglishLine(String(item))) : rec.features_browse;
      rec.features_structured = rec.features_structured.filter(item => isEnglishLine(String(item)));
      rec.features_html = rec.features_html.filter(item => isEnglishLine(String(item)));

      // 6. Categorise feature sentences into features, benefits and included
      // items.  Use classifySentence to assign each line to a category and
      // accumulate into an object keyed by category.  Consumers may use
      // these categories to generate more targeted copy.
      const categories = { feature: [], benefit: [], included: [] };
      for (const line of rec.features_raw) {
        const cat = classifySentence(String(line));
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(line);
      }
      rec.features_by_category = categories;

      // 7. Compute a quality score based on the number of features and
      // specifications present and whether PDF manuals were available.  The
      // resulting score ranges from 0 to 1.  Flag records with low scores
      // for manual review.
      const score = computeQualityScore(rec);
      rec.quality_score = score;
      rec.needs_review = score < 0.7;

      // -----------------------------------------------------------------------
      // McKesson-specific hardening and canonicalisation (non-destructive).
      // Adds: tabs_clean, specs_canonical, name_sanitized, features_sanitized,
      // image_urls, documents (SDS), latex_free boolean. Original fields remain.
      try {
        const domain = domainFromSource(rec);
        if (domain && /(^|\.)mms\.mckesson\.com$/i.test(domain)) {
          // 1) Clean tabs without touching original `tabs`
          if (Array.isArray(rec.tabs)) {
            rec.tabs_clean = rec.tabs.filter(t => !isJunkTab(t));
          }

          // 2) Build canonical specs from existing specs + browse/spec sections
          const baseSpecs = Object.assign({}, rec.specs || {});
          // If _browse.sections.specifications exists, merge in (do not overwrite)
          if (rec._browse && rec._browse.sections && rec._browse.sections.specifications) {
            const s = rec._browse.sections.specifications;
            if (typeof s === 'string') {
              s.split(/\n+/).forEach(line => {
                const [k, v] = parseSpecLine(line);
                if (k && v && !(k in baseSpecs)) baseSpecs[k] = v;
              });
            }
          }
          const specsCanonical = normalizeSpecsToSpecMap(baseSpecs);
          if (Object.keys(specsCanonical).length) {
            rec.specs_canonical = specsCanonical;
          }

          // 3) Features sanitization (use current features_raw if available,
          // otherwise fall back to _browse.features_md or features_html)
          const featureCandidates = []
            .concat(Array.isArray(rec.features_raw) ? rec.features_raw : [])
            .concat(Array.isArray(rec.features_browse) ? rec.features_browse : [])
            .concat(Array.isArray(rec.features_html) ? rec.features_html : []);
          const featuresSanitized = deduplicateSimilarLines(
            featureCandidates
              .map(s => String(s).trim())
              .filter(Boolean)
              // only keep short, product-focused bullets
              .filter(s => s.length <= 140 && !/[.:]$/.test(s.replace(/\s+/g, ' ').trim().slice(-1)))
              .map(s => s.replace(/\s+/g, ' '))
          , 0.85);
          if (featuresSanitized.length) {
            rec.features_sanitized = featuresSanitized;
          }

          // 4) SDS document extraction (without parsing PDF body)
          const sdsUrl = getSdsUrlFromRecord(rec);
          if (sdsUrl) {
            const docItem = { type: 'SDS', url: sdsUrl };
            // Add non-destructively
            if (!Array.isArray(rec.documents)) rec.documents = [];
            const exists = rec.documents.some(d => d && d.url === sdsUrl);
            if (!exists) rec.documents.push(docItem);
          }

          // 5) Image URLs convenience lift (top-level list of URLs)
          if (!Array.isArray(rec.image_urls)) {
            const imgs = Array.isArray(rec.images) ? rec.images : [];
            const lifted = imgs.map(i => (i && i.url) ? String(i.url) : null).filter(Boolean);
            if (lifted.length) rec.image_urls = lifted;
          }

          // 6) Description cleanup aimed at menu/promo bleed
          if (typeof rec.description_raw === 'string') {
            const cleaned = cleanMcKessonDescription(rec.description_raw);
            if (cleaned && cleaned !== rec.description_raw) {
              rec.description_clean = cleaned; // keep original; add a clean variant
            }
          }

          // 7) Build a clean, e‑commerce‑ready name without overwriting originals
          const nameSan = buildSanitizedName(specsCanonical, rec);
          if (nameSan) rec.name_sanitized = nameSan;

          // 8) Convenience booleans
          if (typeof specsCanonical.latex_free === 'boolean') {
            rec.latex_free = specsCanonical.latex_free;
          }
        }
      } catch (_e) {
        // Never throw from removeNoise; ignore domain-specific errors silently.
      }

      return rec;
}

// Export removeNoise for use in other modules (e.g., server.js)
export { removeNoise };

/* --------------------------------------------------------------------------
 * Helper functions for advanced deduplication, language detection,
 * specification parsing, sentence classification and quality scoring.
 * These functions are defined outside of removeNoise to keep the
 * implementation modular and reusable.  They are intentionally simple
 * heuristics; more sophisticated natural language processing could be
 * introduced in the future without breaking the API.
 */

// Tokenise a string into lowercase words, removing punctuation and extra
// whitespace.  Useful for similarity comparisons.
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Compute the Jaccard similarity between two strings.  The Jaccard
// coefficient measures the intersection over union of token sets.  Values
// range from 0 (no overlap) to 1 (identical sets).
function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersectionSize = [...setA].filter(x => setB.has(x)).length;
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// Remove near-duplicate lines from an array of strings.  Two strings are
// considered duplicates when their Jaccard similarity meets or exceeds
// the provided threshold (default 0.8).  The first occurrence is kept.
function deduplicateSimilarLines(lines, threshold = 0.8) {
  const out = [];
  for (const line of lines || []) {
    let duplicate = false;
    for (const existing of out) {
      if (jaccardSimilarity(line, existing) >= threshold) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.push(line);
  }
  return out;
}

// Parse a specification line into a [key, value] pair.  Recognises
// patterns like "Key: Value", "Key – Value" (with an en dash), or
// measurements such as "Total weight capacity 700 lbs".  Returns
// [null, null] if no plausible spec is found.
function parseSpecLine(line) {
  const text = String(line || '').trim();
  if (!text) return [null, null];
  // Colon or en dash separated key/value
  let m = text.match(/^([^:–]+):\s*(.+)$/);
  if (m) {
    const keyRaw = m[1].trim();
    const value = m[2].trim();
    const valLower = value.toLowerCase();
    if (keyRaw && value && (/[0-9]/.test(value) || /(lb|lbs|kg|g|oz|ft|in|cm|mm|inch|inches|year|warranty|pcs|pieces)/i.test(valLower))) {
      const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
      return [key, value];
    }
  }
  // Hyphen separated key/value (with spaces around the hyphen)
  m = text.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) {
    const keyRaw = m[1].trim();
    const value = m[2].trim();
    const valLower = value.toLowerCase();
    if (keyRaw && value && (/[0-9]/.test(value) || /(lb|lbs|kg|g|oz|ft|in|cm|mm|inch|inches|year|warranty|pcs|pieces)/i.test(valLower))) {
      const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
      return [key, value];
    }
  }
  // Measurement pattern without colon/hyphen (e.g. "Total weight capacity 700 lbs")
  const m2 = text.match(/^(.*?)(?:\s+)(\d+\s*(?:lb|lbs|kg|g|oz|ft|in|cm|mm|"|inch|inches)\b.*)$/i);
  if (m2) {
    const keyRaw = m2[1].trim();
    const value = m2[2].trim();
    if (keyRaw && value) {
      const key = keyRaw.replace(/\s+/g, '_').toLowerCase();
      return [key, value];
    }
  }
  return [null, null];
}

// Heuristic to detect whether a line appears to be English.  Counts the
// proportion of ASCII letters relative to the total number of characters
// (excluding whitespace) and ensures at least one common English stopword
// appears.  Lines failing these checks are treated as non‑English and
// filtered out.
function isEnglishLine(text) {
  const cleaned = String(text || '');
  const letters = cleaned.replace(/[^A-Za-z]/g, '').length;
  const total = cleaned.replace(/\s+/g, '').length;
  if (total === 0) return false;
  const ratio = letters / total;
  if (ratio < 0.6) return false;
  const lower = cleaned.toLowerCase();
  const stopwords = [' the ', ' and ', ' with ', ' for ', ' from ', ' of ', ' to ', ' an ', ' a ', ' in '];
  let hasStop = false;
  for (const w of stopwords) {
    if (lower.includes(w)) { hasStop = true; break; }
  }
  return hasStop;
}

// Simple rule‑based classifier to categorise a feature sentence as a
// 'feature', 'benefit' or 'included' item.  Looks for indicative
// keywords and falls back to 'feature' when ambiguous.
function classifySentence(text) {
  const s = String(text || '').toLowerCase();
  const includedKeywords = ['includes', 'comes with', 'in the box', 'kit includes', 'package includes', 'included'];
  for (const kw of includedKeywords) {
    if (s.includes(kw)) return 'included';
  }
  const benefitKeywords = ['ideal for', 'helps', 'benefit', 'provides', 'for use', 'designed to', 'allows you', 'great for', 'beneficial'];
  for (const kw of benefitKeywords) {
    if (s.includes(kw)) return 'benefit';
  }
  return 'feature';
}

// Compute a quality score for a record.  The score ranges from 0 to 1 and
// reflects the richness of the product description.  Points are awarded
// for having multiple features, multiple specification entries, and
// available PDF documents.  Additional points are given when PDF‑
// sourced features exist.  The weighting can be tuned empirically.
function computeQualityScore(rec) {
  let score = 0;
  // Base points for having at least a handful of features.  Consider features across
  // all sources (raw, browse and PDF) to avoid penalising pages where the
  // primary feature list has been deduplicated or cleaned.  Use the largest
  // feature count among these sources.
  const rawCount = Array.isArray(rec.features_raw) ? rec.features_raw.length : 0;
  const browseCount = Array.isArray(rec.features_browse) ? rec.features_browse.length : 0;
  const pdfCount = Array.isArray(rec.features_pdf) ? rec.features_pdf.length : 0;
  const featureCount = Math.max(rawCount, browseCount, pdfCount);
  if (featureCount >= 3) score += 0.4; else if (featureCount >= 1) score += 0.2;
  // Base points for having specification entries
  const specCount = rec.specs && typeof rec.specs === 'object' ? Object.keys(rec.specs).length : 0;
  if (specCount >= 3) score += 0.4; else if (specCount >= 1) score += 0.2;
  // Bonus for PDF documents available
  if (Array.isArray(rec.pdf_docs) && rec.pdf_docs.length > 0) score += 0.1;
  // Bonus for having at least one PDF‑sourced feature
  if (Array.isArray(rec.features_pdf) && rec.features_pdf.length > 0) score += 0.1;
  // Clamp score to [0, 1]
  if (score > 1) score = 1;
  return score;
}

/* --------------------------------------------------------------------------
 * McKesson‑specific sanitization helpers (added without altering existing logic)
 * Implements:
 *  - Scoped tab filtering (drops global Solutions/promo blocks)
 *  - Canonical spec mapping and normalization
 *  - Clean, compact description
 *  - SDS link extraction (documents[])
 *  - Clean product name builder and convenience booleans/arrays
 */

// Phrases/classes that indicate site chrome (not product content)
const DROP_PHRASES = [
  'Vaccine Management','Biomedical Equipment Solutions','Instrument Management Services',
  'Technology Consultants','Medical Waste Management','Drug Disposal and Returns',
  'Patient Home Delivery','Medical Freight Management','Lab Consulting','Lab Information Systems',
  'Lab Results','COVID-19 Vaccines are available','Flu Season is coming','ORDER NOW','PRE-BOOK'
];
const DROP_CLASS_HINTS = ['public-sub-menu','highlight-image','highlight-content'];

// Canonical spec key map
const SPEC_MAP = {
  'mckesson': 'mckesson_item',
  'mckesson #': 'mckesson_item',
  'manufacturer #': 'mpn',
  'manufacturer': 'manufacturer',
  'brand': 'brand',
  'country of origin': 'country_of_origin',
  'application': 'application',
  'color': 'color',
  'dimensions': 'dimensions',
  'length': 'length',
  'material': 'material',
  'number per pack': 'count_per_pack',
  'ply': 'ply',
  'shape': 'shape',
  'shape range': 'shape_range',
  'sterility': 'sterility',
  'unspsc code': 'unspsc',
  'width': 'width',
  'latex free indicator': 'latex_free_indicator',
  'hcpcs': 'hcpcs',
  'fsa eligible - buy uom': 'fsa_eligible',
  // already-normalized alternates:
  'unspsc_code': 'unspsc',
  'mckesson_#': 'mckesson_item',
  'manufacturer_#': 'mpn'
};

// Domain parser from record source/_browse
function domainFromSource(rec) {
  const src = (rec && rec.source) || (rec && rec._browse && rec._browse.source_url) || '';
  try {
    const u = new URL(src);
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Identify non-product tabs
function isJunkTab(tab) {
  const html = String(tab?.html || '').toLowerCase();
  const text = String(tab?.text || '').toLowerCase();
  if (!html && !text) return true;
  if (DROP_CLASS_HINTS.some(c => html.includes(c))) return true;
  if (DROP_PHRASES.some(p => text.includes(p.toLowerCase()))) return true;
  const isFeatures = html.includes('product-features');
  const isSpecs = html.includes('product specifications') && html.includes('<table');
  return !(isFeatures || isSpecs);
}

// Normalize specs to canonical map; non-destructive
function normalizeSpecsToSpecMap(rawSpecs = {}) {
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(rawSpecs)) {
    const kNorm = String(rawKey).trim().toLowerCase();
    const key = SPEC_MAP[kNorm];
    if (!key) continue;
    let val = String(rawVal).trim();
    if (!val) continue;
    if (key === 'brand') val = val.replace(/®/g, '').trim();
    if (key === 'count_per_pack') {
      const m = val.match(/(\d+)/);
      if (m) val = Number(m[1]);
    }
    if (key === 'ply') {
      // Normalize forms like "12-Ply" -> "12‑ply"
      const m = val.match(/(\d+)\s*-\s*ply|\b(\d+)\s*ply\b/i);
      if (m) {
        const num = m[1] || m[2];
        val = `${num}‑ply`;
      } else {
        val = val.replace(/ply/i, 'ply').replace(/\s+/g, ' ').trim();
      }
    }
    if (key === 'latex_free_indicator') {
      out.latex_free = /not made with natural rubber latex/i.test(val);
    }
    out[key] = val;
  }
  // Backfills if only alternates exist
  if (!out.mpn && rawSpecs['manufacturer_#']) out.mpn = rawSpecs['manufacturer_#'];
  if (!out.mckesson_item && rawSpecs['mckesson']) out.mckesson_item = rawSpecs['mckesson'];
  if (!out.brand && out.manufacturer) {
    out.brand = out.manufacturer;
  }

  return out;
}

// Clean description by removing menu/promo bleed and cutting at Features/Specs markers
function cleanMcKessonDescription(desc) {
  if (!desc) return '';
  const lines = String(desc)
    .replace(/\u00A0/g, ' ')
    .split(/\r?\n|•\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !DROP_PHRASES.some(p => s.toLowerCase().includes(p.toLowerCase())));
  const stop = lines.findIndex(s => /^features$|^product specifications$/i.test(s));
  const trimmed = (stop > -1 ? lines.slice(0, stop) : lines);
  return [...new Set(trimmed)].slice(0, 2).join(' ');
}

// Extract SDS URL from _browse links or tab HTML
function getSdsUrlFromRecord(rec) {
  const fromBrowse = rec?._browse?.links?.pdfs;
  if (Array.isArray(fromBrowse) && fromBrowse[0]) return fromBrowse[0];
  // Fallback: scan tabs html for .pdf links
  if (Array.isArray(rec?.tabs)) {
    for (const t of rec.tabs) {
      const html = String(t?.html || '');
      const m = html.match(/https?:\/\/[^\s"'<>]+\.pdf/gi);
      if (m && m.length) return m[0];
    }
  }
  return null;
}

// Build clean product name: "<Brand> <Application>, <Dimensions>, <Ply>, <Sterility>, <Count/Pack> (<MPN>)"
function buildSanitizedName(specsCanon, rec) {
  try {
    const brand = (specsCanon.brand || rec.brand || '').toString().replace(/®/g, '').trim();
    const application = (specsCanon.application || rec.name_raw || '').toString().trim();
    const size = (specsCanon.dimensions || '').toString().trim();
    const ply = (specsCanon.ply || '').toString().trim();
    const sterility = (specsCanon.sterility || '').toString().replace(/non\s*sterile/i, 'Non‑Sterile').replace(/sterile/i, 'Sterile').trim();
    const count = (typeof specsCanon.count_per_pack === 'number' ? `${specsCanon.count_per_pack}/Pack` : '').trim();
    const mpn = (specsCanon.mpn || rec.sku || '').toString().trim();

    const parts = [brand, application, size, ply, sterility, count].filter(Boolean).join(', ');
    const withMpn = parts + (mpn ? ` (${mpn})` : '');
    return withMpn.replace(/\s{2,}/g, ' ').trim().replace(/^,|,,/g, '');
  } catch {
    return '';
  }
}
