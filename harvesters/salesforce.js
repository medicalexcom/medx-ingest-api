import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Salesforce/Lightning tabsets or forceCommunity pages.
 * Uses [role=tablist] and [role=tabpanel] structure.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSalesforceTabs($) {
  const out = [];

  $('[role="tablist"]').each((_, tablist) => {
    const titles = {};

    $(tablist).find('[role="tab"], a').each((__, el) => {
      const $el = $(el);
      let id = ($el.attr('href') || '').replace(/^#/, '');
      if (!id) {
        id = $el.attr('aria-controls') || $el.attr('data-target-selection-name') || '';
      }
      if (!id) return;

      const title = norm(
        $el.attr('title') ||
        $el.find('.title').text() ||
        $el.text()
      );
      if (title) titles[id] = title;
    });

    const $container = $(tablist).closest('[class*=tabset], .js-tabset').first();
    const panelRoot = $container.length ? $container : $(tablist).parent();

    panelRoot.find('[role="tabpanel"]').each((__, pane) => {
      const id = $(pane).attr('id');
      let title = titles[id] || norm(
        $(pane).attr('aria-label') ||
        $(pane).find('h2,h3,h4').first().text()
      );
      if (!title) {
        const index = out.length + 1;
        title = `Tab ${index}`;
      }

      const { html, text } = extractHtmlAndText($, pane);
      const rawHtml = html;

      if (html || text) {
        out.push({ title, html, rawHtml, text, source: 'salesforce' });
      }
    });
  });

  return out;
}
