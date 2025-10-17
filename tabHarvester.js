// tabHarvester.js
//
// This module scrapes tabbed or accordion content from static HTML
// documents.  It is based on the upstream `tabHarvester.js` in the
// medx-ingest-api repository but has been extended with the following
// enhancements:
//
//   * **Quantity normalisation** — Items extracted from “What’s in the
//     Box” and “Products Include” lists are parsed for explicit
//     quantities (e.g. “2 × diaphragms”, “two tubes”, “tube (2)”).  The
//     new `normalizeIncluded` helper produces canonical strings of the
//     form `n × item` and aggregates duplicate items.
//
//   * **Full HTML sanitisation** — Integrated with the improved
//     `sanitizeRawHtml()` from `common-3.js`.  Every HTML fragment
//     (local or remote) is cleaned to remove UI noise, cookie banners,
//     login forms, carousels, and other non-content elements, while
//     preserving headings, lists, and tables.  This ensures all
//     extracted `.html` and `.text` fields are production-clean.

import { load as cheerioLoad } from 'cheerio';
import { sanitizeRawHtml, stripTags, norm } from './harvesters/common.js';

// -----------------------------------------------------------------------------
// Selector normalisation helpers
// -----------------------------------------------------------------------------
function normalizeSelector(selector) {
  return String(selector || '')
    .replace(/:eq\(\s*(\d+)\s*\)/g, (_, n) => ':nth-child(' + (Number(n) + 1) + ')')
    .replace(/:(\d+)\b/g, (_, n) => ':nth-child(' + (Number(n) + 1) + ')');
}

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
// HTML/text extraction helper (kept local to this module)
// -----------------------------------------------------------------------------
/**
 * Extract both the cleaned HTML and plain text from a Cheerio element.
 * This now integrates the full sanitizeRawHtml() pipeline.
 * - rawHtml: original fragment
 * - html: sanitised HTML with structure preserved
 * - text: plain text derived from the cleaned HTML
 */
function extractHtmlAndText($, el) {
  const rawHtml = $(el).html() || '';
  // Pass the raw fragment through sanitizeRawHtml to remove UI clutter
  const cleaned = sanitizeRawHtml(rawHtml);
  // Derive text strictly from the cleaned HTML to keep structure logical
  const text = norm(stripTags(cleaned));
  return { rawHtml, html: cleaned, text };
}

// -----------------------------------------------------------------------------
// Candidate and list helpers
// -----------------------------------------------------------------------------
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

function findTabCandidates($) {
  const candidates = [];
  candidates.push(...$('.woocommerce-tabs, .wc-tabs, .woocommerce-Tabs-panel').toArray());
  candidates.push(...($('.nav-tabs, [role="tablist"]').toArray()));
  if ($('.tab-content .tab-pane').length) {
    candidates.push(...$('.tab-content').toArray());
  }
  candidates.push(...($('.tabs, .tabset, .tabbed, .et_pb_tabs').toArray()));
  candidates.push(...($('.accordion, .et_pb_accordion, .wp-block-coblocks-accordion').toArray()));
  return dedupeCandidates(candidates, $);
}

/**
 * Extracts text items from HTML lists. This remains unchanged except
 * for the integration of norm() and stripTags() for consistent cleaning.
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
  let segments = bulletSplit.test(plain) ? plain.split(bulletSplit) : plain.split(/\r?\n/);
  segments.forEach(seg => {
    const trimmed = norm(seg);
    if (trimmed) items.push(trimmed);
  });
  return items;
}

// -----------------------------------------------------------------------------
// Salesforce/forceCommunity extraction
// -----------------------------------------------------------------------------
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
      // Clean the pane before returning
      const { rawHtml, html, text } = extractHtmlAndText($, pane);
      const raw = html; // Salesforce markup often verbose, keep cleaned version
      if (html || text) out.push({ title, html, rawHtml: raw, text, source: 'salesforce' });
    });
  });
  return out;
}

// -----------------------------------------------------------------------------
// Generic and WooCommerce extraction flows
// -----------------------------------------------------------------------------
function extractTabsFromDoc($) {
  const results = [];

  // WooCommerce pattern
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

  // Bootstrap/ARIA tabs
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

  // Salesforce integration
  results.push(...extractSalesforceTabs($));

  // Generic containers (Woo, WP, others)
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

  // Heuristic sections (Features, Specs, What's in Box)
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

  // Deduplicate
  const seen = new Set();
  return results.filter(t => {
    const key = `${t.title}::${t.html.slice(0, 256)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -----------------------------------------------------------------------------
// Remote fetch handling
// -----------------------------------------------------------------------------
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

      // Extract and clean remote content using same sanitiser
      const raw = body.html() || '';
      const cleaned = sanitizeRawHtml(raw);
      const t = norm(stripTags(cleaned));
      if (cleaned || t) {
        const remoteTitle = title || norm(_$('h1,h2').first().text());
        out.push({ title: remoteTitle, html: cleaned, rawHtml: raw, text: t, source: 'remote' });
      }
    } catch {
      // Swallow fetch errors to continue other links
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Quantity normaliser (unchanged)
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Master entry point
// -----------------------------------------------------------------------------
export async function harvestTabsFromHtml(html, baseUrl) {
  const $ = loadHtmlSafe(html);

  // Remove known boilerplate before parsing
  $([
    'body > nav',
    '[role="navigation"]',
    '.site-nav,.nav,.navbar,.nav-bar',
    '.breadcrumbs,.breadcrumb,.pagination',
    '.cookie,.consent,.gdpr,.overlay,.modal',
    '.share,.sharing,.social',
    '.ads,.advert,.advertisement,.sponsor,.sponsored,.promo'
  ].join(',')).remove();

  // Extract local and remote tabs
  const inDoc = extractTabsFromDoc($);
  const remote = await maybeFetchRemoteTabs($);
  const tabs = [...inDoc, ...remote];

  // Identify and normalise "included items" and "products include"
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
