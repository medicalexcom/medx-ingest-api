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
