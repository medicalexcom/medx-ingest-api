import { load as cheerioLoad } from 'cheerio';
import { norm, extractHtmlAndText } from './common.js';

/**
 * Enhanced Salesforce tab harvester.  The default Salesforce harvester only
 * extracts panels defined via Lightning/ARIA tabsets.  This implementation
 * adds additional heuristics inspired by the main tabHarvester module to
 * capture more content sections on Salesforce pages.  It attempts to
 * populate multiple distinct sources of data: native Salesforce tabs,
 * generic Bootstrap/ARIA tab panes, and heuristic sections such as
 * "Specifications" or "What's in the box".  Each returned entry has
 * an id (where available), title, raw and sanitised HTML, plain text and
 * a source tag indicating which heuristic matched.
 *
 * @param {string} html A full HTML document (static) from a Salesforce page.
 * @returns {{id: string, title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSalesforceTabsEnhanced(html) {
  // Load the HTML into Cheerio.  We bypass selector normalisation here
  // because Salesforce pages typically do not use jQuery-only pseudo-classes.
  const $ = cheerioLoad(html || '');
  const results = [];

  // ---------------------------------------------------------------------------
  // 1) Salesforce Lightning/ARIA tabsets (native behaviour)
  $('[role="tablist"]').each((_, tablist) => {
    const titlesArr = [];
    $(tablist)
      .find('[role="tab"], a')
      .each((__, el) => {
        const $el = $(el);
        const title = norm(
          $el.attr('title') ||
          $el.find('.title').text() ||
          $el.text()
        );
        if (title) titlesArr.push(title);
      });
    const $container = $(tablist)
      .closest('[class*=tabset], .js-tabset')
      .first();
    const panelRoot = $container.length ? $container : $(tablist).parent();
    panelRoot
      .find('[role="tabpanel"], div[data-target-selection-name]')
      .each((index, pane) => {
        const $pane = $(pane);
        const id =
          $pane.attr('id') ||
          $pane.attr('data-target-selection-name') ||
          '';
        let title =
          titlesArr[index] ||
          norm(
            $pane.attr('aria-label') ||
              $pane.find('h2,h3,h4').first().text()
          );
        if (!title) {
          title = `Tab ${index + 1}`;
        }
        const { rawHtml, html: sanitized, text } = extractHtmlAndText($, pane);
        // Use sanitised HTML as rawHtml to avoid returning verbose Lightning markup.
        const raw = sanitized;
        if (sanitized || text) {
          results.push({ id, title, html: sanitized, rawHtml: raw, text, source: 'salesforce' });
        }
      });
  });

  // ---------------------------------------------------------------------------
  // 2) Generic Bootstrap/ARIA tab fallback
  // Salesforce pages sometimes embed Bootstrap-like tab panes (e.g. within HTML
  // components).  We scan for nav-tabs structures and extract those panes.
  const navTitles = {};
  $('.nav-tabs, [role="tablist"]').find('a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    // Skip fragment-only hrefs that are handled by Lightning above
    if (!href || href.startsWith('#')) return;
    const id = href.startsWith('#') ? href.slice(1) : href;
    if (id) navTitles[id] = norm($a.text());
  });
  $('.tab-content .tab-pane').each((_, pane) => {
    const $pane = $(pane);
    const id = $pane.attr('id') || '';
    // If this pane's id matches one found in navTitles, use that title; otherwise fall back to heading text.
    const title = navTitles[id] || norm(
      $pane.attr('aria-label') ||
      $pane.find('h2,h3,h4').first().text()
    );
    const { rawHtml, html: sanitized, text } = extractHtmlAndText($, pane);
    if (sanitized || text) {
      results.push({ id, title, html: sanitized, rawHtml, text, source: 'bootstrap' });
    }
  });

  // ---------------------------------------------------------------------------
  // 3) Heuristic sections based on common headings
  // Extract sections that resemble specification tables, feature lists or
  // package contents.  These often appear outside of explicit tab widgets.
  const wanted = [
    /products?\s+include/i,
    /what'?s?\s+in\s+the\s+box/i,
    /\b(inclusions?|package\s+contents?)\b/i,
    /\b(specs?|specifications?)\b/i,
    /\bfeatures?\b/i
  ];
  // Consider sections, articles and divs at the top level of the document.
  $('section, div, article').each((_, sec) => {
    const $sec = $(sec);
    // Look for the first heading within the section.
    const heading = norm($sec.find('h2,h3,h4').first().text());
    if (heading && wanted.some(rx => rx.test(heading))) {
      const { rawHtml, html: sanitized, text } = extractHtmlAndText($, sec);
      if (sanitized || text) {
        results.push({ id: '', title: heading, html: sanitized, rawHtml, text, source: 'heuristic' });
      }
    }
  });

  // -------------------------------------------------------------------------
  // 4) Generic fallback: extract any section with a heading even if it does not
  // match heuristic patterns.  This captures additional content blocks that
  // may be relevant but are not part of a tabset.  The deduplication logic
  // will remove any duplicates.
  $('section, div, article').each((_, sec) => {
    const $sec = $(sec);
    const heading = norm($sec.find('h2,h3,h4').first().text());
    if (heading) {
      const { rawHtml, html: sanitized, text } = extractHtmlAndText($, sec);
      if (sanitized || text) {
        results.push({ id: '', title: heading, html: sanitized, rawHtml, text, source: 'generic' });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 4) Deduplicate results.  Use the combination of title and first 256 characters of
  // sanitised HTML as a key.  This avoids returning multiple entries for the same
  // section extracted by different heuristics.
  const seen = new Set();
  const uniqueResults = [];
  for (const t of results) {
    const key = `${t.title}::${(t.html || '').slice(0, 256)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueResults.push(t);
    }
  }
  return uniqueResults;
}

/**
 * Backwards‑compatible wrapper for Salesforce tab extraction.
 *
 * Some modules expect an `extractSalesforceTabs` export.  Delegate to the
 * enhanced implementation so that callers automatically benefit from the
 * additional heuristics (Bootstrap tab fallback, heuristic sections,
 * generic headings).  This wrapper preserves the existing API signature
 * while exposing the improved behaviour.
 *
 * @param {string} html A full HTML document (static) from a Salesforce page.
 * @returns {{id: string, title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSalesforceTabs(html) {
  return extractSalesforceTabsEnhanced(html);
}

// -----------------------------------------------------------------------------
// Supplementary helpers to parse specifications and features from tab content.
// These helpers mirror logic found in mergeRaw.js to identify key/value pairs
// and classify free‑form sentences as product features.  They are included
// here so that Salesforce pages can contribute structured specs and a list of
// features directly from their tabbed content.

/**
 * Parse a specification line into a [key, value] pair.
 * Recognises patterns like "Key: Value", "Key – Value" (en dash) or
 * measurements such as "Total weight capacity 700 lbs".  Returns [null, null]
 * if no plausible spec is found.  Adapted from mergeRaw.js.
 *
 * @param {string} line A candidate specification line
 * @returns {[string|null, string|null]} Parsed key and value
 */
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
  const m2 = text.match(/^(.*?)\s+(\d+\s*(?:lb|lbs|kg|g|oz|ft|in|cm|mm|"|inch|inches)\b.*)$/i);
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

/**
 * Simple rule‑based classifier to determine if a sentence is a feature, benefit
 * or included item.  Looks for indicative keywords and falls back to
 * 'feature' when ambiguous.  Adapted from mergeRaw.js.
 *
 * @param {string} text A sentence from the tab content
 * @returns {string} One of 'feature', 'benefit' or 'included'
 */
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

/**
 * Extract Salesforce tab content along with derived features and specs.
 *
 * This helper runs the enhanced tab extractor and then applies simple
 * heuristics to derive a list of product features and a specification map
 * from the concatenated tab text.  The resulting features array can be
 * attached to `rec.features` by the calling code so that mergeRaw will
 * treat them as structured features.  Specifications extracted here are
 * merged non‑destructively into the existing `rec.specs`.
 *
 * @param {string} html A full HTML document (static) from a Salesforce page
 * @returns {{tabs: Array, features: string[], specs: object}}
 */
export function extractSalesforceData(html) {
  // First, extract all tab sections using the enhanced logic.
  const tabs = extractSalesforceTabsEnhanced(html);
  const features = [];
  const specs = {};
  // For each tab's text, break into candidate lines.  We split on newline,
  // bullet separators and periods/hyphens, then trim whitespace.
  for (const t of tabs) {
    const text = String(t.text || '');
    // Replace non-breaking spaces and double spaces
    const cleaned = text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    // Split on punctuation or capitalised "To " phrases to isolate sentences.
    const parts = cleaned
      .split(/(?<!\d)[.\n\u2022]+|\bTo\b/)
      .map(s => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      // Attempt to parse as a spec; if successful, merge into specs
      const [key, value] = parseSpecLine(part);
      if (key && value) {
        // Preserve first occurrence
        if (!(key in specs)) specs[key] = value;
        continue;
      }
      // Otherwise treat as a feature if it contains at least three words.
      if (part.split(/\s+/).length >= 3) {
        features.push(part);
      }
    }
  }
  // Deduplicate features
  const seen = new Set();
  const deduped = [];
  for (const f of features) {
    const normText = f.toLowerCase();
    if (!seen.has(normText)) {
      seen.add(normText);
      deduped.push(f);
    }
  }
  return { tabs, features: deduped, specs };
}
