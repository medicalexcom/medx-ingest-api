/*
 * Variant extraction utility
 *
 * This module provides a single function, `extractVariants`, that takes in an
 * object representing page data (scraped HTML, specs, features, JSON‑LD, etc.)
 * and returns an array of variant objects. A variant object conforms to the
 * schema expected by the ingestion pipeline, containing a unique SKU, price,
 * option values and an optional image URL.
 *
 * The extractor is designed to be permissive and resilient. It works by
 * aggregating potential variant option groups from several sources:
 *   1. Structured specifications (`specs`): if a spec key contains multiple
 *      values (either as an array or comma-/slash‑separated string), it is
 *      treated as a variant option group. For example, a `Size` spec of
 *      `["Small", "Medium", "Large"]` yields a `Size` option with three
 *      values.
 *   2. Natural language patterns in features and description: sentences like
 *      "Available in red, blue and green" are parsed to extract variant
 *      values when the extractor cannot determine the option name. These
 *      values are grouped under a generic `Variant` option.
 *   3. JSON‑LD microdata: if the page includes structured data with `offers`
 *      containing `color` or `size` fields, those values are collected. Each
 *      offer may also carry its own SKU or price which will be used later
 *      when building the final variant records.
 *   4. Raw HTML: when the optional dependency `cheerio` is available, the
 *      extractor will scan the DOM for `<select>` elements, radio or button
 *      groups, and tables that appear to define variants. The heuristics
 *      intentionally err on the side of inclusion – any select with more
 *      than one option or table column matching known variant keywords is
 *      treated as a variant group.
 *
 * Once all option groups have been assembled, the extractor computes the
 * Cartesian product of the values from each group to create variant
 * combinations. It attempts to derive a unique SKU for each combination by
 * appending an abbreviated suffix of the option values to the base SKU (if
 * provided). Prices are carried over from the base or first offer. Image
 * mappings are not attempted here; they may be added in the ingestion
 * pipeline when variant images are associated with specific options.
 *
 * Usage example:
 *
 *   const variants = extractVariants({
 *     html: rawHtmlString,
 *     specs: { Size: ["Small", "Large"], Color: "Red/Blue" },
 *     features: ["Available in packs of 10 and 20"],
 *     jsonldJson: { sku: "ABC123", offers: [{ color: "Red", price: 9.99 }, { color: "Blue", price: 10.99 }] },
 *     description: "...",
 *     price: 9.99,
 *   });
 *
 *   // variants will contain objects like:
 *   // [
 *   //   { sku: 'ABC123-RED-SMALL', price: 9.99, option_values: [{ option_name: 'Size', value: 'Small' }, { option_name: 'Color', value: 'Red' }], image_url: null },
 *   //   { sku: 'ABC123-BLUE-LARGE', price: 10.99, option_values: [ ... ], image_url: null },
 *   //   ...
 *   // ]
 */

/**
 * Normalize a string by removing excessive whitespace and replacing separators
 * with a single space. Also trims trailing punctuation.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeString(str) {
  return String(str)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[;:,]+$/, '')
    .trim();
}

/**
 * Split a string containing multiple values into an array. Recognizes
 * separators such as commas, slashes, semicolons and the word 'or'. Values
 * containing hyphens (e.g. dimensions) are preserved.
 *
 * @param {string} value
 * @returns {string[]}
 */
function splitValueList(value) {
  if (!value) return [];
  // First, replace ' or ' with commas to unify separators
  const unified = value.replace(/\s+or\s+/gi, ',');
  // Split on comma or slash delimiters
  return unified
    .split(/[\/,:;]+/)
    .map((v) => normalizeString(v))
    .filter((v) => v.length > 0);
}

/**
 * Parse JSON‑LD offers to extract variant information. The function collects
 * colors, sizes and individual prices from offers where present. If an offer
 * includes its own SKU, price or option values, they will be stored for
 * later merging.
 *
 * @param {any} jsonld
 * @returns {{ optionGroups: Map<string, Set<string>>, offers: any[] }}
 */
function parseJsonLdVariants(jsonld) {
  const optionGroups = new Map();
  const offersList = [];
  if (!jsonld) return { optionGroups, offers: offersList };
  // Normalize single offer to array
  const offers = Array.isArray(jsonld.offers)
    ? jsonld.offers
    : jsonld.offers
    ? [jsonld.offers]
    : [];
  offers.forEach((offer) => {
    if (!offer || typeof offer !== 'object') return;
    const offerRecord = {};
    if (offer.sku) offerRecord.sku = String(offer.sku);
    if (offer.price) offerRecord.price = parseFloat(offer.price);
    // Many schemas nest the price under priceSpecification
    if (!offerRecord.price && offer.priceSpecification && offer.priceSpecification.price) {
      offerRecord.price = parseFloat(offer.priceSpecification.price);
    }
    // Collect color and size values into option groups
    if (offer.color) {
      const color = normalizeString(offer.color);
      if (color) {
        if (!optionGroups.has('Color')) optionGroups.set('Color', new Set());
        optionGroups.get('Color').add(color);
        offerRecord.color = color;
      }
    }
    if (offer.size) {
      const size = normalizeString(offer.size);
      if (size) {
        if (!optionGroups.has('Size')) optionGroups.set('Size', new Set());
        optionGroups.get('Size').add(size);
        offerRecord.size = size;
      }
    }
    offersList.push(offerRecord);
  });
  return { optionGroups, offers: offersList };
}

/**
 * Parse specification entries to discover variant option groups. If a spec
 * contains more than one value or a value is a string with multiple
 * separators, treat it as an option group. All values are normalized and
 * duplicates are removed. Keys are used as the option names.
 *
 * @param {object} specs
 * @returns {Map<string, Set<string>>}
 */
function parseSpecVariants(specs) {
  const optionGroups = new Map();
  if (!specs || typeof specs !== 'object') return optionGroups;
  for (const key of Object.keys(specs)) {
    if (!key) continue;
    const rawValue = specs[key];
    const values = [];
    if (Array.isArray(rawValue)) {
      rawValue.forEach((v) => {
        if (typeof v === 'string' && v.trim()) values.push(...splitValueList(v));
      });
    } else if (typeof rawValue === 'string') {
      const list = splitValueList(rawValue);
      if (list.length > 0) values.push(...list);
    }
    // Only consider as a variant group if there is more than one distinct value
    const uniqueVals = Array.from(new Set(values));
    if (uniqueVals.length > 1) {
      optionGroups.set(normalizeString(key), new Set(uniqueVals));
    }
  }
  return optionGroups;
}

/**
 * Parse textual descriptions and feature lists to extract variant values from
 * phrases like "Available in red, blue and green" or "Comes in 5 mL / 10 mL".
 * Since these strings lack explicit option names, extracted values are
 * grouped under a generic `Variant` key. The function is intentionally
 * liberal – it will match any sequence that appears after keywords such as
 * "available", "comes" or "offered" followed by "in".
 *
 * @param {string[]} texts
 * @returns {Map<string, Set<string>>}
 */
function parseTextualVariants(texts) {
  const optionGroups = new Map();
  const addValues = (values) => {
    if (!optionGroups.has('Variant')) optionGroups.set('Variant', new Set());
    values.forEach((val) => optionGroups.get('Variant').add(val));
  };
  const pattern = /\b(?:available|comes|offered)\s+in\s+([\w\d\s\-×x\.]+(?:,\s*[\w\d\s\-×x\.]+)+)/gi;
  texts.forEach((line) => {
    if (typeof line !== 'string') return;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const valuesStr = match[1];
      // Split on comma separators
      const values = valuesStr
        .split(/,\s*/)
        .map((v) => normalizeString(v))
        .filter((v) => v.length > 0);
      if (values.length > 1) addValues(values);
    }
  });
  return optionGroups;
}

/**
 * Attempt to parse HTML for variant options using cheerio. This function
 * gracefully degrades if cheerio is not available. It scans select elements,
 * radio/button groups and tables for variant patterns. Option names are
 * derived from element names, ids or table headers. Only groups with more
 * than one distinct value are returned.
 *
 * @param {string} html
 * @returns {Map<string, Set<string>>}
 */
function parseHtmlVariants(html) {
  const optionGroups = new Map();
  if (!html || typeof html !== 'string') return optionGroups;
  let cheerio;
  try {
    cheerio = require('cheerio');
  } catch (err) {
    // Cheerio is not available; skip HTML parsing
    return optionGroups;
  }
  const $ = cheerio.load(html);
  // Helper to register values under an option name
  const register = (name, values) => {
    if (!name || !values || values.length <= 1) return;
    const normName = normalizeString(name);
    if (!optionGroups.has(normName)) optionGroups.set(normName, new Set());
    values.forEach((val) => optionGroups.get(normName).add(normalizeString(val)));
  };
  // Select elements
  $('select').each((index, select) => {
    const $select = $(select);
    // Derive option name from name attribute or id or data‑attribute
    const attrName = $select.attr('data-option-name') || $select.attr('name') || $select.attr('id');
    const optionName = attrName ? attrName.replace(/[_-]+/g, ' ') : `Option ${index + 1}`;
    const values = [];
    $select.find('option').each((i, opt) => {
      const text = $(opt).text().trim();
      if (text && !/^select/i.test(text)) {
        values.push(text);
      }
    });
    register(optionName, values);
  });
  // Radio/button groups within a container that looks like a variant selector
  $('.product-options, .product-option, .option-group, .swatch').each((i, section) => {
    const $section = $(section);
    // Derive a label from the first heading or label element
    let label = $section.find('label').first().text().trim();
    if (!label) {
      label = $section.closest('div').prev('div').find('label, h3, h4, h5').first().text().trim();
    }
    if (!label) return;
    const values = [];
    // Collect values from buttons, radio inputs, list items or swatch labels
    $section
      .find('input[type="radio"], button, li, .swatch-option, .option-value')
      .each((j, el) => {
        const text = $(el).text().trim();
        if (text) values.push(text);
      });
    register(label, values);
  });
  // Variant tables – treat columns containing known keywords as option groups
  $('table').each((i, table) => {
    const $table = $(table);
    const headers = [];
    $table.find('thead tr th').each((j, th) => {
      const header = $(th).text().trim();
      if (header) headers.push(header);
    });
    if (headers.length < 2) return;
    // Identify columns that look like variant attributes
    const keywordList = ['color', 'size', 'dimensions', 'dimension', 'gauge', 'width', 'length', 'height', 'volume', 'capacity'];
    const attrCols = {};
    headers.forEach((header, index) => {
      const normalized = header.toLowerCase();
      if (keywordList.some((kw) => normalized.includes(kw))) {
        attrCols[index] = header;
      }
    });
    if (Object.keys(attrCols).length === 0) return;
    // Extract values per column
    Object.entries(attrCols).forEach(([colIndex, header]) => {
      const values = [];
      $table.find('tbody tr').each((rowIndex, tr) => {
        const cell = $(tr).find('td').eq(Number(colIndex));
        const text = cell.text().trim();
        if (text) values.push(text);
      });
      register(header, values);
    });
  });
  return optionGroups;
}

/**
 * Build a Cartesian product of option groups to produce variant combinations. A
 * helper function is defined inside to recursively iterate through the
 * options.
 *
 * @param {Array<{ name: string, values: string[] }>} optionEntries
 * @returns {Array<Array<{ option_name: string, value: string }>>}
 */
function buildVariantCombinations(optionEntries) {
  const results = [];
  const current = [];
  const helper = (index) => {
    if (index === optionEntries.length) {
      results.push(current.slice());
      return;
    }
    const { name, values } = optionEntries[index];
    values.forEach((value) => {
      current.push({ option_name: name, value });
      helper(index + 1);
      current.pop();
    });
  };
  helper(0);
  return results;
}

/**
 * Generate a unique SKU for a variant by appending abbreviations of option
 * values to a base SKU. Non‑alphanumeric characters are stripped and each
 * abbreviation is limited to eight characters. If no base SKU is provided,
 * the concatenated abbreviations become the SKU. If abbreviations are empty,
 * a fallback using the variant index is used.
 *
 * @param {string|null} baseSku
 * @param {Array<{ option_name: string, value: string }>} optionValues
 * @param {number} index
 * @returns {string}
 */
function generateSku(baseSku, optionValues, index) {
  const abbreviations = optionValues.map(({ value }) => {
    return value
      .replace(/\s+/g, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8)
      .toUpperCase();
  });
  const suffix = abbreviations.filter((v) => v).join('-');
  if (baseSku) {
    return suffix ? `${baseSku}-${suffix}` : baseSku;
  }
  return suffix || `VAR${index + 1}`;
}

/**
 * Main variant extraction function. It merges variants discovered from
 * specifications, textual patterns, JSON‑LD and HTML, then generates
 * combinations and assembles variant records.
 *
 * The input object may contain the following properties:
 *   - html: raw HTML string of the product page
 *   - specs: an object of key/value pairs (arrays or strings) of extracted specs
 *   - features: array of feature strings
 *   - description: main product description string
 *   - jsonldJson: parsed JSON‑LD data
 *   - sku: base SKU string
 *   - price: base price number (optional; per‑variant prices may be taken from jsonld offers)
 *
 * @param {object} pageData
 * @returns {Array<{ sku: string, price: number|null, option_values: Array<{ option_name: string, value: string }>, image_url: string|null }>}
 */
function extractVariants(pageData) {
  if (!pageData || typeof pageData !== 'object') return [];
  // Collect variant groups from each source
  const variantGroups = new Map();
  // Specs
  const specGroups = parseSpecVariants(pageData.specs);
  specGroups.forEach((set, key) => {
    if (!variantGroups.has(key)) variantGroups.set(key, new Set());
    set.forEach((val) => variantGroups.get(key).add(val));
  });
  // Textual features and description
  const texts = [];
  if (Array.isArray(pageData.features)) {
    texts.push(...pageData.features);
  }
  if (typeof pageData.description === 'string') {
    texts.push(pageData.description);
  }
  const textGroups = parseTextualVariants(texts);
  textGroups.forEach((set, key) => {
    if (!variantGroups.has(key)) variantGroups.set(key, new Set());
    set.forEach((val) => variantGroups.get(key).add(val));
  });
  // JSON‑LD offers
  const jsonldResult = parseJsonLdVariants(pageData.jsonldJson);
  jsonldResult.optionGroups.forEach((set, key) => {
    if (!variantGroups.has(key)) variantGroups.set(key, new Set());
    set.forEach((val) => variantGroups.get(key).add(val));
  });
  // HTML parsing via cheerio
  const htmlGroups = parseHtmlVariants(pageData.html);
  htmlGroups.forEach((set, key) => {
    if (!variantGroups.has(key)) variantGroups.set(key, new Set());
    set.forEach((val) => variantGroups.get(key).add(val));
  });
  // Convert variantGroups into an array of { name, values }
  const optionEntries = [];
  variantGroups.forEach((set, key) => {
    const values = Array.from(set);
    if (values.length > 1) {
      optionEntries.push({ name: key, values });
    }
  });
  if (optionEntries.length === 0) return [];
  // Build the full set of variant combinations
  const combinations = buildVariantCombinations(optionEntries);
  // Determine base SKU and base price
  const baseSku = pageData.sku || (pageData.jsonldJson && pageData.jsonldJson.sku) || null;
  let basePrice = null;
  if (typeof pageData.price === 'number') {
    basePrice = pageData.price;
  } else if (pageData.jsonldJson) {
    // Use the first offer's price as base price if available
    const offers = Array.isArray(pageData.jsonldJson.offers)
      ? pageData.jsonldJson.offers
      : pageData.jsonldJson.offers
      ? [pageData.jsonldJson.offers]
      : [];
    if (offers.length > 0) {
      const firstOffer = offers[0];
      if (firstOffer && firstOffer.price) basePrice = parseFloat(firstOffer.price);
      else if (firstOffer && firstOffer.priceSpecification && firstOffer.priceSpecification.price) {
        basePrice = parseFloat(firstOffer.priceSpecification.price);
      }
    }
  }
  // Map JSON‑LD offers by option combination (for variant-specific price/sku)
  const offerMap = new Map();
  jsonldResult.offers.forEach((offer) => {
    // Build a key using color/size values present in offer
    const keys = [];
    if (offer.color) keys.push(`Color:${normalizeString(offer.color)}`);
    if (offer.size) keys.push(`Size:${normalizeString(offer.size)}`);
    const compositeKey = keys.join('|');
    if (!compositeKey) return;
    offerMap.set(compositeKey, offer);
  });
  // Assemble final variants
  const variants = combinations.map((optionValues, idx) => {
    // Determine price and SKU from offers if possible
    let price = basePrice;
    let sku = baseSku;
    // Look up an offer matching the combination
    const compositeKey = optionValues
      .map(({ option_name, value }) => `${normalizeString(option_name)}:${normalizeString(value)}`)
      .join('|');
    const offer = offerMap.get(compositeKey);
    if (offer) {
      if (typeof offer.price === 'number') price = offer.price;
      if (offer.sku) sku = offer.sku;
    }
    // Generate unique SKU
    sku = generateSku(sku, optionValues, idx);
    return {
      sku,
      price: typeof price === 'number' ? price : null,
      option_values: optionValues,
      image_url: null,
    };
  });
  return variants;
}

module.exports = { extractVariants };
