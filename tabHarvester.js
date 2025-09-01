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
//   * **Sanitisation of hidden/alert tab content** — Tab HTML is now
//     cleaned to remove hidden alert banners and other UI noise (e.g.
//     “Product is already in the cart”, “Add to Favorites” messages).

import { load as loadHTML } from 'cheerio';

// Normalise whitespace and trim.  Converts any sequence of whitespace
// characters into a single space and trims leading/trailing spaces.
const norm = (t = '') => String(t).replace(/\s+/g, ' ').trim();

/**
 * Extract both inner HTML and text for a cheerio element.  Returns an
 * object with `html` and `text` properties.  If either is absent,
 * returns an empty string for that field.  Whitespace is normalised.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @param {Cheerio} el The element to extract from
 * @returns {{html: string, text: string}}
 */
function extractHtmlAndText($, el) {
  const html = norm($(el).html() || '');
  const text = norm($(el).text() || '');
  return { html, text };
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
  const _$ = loadHTML(html || '');
  const items = [];
  _$('ul li, ol li').each((_, li) => {
    const txt = norm(_$(li).text());
    if (txt) items.push(txt);
  });
  return items;
}

/**
 * Extract tab or accordion content from a static HTML document using
 * multiple strategies.  Each extracted entry has a title, the raw
 * HTML of the content pane, the plain text, and a `source` tag
 * indicating which heuristic matched.  Sources include:
 *   - `woocommerce`: for WooCommerce product tabs
 *   - `bootstrap`: for Bootstrap/ARIA tab controls
 *   - `generic`: for generic tab or accordion structures
 *   - `heuristic`: for sections matching labels like “What’s in the Box”
 *     or “Products Include” even if not part of an explicit tab widget
 *
 * @param {CheerioAPI} $ The cheerio instance for the document
 * @returns {{title: string, html: string, text: string, source: string}[]}
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
      const title = titles[id] || norm($(p).attr('aria-label') || $(p).find('h2,h3,h4').first().text());
      const { html, text } = extractHtmlAndText($, p);
      if (html || text) results.push({ title, html, text, source: 'woocommerce' });
    });
  });
  // 2) Bootstrap/ARIA tabs
  const navTitles = {};
  $('.nav-tabs, [role="tablist"]').find('a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const id = href.startsWith('#') ? href.slice(1) : href;
    if (id) navTitles[id] = norm($a.text());
  });
  $('.tab-content .tab-pane').each((_, pane) => {
    const id = $(pane).attr('id');
    const title = navTitles[id] || norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
    const { html, text } = extractHtmlAndText($, pane);
    if (html || text) results.push({ title, html, text, source: 'bootstrap' });
  });
  // 3) Generic tab/accordion fallback: heading followed by content until next heading
  const genericContainers = findTabCandidates($);
  genericContainers.forEach(cont => {
    const $cont = $(cont);
    $cont.find('h2, h3, h4').each((_, h) => {
      const title = norm($(h).text());
      const frag = $(' ');
      let sib = $(h).next();
      while (sib.length && !/H2|H3|H4/.test((sib.prop('tagName') || ''))) {
        frag.append(sib.clone());
        sib = sib.next();
      }
      const { html, text } = extractHtmlAndText($, frag);
      if ((html || text) && title) results.push({ title, html, text, source: 'generic' });
    });
  });
  // 4) Heuristic sections based on labels (even outside explicit tabs)
  const wanted = [
    /products?\s+include/i,
    /what'?s?\s+in\s+the\s+box/i,
    /\b(inclusions?|package\s+contents?)\b/i,
    /\b(specs?|specifications?)\b/i,
    /\bfeatures?\b/i
  ];
  $('section, div, article').each((_, sec) => {
    const heading = norm($(sec).find('h2,h3,h4').first().text());
    if (heading && wanted.some(rx => rx.test(heading))) {
      const { html, text } = extractHtmlAndText($, sec);
      if (html || text) results.push({ title: heading, html, text, source: 'heuristic' });
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
      const _$ = loadHTML(html);
      const body = _$('#main, article, .entry-content, body').first();
      const h = norm(body.html() || '');
      const t = norm(body.text() || '');
      if (h || t) out.push({ title: title || norm(_$('h1,h2').first().text()), html: h, text: t, source: 'remote' });
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
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
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
 * Remove unwanted markup from tab HTML.  This helper strips hidden
 * notification banners and other non-content elements (e.g. global alert
 * messages) which can leak into the scraped data.  It uses cheerio to
 * parse and prune the fragment before returning it.
 *
 * @param {string} html Raw HTML fragment of a tab
 * @returns {string} Sanitised HTML fragment
 */
function sanitizeTabHtml(html) {
  const $ = loadHTML(html || '');
  // Remove Drive Medical UI alerts and hidden notification containers
  $('.global-alerts, .favorite-success, .favorite-error, #favoriteSuccessMsg, #favoriteErrorMsg, #favoriteRemoveSuccessMsg, #favoriteRemoveErrorMsg, .fullpage-image, .fullPage-image, .full-image, .product-thumbnail-images').remove();
  // Remove elements that are hidden via CSS or the hidden attribute
  $('[hidden]').remove();
  $('[style*=\'display:none\']').remove();
  $('[style*=\'display: none\']').remove();
  return $('body').html() || $.root().html() || '';
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
 * @returns {Promise<{tabs: {title: string, html: string, text: string, source: string}[], includedItems: string[], productsInclude: string[]}>}
 */
export async function harvestTabsFromHtml(html, baseUrl) {
  const $ = loadHTML(html);
  // Extract all tab content in the current document
  const inDoc = extractTabsFromDoc($);
  // Fetch remote tab content if any
  const remote = await maybeFetchRemoteTabs($);
  let tabs = [...inDoc, ...remote];
  // Sanitize each tab's HTML and recompute its text to strip hidden alerts
  tabs = tabs.map(t => {
    const cleanHtml = sanitizeTabHtml(t.html);
    const _$ = loadHTML(cleanHtml || '');
    const cleanText = norm(_$.text() || '');
    return { ...t, html: cleanHtml, text: cleanText };
  });
  // Parse lists from tabs
  const includedItems = [];
  const productsInclude = [];
  for (const t of tabs) {
    if (/what'?s?\s+in\s+the\s+box/i.test(t.title)) {
      includedItems.push(...listItemsFromHtml(t.html));
    }
    if (/products?\s+include/i.test(t.title)) {
      productsInclude.push(...listItemsFromHtml(t.html));
    }
  }
  // Deduplicate and normalise
  const uniq = a => Array.from(new Set((a || []).filter(Boolean)));
  const normIncluded = normalizeIncluded(uniq(includedItems));
  const normProducts = normalizeIncluded(uniq(productsInclude));
  return {
    tabs,
    includedItems: normIncluded,
    productsInclude: normProducts
  };
}
