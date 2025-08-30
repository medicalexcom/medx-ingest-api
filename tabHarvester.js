// tabHarvester.js
// This module provides a utility to scrape tabbed or accordion content from
// static HTML documents. It is designed to support a wide range of
// implementations, including WooCommerce product tabs, Bootstrap/ARIA
// tab interfaces, generic tab/accordion widgets, and heuristic sections
// such as "What's in the Box" or "Products Include". The output
// includes a list of tab entries (title, html, text, source) and
// specialized arrays for items found in "What's in the Box" and
// "Products Include" sections.

import { load as loadHTML } from "cheerio";

// Normalize whitespace and trim. Converts any sequence of whitespace
// characters into a single space and trims leading/trailing spaces.
const norm = (t = "") => String(t).replace(/\s+/g, " ").trim();

/**
 * Extract both inner HTML and text for a cheerio element. Returns an
 * object with `html` and `text` properties. If either is absent,
 * returns an empty string for that field. Whitespace is normalized.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @param {Cheerio<Element>} el The element to extract from
 * @returns {{html: string, text: string}}
 */
function extractHtmlAndText($, el) {
  const html = norm($(el).html() || "");
  const text = norm($(el).text() || "");
  return { html, text };
}

/**
 * Deduplicate tab/accordion container nodes. Given an array of
 * candidate elements, remove duplicates based on tag name and class
 * combination. This helps avoid redundant processing of the same
 * container.
 *
 * @param {Cheerio<Element>[]} candidates Array of candidate nodes
 * @param {CheerioAPI} $ The cheerio instance
 * @returns {Cheerio<Element>[]}
 */
function dedupeCandidates(candidates, $) {
  const set = new Set();
  const out = [];
  for (const el of candidates) {
    const tag = $(el).prop("tagName") || "";
    const cls = $(el).attr("class") || "";
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
 * content hidden in tabs or accordions. It aggregates selectors from
 * WooCommerce, Bootstrap/ARIA tab controls, generic tab widgets,
 * Divi/Elementor-like tabs, and accordion structures. The returned
 * array may contain duplicates which should be filtered via
 * `dedupeCandidates`.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @returns {Cheerio<Element>[]}
 */
function findTabCandidates($) {
  const candidates = [];
  // WooCommerce tabs and panels
  candidates.push(...$(".woocommerce-tabs, .wc-tabs, .woocommerce-Tabs-panel").toArray());
  // Bootstrap or ARIA tab lists
  candidates.push(...$(".nav-tabs, [role='tablist']").toArray());
  if ($(".tab-content .tab-pane").length) {
    candidates.push(...$(".tab-content").toArray());
  }
  // Generic tabs/accordions used by various WP builders
  candidates.push(...$(".tabs, .tabset, .tabbed, .et_pb_tabs").toArray());
  candidates.push(...$(".accordion, .et_pb_accordion, .wp-block-coblocks-accordion").toArray());
  return dedupeCandidates(candidates, $);
}

/**
 * Parse all list items within a block of HTML. Returns an array of
 * strings representing the textual content of each list item. Used
 * primarily to extract parts lists from "What's in the Box" and
 * "Products Include" sections.
 *
 * @param {string} html The HTML fragment to parse
 * @returns {string[]}
 */
function listItemsFromHtml(html) {
  const _$ = loadHTML(html || "");
  const items = [];
  _$("ul li, ol li").each((_, li) => {
    const txt = norm(_$(li).text());
    if (txt) items.push(txt);
  });
  return items;
}

/**
 * Extract tab or accordion content from a static HTML document using
 * multiple strategies. Each extracted entry has a title, the raw
 * HTML of the content pane, the plain text, and a `source` tag
 * indicating which heuristic matched. Sources include:
 * - `woocommerce`: for WooCommerce product tabs
 * - `bootstrap`: for Bootstrap/ARIA tab controls
 * - `generic`: for generic tab or accordion structures
 * - `heuristic`: for sections matching labels like "What's in the Box"
 *   or "Products Include" even if not part of an explicit tab widget
 *
 * @param {CheerioAPI} $ The cheerio instance for the document
 * @returns {{title: string, html: string, text: string, source: string}[]}
 */
function extractTabsFromDoc($) {
  const results = [];
  // 1) WooCommerce tabs (ul.wc-tabs / .woocommerce-Tabs-panel)
  $(".woocommerce-tabs").each((_, cont) => {
    const $cont = $(cont);
    const titles = {};
    $cont.find("ul.wc-tabs li a[href]").each((_, a) => {
      const $a = $(a);
      const href = $a.attr("href") || "";
      const id = href.startsWith("#") ? href.slice(1) : href;
      if (id) titles[id] = norm($a.text());
    });
    $cont.find(".woocommerce-Tabs-panel").each((_, p) => {
      const id = $(p).attr("id");
      const title = titles[id] || norm($(p).attr("aria-label") || $(p).find("h2,h3,h4").first().text());
      const { html, text } = extractHtmlAndText($, p);
      if (html || text) results.push({ title, html, text, source: "woocommerce" });
    });
  });
  // 2) Bootstrap/ARIA tabs
  const navTitles = {};
  $(".nav-tabs, [role='tablist']").find("a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") || "";
    const id = href.startsWith("#") ? href.slice(1) : href;
    if (id) navTitles[id] = norm($a.text());
  });
  $(".tab-content .tab-pane").each((_, pane) => {
    const id = $(pane).attr("id");
    const title = navTitles[id] || norm($(pane).attr("aria-label") || $(pane).find("h2,h3,h4").first().text());
    const { html, text } = extractHtmlAndText($, pane);
    if (html || text) results.push({ title, html, text, source: "bootstrap" });
  });
  // 3) Generic tab/accordion fallback: heading followed by content until next heading
  const genericContainers = findTabCandidates($);
  genericContainers.forEach(cont => {
    const $cont = $(cont);
    $cont.find("h2, h3, h4").each((_, h) => {
      const title = norm($(h).text());
      const frag = $("<div></div>");
      let sib = $(h).next();
      while (sib.length && !/H2|H3|H4/.test((sib.prop("tagName") || ""))) {
        frag.append(sib.clone());
        sib = sib.next();
      }
      const { html, text } = extractHtmlAndText($, frag);
      if ((html || text) && title) results.push({ title, html, text, source: "generic" });
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
  $("section, div, article").each((_, sec) => {
    const heading = norm($(sec).find("h2,h3,h4").first().text());
    if (heading && wanted.some(rx => rx.test(heading))) {
      const { html, text } = extractHtmlAndText($, sec);
      if (html || text) results.push({ title: heading, html, text, source: "heuristic" });
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
 * Fetch remote tabs when tab controls reference external URLs. Some tab
 * frameworks allow content panes to be loaded via AJAX (e.g., data-remote
 * or data-url attributes) or via anchor tags pointing to absolute URLs.
 * This helper fetches those remote pages and extracts their primary
 * content. The fetch is guarded by a timeout to avoid hanging
 * requests. If a request fails, it is silently ignored.
 *
 * @param {CheerioAPI} $ The cheerio instance for the main document
 * @returns {Promise<{title: string, html: string, text: string, source: string}[]>}
 */
async function maybeFetchRemoteTabs($) {
  const links = [];
  $("[data-remote],[data-url],[role='tablist'] a[href], .nav-tabs a[href]").each((_, a) => {
    const $a = $(a);
    const u = $a.attr("data-remote") || $a.attr("data-url") || $a.attr("href");
    if (u && !u.startsWith("#") && /^https?:/i.test(u)) {
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
      const body = _$("#main, article, .entry-content, body").first();
      const h = norm(body.html() || "");
      const t = norm(body.text() || "");
      if (h || t) out.push({ title: title || norm(_$("h1,h2").first().text()), html: h, text: t, source: "remote" });
    } catch {
      // Ignore fetch or parse errors silently
    }
  }
  return out;
}

/**
 * Harvest tabs and lists from a full HTML document. This is the main
 * exported function of this module. It orchestrates the local
 * extraction of tabs and remote fetches, then post-processes the
 * results to produce specialized arrays for "What's in the Box"
 * (includedItems) and "Products Include" (productsInclude). All
 * returned arrays are de-duplicated.
 *
 * @param {string} html The full HTML document to parse
 * @param {string} baseUrl The base URL of the document (used for
 *   constructing absolute URLs when needed)
 * @returns {Promise<{tabs: {title: string, html: string, text: string, source: string}[], includedItems: string[], productsInclude: string[]}>}
 */
export async function harvestTabsFromHtml(html, baseUrl) {
  const $ = loadHTML(html);
  // Extract all tab content in the current document
  const inDoc = extractTabsFromDoc($);
  // Fetch remote tab content if any
  const remote = await maybeFetchRemoteTabs($);
  const tabs = [...inDoc, ...remote];
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
  // Deduplicate lists
  const uniq = a => Array.from(new Set(a.filter(Boolean)));
  return {
    tabs,
    includedItems: uniq(includedItems),
    productsInclude: uniq(productsInclude),
  };
}
