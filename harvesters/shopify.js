import { norm, extractHtmLandText } from './common.js';

/**
 * Extract tabs from Shopify pages.
 *
 * Handles tabs defined by <ul class="tabs"> structures or accordion sections.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractShopifyTabs($) {
  const results = [];
  // Handle <ul class="tabs"> pattern
  $('ul.tabs li a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const id = href.startsWith('#') ? href.slice(1) : href;
    if (!id) return;
    const title = norm($a.text());
    const $pane = $('#' + id);
    if ($pane.length) {
      const { rawHtml, html, text } = extractHtmLandText($, $pane);
      if (html || text) {
        results.push({ title, html, rawHtml, text, source: 'shopify' });
      }
    }
  });
  // Handle accordion panels (e.g. Shopify themes)
  $('.accordion__panel').each((_, panel) => {
    const $panel = $(panel);
    // Find the nearest preceding header or use first heading inside
    let title = norm($panel.prev('.accordion__header').text() || $panel.find('h2,h3,h4').first().text());
    const { rawHtml, html, text } = extractHtmLandText($, panel);
    if ((html || text) && title) {
      results.push({ title, html, rawHtml, text, source: 'shopify' });
    }
  });
  return results;
}
