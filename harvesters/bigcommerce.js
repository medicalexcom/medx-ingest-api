import { norm, extractHtmLandText } from './common.js';

/**
 * Extract tabs from BigCommerce product pages.
 *
 * Handles panels with IDs like 'tab-description', 'tab-specifications', and 'tab-documents'.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractBigCommerceTabs($) {
  const results = [];
  const panels = ['description', 'specifications', 'documents'];
  panels.forEach(name => {
    const id = 'tab-' + name;
    const $pane = $('#' + id);
    if ($pane.length) {
      const title = name.charAt(0).toUpperCase() + name.slice(1);
      const { rawHtml, html, text } = extractHtmLandText($, $pane);
      if (html || text) {
        results.push({ title, html, rawHtml, text, source: 'bigcommerce' });
      }
    }
  });
  return results;
}
