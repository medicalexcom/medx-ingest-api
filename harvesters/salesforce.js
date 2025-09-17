import { norm, extractHtmlAndText } from './common.js';

/**
 * Extract tabs from Salesforce/Lightning tabsets or forceCommunity pages.
 * Assigns tab titles by index to handle numeric IDs (e.g. "439:0") and
 * handles both ARIA panels and Lightning-specific tab containers.
 *
 * @param {CheerioAPI} $ cheerio instance
 * @returns {{id: string, title: string, html: string, rawHtml: string, text: string, source: string}[]}
 */
export function extractSalesforceTabs($) {
  const out = [];

  $('[role="tablist"]').each((_, tablist) => {
    // Capture tab titles in the order they appear
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
    const panelRoot = $container.length
      ? $container
      : $(tablist).parent();

    // Collect panels in order and assign titles by index
    panelRoot
      .find('[role="tabpanel"], div[data-target-selection-name]')
      .each((index, pane) => {
        const $pane = $(pane);
        const id =
          $pane.attr('id') ||
          $pane.attr('data-target-selection-name') ||
          '';

        // Use the title at the same index, or fall back to the panel’s own heading
        let title =
          titlesArr[index] ||
          norm(
            $pane.attr('aria-label') ||
              $pane.find('h2,h3,h4').first().text()
          );
        if (!title) {
          title = `Tab ${index + 1}`;
        }

        const { rawHtml, html, text } = extractHtmlAndText($, pane);

        if (html || text) {
          out.push({
            id,
            title,
            html,
            rawHtml,
            text,
            source: 'salesforce',
          });
        }
      });
  });

  return out;
}
