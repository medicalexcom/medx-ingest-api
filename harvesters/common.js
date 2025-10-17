import { load as cheerioLoad } from 'cheerio';

/**
 * Strip all HTML tags and normalize whitespace. When sanitising markup
 * we still want to preserve the text content but drop all tags.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripTags(html = '') {
  const $ = cheerioLoad(html || '');
  return $.root().text().replace(/\s+/g, ' ').trim();
}

// Normalize whitespace and trim.
export const norm = (t = '') => String(t).replace(/\s+/g, ' ').trim();

/**
 * Extract the raw inner HTML, a sanitised version of that HTML (tags stripped),
 * and the plain text for a cheerio element. The raw HTML is preserved for
 * downstream consumers that need structural markup (e.g. list extraction),
 * while the sanitised HTML removes all tags. The text property normalises whitespace.
 *
 * @param {CheerioAPI} $ The cheerio instance
 * @param {Cheerio} el The element to extract from
 * @returns {{rawHtml: string, html: string, text: string}}
 */
export function extractHtmlAndText($, el) {
  const rawHtml = $(el).html() || '';
  const html = stripTags(rawHtml);
  const text = norm($(el).text() || '');
  return { rawHtml, html, text };
}
