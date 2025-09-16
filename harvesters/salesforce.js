import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Salesforce/Lightning tabsets or forceCommunity pages.
 * Handles both standard ARIA panels and Lightning-specific tab containers.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{id: string, title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSalesforceTabs($) {
  const out = [];

  $('[role="tablist"]').each((_, tablist) => {
    const titles = {};

    // Map each tab control to its panel ID
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

    // Find the container around the panels
    const $container = $(tablist).closest('[class*=tabset], .js-tabset').first();
    const panelRoot = $container.length ? $container : $(tablist).parent();

    // Collect panels: look for both ARIA panels and Lightning-specific containers
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

        // Extract raw and cleaned HTML + text
        const { rawHtml, html, text } = extractHtmlAndText($, pane);

        if (html || text) {
          out.push({ id, title, html, rawHtml, text, source: 'salesforce' });
        }
      });
  });

  return out;
}
