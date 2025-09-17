import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Wix product pages.
 * Handles Wix-specific tab structures and falls back to Bootstrap/ARIA tab patterns.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractWixTabs($) {
  const results = [];

  // Wix tab menu items and panels identified by data-hook attributes
  const titles = [];
  // Collect titles in order
  $('[data-hook="tabs-menu"] [data-hook="tab-item"]').each((_, el) => {
    const $el = $(el);
    const title = norm($el.text());
    if (title) titles.push(title);
  });

  // Collect tab content panels in order and map to titles
  const panels = $('[data-hook="tabs-menu"]').nextAll('[data-hook="tab-content"]').first().children();
  if (panels.length) {
    panels.each((index, pane) => {
      const title = titles[index] || `Tab ${index + 1}`;
      const { rawHtml, html, text } = extractHtmlAndText($, pane);
      if (html || text) results.push({ title, html, rawHtml, text, source: 'wix' });
    });
  }

  // Fallback: generic tab panels using role or Bootstrap classes
  if (results.length === 0) {
    const navTitles = {};
    $('[role="tab"] a[href], .nav-tabs li a[href]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const id = href.startsWith('#') ? href.slice(1) : href;
      if (id) navTitles[id] = norm($a.text());
    });
    $('.tab-content .tab-pane').each((_, pane) => {
      const id = $(pane).attr('id');
      const title = navTitles[id] || norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
      const { rawHtml, html, text } = extractHtmlAndText($, pane);
      if (html || text) results.push({ title, html, rawHtml, text, source: 'wix' });
    });
  }

  return results;
}
