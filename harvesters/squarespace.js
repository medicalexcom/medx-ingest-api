import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Squarespace pages.
 * Handles Squarespace-specific tab and accordion structures, and falls back to Bootstrap/ARIA tab patterns.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSquarespaceTabs($) {
  const results = [];

  // Squarespace tab navigation (common CSS classes)
  const navTitles = {};
  $('.sqs-tabs a[href], .tabs-nav a[href], .tab-nav a[href], .nav-tabs a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const id = href.startsWith('#') ? href.slice(1) : href;
    if (id) navTitles[id] = norm($a.text());
  });

  // Squarespace tab content containers
  $('.sqs-tab-content .tab-pane, .tab-content .tab-pane, .tabs-content .tab, .sqs-tabs-content .tab-pane').each((_, pane) => {
    const id = $(pane).attr('id');
    const title = navTitles[id] || norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
    const { rawHtml, html, text } = extractHtmlAndText($, pane);
    if (html || text) results.push({ title, html, rawHtml, text, source: 'squarespace' });
  });

  // Squarespace accordion blocks
  $('.accordion-item, .sqs-block-accordion-item').each((_, item) => {
    const $item = $(item);
    const title = norm($item.find('.accordion-item-title, h3, h4, .sqs-block-title').first().text());
    const content = $item.find('.accordion-item-content, .sqs-block-content').first();
    if (title && content && content.length) {
      const { rawHtml, html, text } = extractHtmlAndText($, content);
      if (html || text) results.push({ title, html, rawHtml, text, source: 'squarespace' });
    }
  });

  return results;
}
