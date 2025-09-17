import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Magento product pages.
 * Handles typical Magento tab structures including Magento 2 data tabs and Bootstrap/ARIA tabs.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractMagentoTabs($) {
  const results = [];

  // Magento 2 product data tabs (.product.data.items)
  $('.product.data.items').each((_, cont) => {
    const titles = {};
    $(cont).find('li a[href]').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const id = href.startsWith('#') ? href.slice(1) : href;
      if (id) titles[id] = norm($a.text());
    });
    $(cont).find('.item.content').each((_, pane) => {
      const id = $(pane).attr('id') || '';
      const title = titles[id] || norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
      const { rawHtml, html, text } = extractHtmlAndText($, pane);
      if (html || text) results.push({ title, html, rawHtml, text, source: 'magento' });
    });
  });

  // Fallback: Bootstrap/ARIA nav-tabs
  const navTitles = {};
  $('.nav-tabs li a[href], .nav.nav-tabs li a[href]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const id = href.startsWith('#') ? href.slice(1) : href;
    if (id) navTitles[id] = norm($a.text());
  });
  $('.tab-content .tab-pane').each((_, pane) => {
    const id = $(pane).attr('id');
    const title = navTitles[id] || norm($(pane).attr('aria-label') || $(pane).find('h2,h3,h4').first().text());
    const { rawHtml, html, text } = extractHtmlAndText($, pane);
    if (html || text) results.push({ title, html, rawHtml, text, source: 'magento' });
  });

  return results;
}
