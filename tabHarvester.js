// tabHarvester.js
//
// This module scrapes tabbed or accordion content from static HTML
// documents.  It is based on the upstream `tabHarvester.js` in the
// medx‑ingest‑api repository but has been extended with the following
// enhancements:
//
//   * **Quantity normalisation** — Items extracted from “What’s in the
//     Box” and “Products Include” lists are parsed for explicit
//     quantities (e.g. “2 × diaphragms”, “two tubes”, “tube (2)”).  The
//     new `normalizeIncluded` helper produces canonical strings of the
//     form `n × item` and aggregates duplicate items.  Without this,
//     quantities were ignored and duplicates were not counted.

import { load as cheerioLoad } from 'cheerio';
import {
  stripTags,
  norm,
  sanitizeRawHtml,
  extractHtmlAndText,
} from './harvesters/common.js';

// -----------------------------------------------------------------------------
// Selector normalisation helpers
//
// Cheerio uses the css-select parser, which does not support jQuery-only
// pseudo-classes like :eq(n) or bare numeric pseudo-classes like :0. When
// such selectors are encountered, it throws errors like “Unknown pseudo-class
// :0”.  To preserve existing behaviour while avoiding these errors, we
// normalise any jQuery-style index pseudo-classes into the standard CSS
// :nth-child() syntax.  These helpers are additive and do not remove or
// otherwise alter existing logic.

/**
 * Normalise selectors to avoid unsupported pseudo-classes in css-select.
 * Converts :eq(n) and bare :<number> into :nth-child(n+1). For example,
 * `:eq(0)` becomes `:nth-child(1)` and `:3` becomes `:nth-child(4)`.
 *
 * @param {string} selector The original selector
 * @returns {string} A selector compatible with css-select
 */
function normalizeSelector(selector) {
  return String(selector || '')
    .replace(/:eq\(\s*(\d+)\s*\)/g, (_, n) => ':nth-child(' + (Number(n) + 1) + ')')
    .replace(/:(\d+)\b/g, (_, n) => ':nth-child(' + (Number(n) + 1) + ')');
}

/**
 * Load HTML into Cheerio and patch its find() method to normalise selectors.
 * All calls to $.find() will first normalise the selector via normalizeSelector.
 * This prevents errors like “Unknown pseudo-class :0” while preserving
 * existing behaviour.  The rest of the Cheerio API remains unchanged.
 *
 * @param {string} html The HTML string to load
 * @returns {CheerioAPI} A Cheerio instance with safe selector handling
 */
function loadHtmlSafe(html) {
  const $ = cheerioLoad(html || '');
  const origFind = $.prototype.find;
  $.prototype.find = function (selector) {
    const safeSelector = typeof selector === 'string' ? normalizeSelector(selector) : selector;
    try {
      return origFind.call(this, safeSelector);
    } catch {
      return origFind.call(this, selector);
    }
  };
  return $;
}

/**
 * Deduplicate tab/accordion container nodes.  Given an array of
 * candidate elements, remove duplicates based on tag name and class
 * combination.  This helps avoid redundant processing of the same
 * container.
 *
 * @param {Cheerio[]} candidates Array of candidate nodes
 * @param {CheerioAPI} $ The cheerio instance
 * @returns {Cheerio[]}
 */
function dedupeCandidates(candidates, $) {
  const set = new Set();
  const out = [];
  for (const el of candidates) {
    const tag = $(el).prop('tagName') || '';
    const cls = $(el).attr('class') || '';
    const key = `${tag}:${cls}`.trim();
    if (!set.has(key)) {
      set.add(key);
      out.push(el);
    }
  }
  return out;
}

/**
 * Find likely tab or accordion containers across common frameworks.
 *
 * This function looks for a wide variety of patterns that indicate
 * content hidden in tabs or accordions.  It aggregates selectors from
 * WooCommerce product tabs, Bootstrap/ARIA tab controls, generic tab
 * widgets, and accordion structures.  The returned array may contain
 * duplicates which should be filtered via `dedupeCandidates`.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @returns {Cheerio[]}
 */
function findTabCandidates($) {
  const candidates = [];
  // WooCommerce tabs and panels
  candidates.push(...$('.woocommerce-tabs, .wc-tabs, .woocommerce-Tabs-panel').toArray());
  // Bootstrap or ARIA tab lists
  candidates.push(...$('.nav-tabs, [role="tablist"]').toArray());
  if ($('.tab-content .tab-pane').length) {
    candidates.push(...$('.tab-content').toArray());
  }
  // Generic tabs/accordions used by various WP builders
  candidates.push(...$('.tabs, .tabset, .tabbed, .et_pb_tabs').toArray());
  candidates.push(...$('.accordion, .et_pb_accordion, .wp-block-coblocks-accordion').toArray());
  return dedupeCandidates(candidates, $);
}

/**
 * Parse all list items within a block of HTML.  Returns an array of
 * strings representing the textual content of each list item.  Used
 * primarily to extract parts lists from “What’s in the Box” and
 * “Products Include” sections.
 *
 * @param {string} html The HTML fragment to parse
 * @returns {string[]}
 */
function listItemsFromHtml(html) {
  // If no HTML provided, return empty array early
  if (!html) return [];
  const _$ = loadHtmlSafe(html);
  const items = [];
  // First attempt: extract canonical list items from <ul> or <ol> tags
  _$('ul li, ol li').each((_, li) => {
    const txt = norm(_$(li).text());
    if (txt) items.push(txt);
  });
  // If we found list items via structural tags, return them
  if (items.length > 0) return items;
  // Fallback: attempt to parse bullet-like characters in plain text when
  // there are no <li> elements.  Strip tags and split on common bullet
  // characters or newline separators.  This helps capture lists that
  // are styled via CSS rather than semantic <li> elements.
  const plain = stripTags(html);
  // Define a regex to split on bullet characters.  We avoid splitting on
  // simple hyphens to prevent breaking words like “3-inch” or “24mm”.
  const bulletSplit = /[\u2022\u2023\u25E6\u2043\u2219\u2027]/; // • ‣ ◦ ⁃ ∙ ‧
  let segments = [];
  if (bulletSplit.test(plain)) {
    segments = plain.split(bulletSplit);
  } else {
    // As a final fallback, split on newline or carriage return if present
    segments = plain.split(/\r?\n/);
  }
  segments.forEach(seg => {
    const trimmed = norm(seg);
    if (trimmed) items.push(trimmed);
  });
  return items;
}

/**
 * Extract tabs and their content from Salesforce/forceCommunity tabsets.
 * This helper scans containers with role="tablist" for tab labels and
 * matches them with corresponding panels marked with role="tabpanel".
 * It returns an array of objects with title, html, rawHtml, text and source.
 * For Lightning panels we discard the original raw markup and reuse the
 * sanitised html as `rawHtml` so that the returned payload does not
 * include verbose <slot>/<lightning-accordion> markup.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
function extractSalesforceTabs($) {
  const out = [];
  // Iterate over each tablist element
  $('[role="tablist"]').each((_, tablist) => {
    const titles = {};
    // Find all tab controls within the tablist; they may be anchors or custom elements
    $(tablist)
      .find('[role="tab"], a')
      .each((__, el) => {
        const $el = $(el);
        // Determine the content ID: href (#id) or aria-controls or data-target-selection-name
        let id = ($el.attr('href') || '').replace(/^#/, '');
        if (!id) {
          id = $el.attr('aria-controls') || $el.attr('data-target-selection-name') || '';
        }
        if (!id) return;
        // Derive a title: prefer a title attribute, then nested .title span, then text
        const title = norm(
          $el.attr('title') || $el.find('.title').text() || $el.text(),
        );
        if (title) {
          titles[id] = title;
        }
      });
    // Locate the nearest tabset container; fall back to document if none found
    const $container = $(tablist).closest('[class*=tabset], .js-tabset').first();
    const panelRoot = $container.length ? $container : $(tablist).parent();
    panelRoot.find('[role="tabpanel"]').each((__, pane) => {
      const id = $(pane).attr('id');
      // Look up the tab title from the navigation; fallback to headings within the pane
      let title =
        titles[id] ||
        norm(
          $(pane).attr('aria-label') ||
            $(pane).find('h2,h3,h4').first().text(),
        );
      // If title is still blank, synthesise a name from the order
      if (!title) {
        const index = out.length + 1;
        title = `Tab ${index}`;
      }
      const { html, text } = extractHtmlAndText($, pane);
      // For Salesforce tabs, treat the sanitised html as rawHtml to avoid
      // returning verbose Lightning markup
      const rawHtml = html;
      if (html || text) {
        out.push({ title, html, rawHtml, text, source: 'salesforce' });
      }
    });
  });
  return out;
}

/**
 * Extract tab or accordion content from a static HTML document using
 * multiple strategies.  Each extracted entry has a title, the raw
 * HTML of the content pane, the plain text, and a `source` tag
 * indicating which heuristic matched.  Sources include:
 *   - `woocommerce`: for WooCommerce product tabs
 *   - `bootstrap`: for Bootstrap/ARIA tab controls
 *   - `salesforce`: for Salesforce/Lightning tabsets (added)
 *   - `generic`: for generic tab or accordion structures
 *   - `heuristic`: for sections matching labels like “What’s in the Box”
 *     or “Products Include” even if not part of an explicit tab widget
 *
 * @param {CheerioAPI} $ The cheerio instance for the document
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
function extractTabsFromDoc($) {
  const results = [];
  // 1) WooCommerce tabs (ul.wc-tabs / .woocommerce-Tabs-panel)
  $('.woocommerce-tabs').each((_, cont) => {
    const $cont = $(cont);
    const titles = {};
    $cont.find('ul.wc-tabs li a[href]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const id = href.startsWith('#') ? href.slice(1) : href;
      if (id) titles[id] = norm($a.text());
    });
    $cont.find('.woocommerce-Tabs-panel').each((_, p) => {
      const id = $(p).attr('id');
      const title =
        titles[id] ||
        norm($(p).attr('aria-label') || $(p).find('h2,h3,h4').first().text());
      const { rawHtml, html, text } = extractHtmlAndText($, p);
      if (html || text) results.push({ title, html, rawHtml, text, source: 'woocommerce' });
    });
  });
  // 2) Bootstrap/ARIA tabs
  const navTitles = {};
  $('.nav-tabs, [role="tablist"]')
    .find('a[href]')
    .each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const id = href.startsWith('#') ? href.slice(1) : href;
      if (id) navTitles[id] = norm($a.text());
    });
  $('.tab-content .tab-pane').each((_, pane) => {
    const id = $(pane).attr('id');
    const title =
      navTitles[id] ||
      norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
    const { rawHtml, html, text } = extractHtmlAndText($, pane);
    if (html || text) results.push({ title, html, rawHtml, text, source: 'bootstrap' });
  });
  // 2a) Salesforce/forceCommunity tabsets (added)
  // Append any tabs extracted from Lightning-based tab components.
  results.push(...extractSalesforceTabs($));
  // 3) Generic tab/accordion fallback: heading followed by content until next heading
  const genericContainers = findTabCandidates($);
  genericContainers.forEach(cont => {
    const $cont = $(cont);
    $cont.find('h2, h3, h4').each((_, h) => {
      const title = norm($(h).text());
      const frag = $(' ');
      let sib = $(h).next();
      while (sib.length && !/H2|H3|H4/.test(sib.prop('tagName') || '')) {
        frag.append(sib.clone());
        sib = sib.next();
      }
      const { rawHtml, html, text } = extractHtmlAndText($, frag);
      if ((html || text) && title) results.push({ title, html, rawHtml, text, source: 'generic' });
    });
  });
  // 4) Heuristic sections based on labels (even outside explicit tabs)
  const wanted = [
    /products?\s+include/i,
    /what'?s?\s+in\s+the\s+box/i,
    /\b(inclusions?|package\s+contents?)\b/i,
    /\b(specs?|specifications?)\b/i,
    /\bfeatures?\b/i,
  ];
  $('section, div, article').each((_, sec) => {
    const heading = norm($(sec).find('h2,h3,h4').first().text());
    if (heading && wanted.some(rx => rx.test(heading))) {
      const { rawHtml, html, text } = extractHtmlAndText($, sec);
      if (html || text) results.push({ title: heading, html, rawHtml, text, source: 'heuristic' });
    }
  });
  // Deduplicate based on title + first 256 chars of HTML
  const seen = new Set();
  return results.filter(t => {
    const key = `${t.title}::${t.html.slice(0, 256)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fetch remote tabs when tab controls reference external URLs.  Some tab
 * frameworks allow content panes to be loaded via AJAX (e.g. data-remote
 * or data-url attributes) or via anchor tags pointing to absolute URLs.
 * This helper fetches those remote pages and extracts their primary
 * content.  The fetch is guarded by a timeout to avoid hanging
 * requests.  If a request fails, it is silently ignored.
 *
 * @param {CheerioAPI} $ The cheerio instance for the main document
 * @returns {Promise<{title: string, html: string, text: string, source: string}[]>}
 */
async function maybeFetchRemoteTabs($) {
  const links = [];
  $('[data-remote],[data-url],[role="tablist"] a[href], .nav-tabs a[href]').each((_, a) => {
    const $a = $(a);
    const u = $a.attr('data-remote') || $a.attr('data-url') || $a.attr('href');
    if (u && !u.startsWith('#') && /^https?:/i.test(u)) {
      links.push({ title: norm($a.text()), url: u });
    }
  });
  const out = [];
  for (const { title, url } of links) {
    try {
      const controller = new AbortController();
      // Abort after 10 seconds to avoid hanging
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const _$ = loadHtmlSafe(html);
      const body = _$('#main, article, .entry-content, body').first();
      const raw = body.html() || '';
      const sanitized = stripTags(raw);
      const t = norm(body.text() || '');
      // For remote content we preserve the raw HTML of the primary body
      // fragment and also provide a sanitised version.  The raw HTML is
      // useful for extracting lists, while the sanitised version can be
      // used downstream to avoid HTML leaks.
      if (sanitized || t) {
        const remoteTitle = title || norm(_$('h1,h2').first().text());
        out.push({ title: remoteTitle, html: sanitized, rawHtml: raw, text: t, source: 'remote' });
      }
    } catch {
      // Ignore fetch or parse errors silently
    }
  }
  return out;
}

/**
 * Normalise quantity strings extracted from “What’s in the Box” and
 * “Products Include” lists.  Parses numeric prefixes and suffixes,
 * spelled‑out numbers, multiplication signs and parenthesised counts.
 * Aggregates duplicate items and returns canonical strings of the
 * form `n × item`.
 *
 * @param {string[]} lines Raw list items
 * @returns {string[]} Normalised item strings with quantities
 */
function normalizeIncluded(lines = []) {
  const counts = {};
  const NUMWORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  for (const rawLine of lines) {
    if (!rawLine) continue;
    let s = norm(rawLine);
    // Normalise multiplication sign to 'x'
    s = s.replace(/[×]/g, 'x');
    let qty = 1;
    let item = '';
    let m;
    // Patterns: number x item
    if ((m = s.match(/^(\d+)\s*x\s*(.+)$/i))) {
      qty = parseInt(m[1], 10);
      item = norm(m[2]);
    } else if ((m = s.match(/^([a-z]+)\s*x\s*(.+)$/i)) && NUMWORDS[m[1].toLowerCase()]) {
      qty = NUMWORDS[m[1].toLowerCase()];
      item = norm(m[2]);
    } else if ((m = s.match(/^(\d+)\s+(.+)/i))) {
      // e.g. '2 diaphragms'
      qty = parseInt(m[1], 10);
      item = norm(m[2]);
    } else if ((m = s.match(/^([a-z]+)\s+(.+)/i)) && NUMWORDS[m[1].toLowerCase()]) {
      // e.g. 'two diaphragms'
      qty = NUMWORDS[m[1].toLowerCase()];
      item = norm(m[2]);
    } else if ((m = s.match(/^(.+)\s+x\s*(\d+)$/i))) {
      // e.g. 'tube x 2'
      qty = parseInt(m[2], 10);
      item = norm(m[1]);
    } else if ((m = s.match(/^(.+)\s+\((\d+)\)$/i))) {
      // e.g. 'cushion (2)'
      qty = parseInt(m[2], 10);
      item = norm(m[1]);
    } else {
      item = s;
    }
    // Only remove bullet characters or dashes; preserve numeric prefixes (e.g. “24mm”)
    item = item.replace(/^[\s•\-–—]+/, '').replace(/\s{2,}/g, ' ').trim();
    if (!item) continue;
    counts[item] = (counts[item] || 0) + (isNaN(qty) ? 1 : qty);
  }
  return Object.entries(counts).map(([name, count]) => `${count} × ${name}`);
}

/**
 * Harvest tabs and lists from a full HTML document.  This is the main
 * exported function of this module.  It orchestrates the local
 * extraction of tabs and remote fetches, then post‑processes the
 * results to produce specialised arrays for “What’s in the Box”
 * (includedItems) and “Products Include” (productsInclude).  All
 * returned arrays are de‑duplicated and normalised for quantity.
 *
 * @param {string} html The full HTML document to parse
 * @param {string} baseUrl The base URL of the document (unused but kept for API parity)
 * @returns {Promise<{tabs: {title: string, html: string, rawHtml: string, text: string, source: string}[], includedItems: string[], productsInclude: string[]}>}
 */
export async function harvestTabsFromHtml(html, baseUrl) {
  const $ = loadHtmlSafe(html);
  // Remove navigation and other common noise elements before extracting tabs.
  $(
    'body > nav, body > header, body > footer, [role="navigation"], .navigation, .site-nav, .nav-bar, .navbar, .breadcrumb, .breadcrumbs, .pagination',
  ).remove();
  // Extract all tab content in the current document
  const inDoc = extractTabsFromDoc($);
  // Fetch remote tab content if any
  const remote = await maybeFetchRemoteTabs($);
  const tabs = [...inDoc, ...remote];
  // Parse lists from tabs
  const includedItems = [];
  const productsInclude = [];
  for (const t of tabs) {
    const htmlSrc = t.rawHtml || t.html;
    if (/what'?s?\s+in\s+the\s+box/i.test(t.title)) {
      includedItems.push(...listItemsFromHtml(htmlSrc));
    }
    if (/products?\s+include/i.test(t.title)) {
      productsInclude.push(...listItemsFromHtml(htmlSrc));
    }
  }
  // Deduplicate and normalise
  const uniq = a => Array.from(new Set((a || []).filter(Boolean)));
  const normIncluded = normalizeIncluded(uniq(includedItems));
  const normProducts = normalizeIncluded(uniq(productsInclude));
  return {
    tabs,
    includedItems: normIncluded,
    productsInclude: normProducts,
  };
}
