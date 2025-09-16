import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from WordPress-style WooCommerce or Bootstrap structures.
 *
 * Handles:
 * - WooCommerce tabs: .woocommerce-tabs \u2192 ul.wc-tabs / .woocommerce-Tabs-panel
 * - Bootstrap/ARIA tablists: .nav-tabs, [role="tablist"], .tab-content .tab-pane
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractWordPressTabs($) {
  const results = [];

  // WooCommerce-style tabs
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

  return results;
}
