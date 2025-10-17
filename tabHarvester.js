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
import { sanitizeRawHtml, stripTags, norm, extractHtmlAndText } from './common.js';

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
  $.prototype.find = function(selector) {
    const safeSelector = typeof selector === 'string' ? normalizeSelector(selector) : selector;
    try {
      return origFind.call(this, safeSelector);
    } catch {
      return origFind.call(this, selector);
    }
  };
  return $;
}

// -----------------------------------------------------------------------------
// Existing helpers

// Normalise whitespace and trim.  Converts any sequence of whitespace
// characters into a single space and trims leading/trailing spaces.
const norm = (t = '') => String(t).replace(/\s+/g, ' ').trim();

/**
 * Extract the raw inner HTML, a sanitised version of that HTML (tags stripped),
 * and the plain text for a cheerio element.  The raw HTML is preserved for
 * downstream consumers that need structural markup (e.g. list extraction),
 * while the sanitised HTML removes all tags to prevent leaking arbitrary
 * markup.  The text property normalises whitespace.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @param {Cheerio} el The element to extract from
 * @returns {{rawHtml: string, html: string, text: string}}
 */
function extractHtmlAndText($, el) {
  const rawHtml = $(el).html() || '';
  const html = stripTags(rawHtml);
  const text = norm($(el).text() || '');
  return { rawHtml, html, text };
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
  candidates.push(...$('.woocommerce-tabs, .wc-tabs, .woocommerce-Tabs-panel').toArray());
  candidates.push(...$('.nav-tabs, [role="tablist"]').toArray());
  if ($('.tab-content .tab-pane').length) {
    candidates.push(...$('.tab-content').toArray());
  }
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
  if (!html) return [];
  const _$ = loadHtmlSafe(html);
  const items = [];
  _$('ul li, ol li').each((_, li) => {
    const txt = norm(_$(li).text());
    if (txt) items.push(txt);
  });
  if (items.length > 0) return items;
  const plain = stripTags(html);
  const bulletSplit = /[\u2022\u2023\u25E6\u2043\u2219\u2027]/;
  let segments = [];
  if (bulletSplit.test(plain)) segments = plain.split(bulletSplit);
  else segments = plain.split(/\r?\n/);
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
  $('[role="tablist"]').each((_, tablist) => {
    const titles = {};
    $(tablist).find('[role="tab"], a').each((__, el) => {
      const $el = $(el);
      let id = ($el.attr('href') || '').replace(/^#/, '');
      if (!id) id = $el.attr('aria-controls') || $el.attr('data-target-selection-name') || '';
      if (!id) return;
      const title = norm($el.attr('title') || $el.find('.title').text() || $el.text());
      if (title) titles[id] = title;
    });
    const $container = $(tablist).closest('[class*=tabset], .js-tabset').first();
    const panelRoot = $container.length ? $container : $(tablist).parent();
    panelRoot.find('[role="tabpanel"]').each((__, pane) => {
      const id = $(pane).attr('id');
      let title = titles[id] || norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
      if (!title) title = `Tab ${out.length + 1}`;
      const { html, text } = extractHtmlAndText($, pane);
      const rawHtml = html;
      if (html || text) out.push({ title, html, rawHtml, text, source: 'salesforce' });
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
      const { rawHtml, html, text } = extractHtmlAndText($, p);
      if (html || text) results.push({ title, html, rawHtml, text, source: 'woocommerce' });
    });
  });
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
    const { rawHtml, html, text } = extractHtmlAndText($, pane);
    if (html || text) results.push({ title, html, rawHtml, text, source: 'bootstrap' });
  });
  results.push(...extractSalesforceTabs($));
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
      const { rawHtml, html, text } = extractHtmlAndText($, frag);
      if ((html || text) && title) results.push({ title, html, rawHtml, text, source: 'generic' });
    });
  });
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
      const { rawHtml, html, text } = extractHtmlAndText($, sec);
      if (html || text) results.push({ title: heading, html, rawHtml, text, source: 'heuristic' });
    }
  });
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
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const _$ = loadHtmlSafe(html);
      const body = _$('#main, article, .entry-content, [role="main"], body').first();
      const raw = body.html() || '';
      const cleaned = sanitizeRawHtml(raw);
      const t = norm(stripTags(cleaned));
      if (cleaned || t) {
        const remoteTitle = title || norm(_$('h1,h2').first().text());
        out.push({
          title: remoteTitle,
          html: cleaned,
          rawHtml: raw,
          text: t,
          source: 'remote'
        });
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
  const NUMWORDS = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
  for (const rawLine of lines) {
    if (!rawLine) continue;
    let s = norm(rawLine);
    s = s.replace(/[×]/g, 'x');
    let qty = 1;
    let item = '';
    let m;
    if ((m = s.match(/^(\d+)\s*x\s*(.+)$/i))) {
      qty = parseInt(m[1],10); item = norm(m[2]);
    } else if ((m = s.match(/^([a-z]+)\s*x\s*(.+)$/i)) && NUMWORDS[m[1].toLowerCase()]) {
      qty = NUMWORDS[m[1].toLowerCase()]; item = norm(m[2]);
    } else if ((m = s.match(/^(\d+)\s+(.+)/i))) {
      qty = parseInt(m[1],10); item = norm(m[2]);
    } else if ((m = s.match(/^([a-z]+)\s+(.+)/i)) && NUMWORDS[m[1].toLowerCase()]) {
      qty = NUMWORDS[m[1].toLowerCase()]; item = norm(m[2]);
    } else if ((m = s.match(/^(.+)\s+x\s*(\d+)$/i))) {
      qty = parseInt(m[2],10); item = norm(m[1]);
    } else if ((m = s.match(/^(.+)\s+\((\d+)\)$/i))) {
      qty = parseInt(m[2],10); item = norm(m[1]);
    } else item = s;
    item = item.replace(/^[\s•\-–—]+/,'').replace(/\s{2,}/g,' ').trim();
    if (!item) continue;
    counts[item]=(counts[item]||0)+(isNaN(qty)?1:qty);
  }
  return Object.entries(counts).map(([name,count])=>`${count} × ${name}`);
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
  $([
    'body > nav',
    '[role="navigation"]',
    '.site-nav,.nav,.navbar,.nav-bar',
    '.breadcrumbs,.breadcrumb,.pagination',
    '.cookie,.consent,.gdpr,.overlay,.modal',
    '.share,.sharing,.social',
    '.ads,.advert,.advertisement,.sponsor,.sponsored,.promo'
  ].join(',')).remove();

  const inDoc = extractTabsFromDoc($);
  const remote = await maybeFetchRemoteTabs($);
  const tabs = [...inDoc, ...remote];

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

  const uniq = a => Array.from(new Set((a || []).filter(Boolean)));
  const normIncluded = normalizeIncluded(uniq(includedItems));
  const normProducts = normalizeIncluded(uniq(productsInclude));
  return { tabs, includedItems: normIncluded, productsInclude: normProducts };
}
