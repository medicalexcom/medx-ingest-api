import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Salesforce/Lightning tabsets or forceCommunity pages.
 * Uses both [role="tabpanel"] and Lightning-specific data-target-selection-name attributes.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{id: string, title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSalesforceTabs($) {
  const out = [];

  $('[role="tablist"]').each((_, tablist) => {
    const titles = {};

    // Map each tab to its ID (href, aria-controls, or data-target-selection-name)
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

    // Find the container around the panel bodies
    const $container = $(tablist).closest('[class*=tabset], .js-tabset').first();
    const panelRoot = $container.length ? $container : $(tablist).parent();

    // Collect *all* panels: Lightning renders some with data-target-selection-name instead of role="tabpanel"
    panelRoot
      .find('[role="tabpanel"], div[data-target-selection-name]')
      .each((__, pane) => {
        const $pane = $(pane);
        const id =
          $pane.attr('id') || $pane.attr('data-target-selection-name') || '';

        let title =
          titles[id] ||
          norm(
            $pane.attr('aria-label') ||
            $pane.find('h2,h3,h4').first().text()
          );
        if (!title) {
          const index = out.length + 1;
          title = `Tab ${index}`;
        }

        // Use extractHtmlAndText to get raw and sanitised content
        const { rawHtml, html, text } = extractHtmlAndText($, pane);

        if (html || text) {
          out.push({ id, title, html, rawHtml, text, source: 'salesforce' });
        }
      });
  });

  return out;
}
