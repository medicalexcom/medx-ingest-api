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
 * Extract raw HTML, cleaned HTML and plain text from a DOM element.
 *  - rawHtml: original innerHTML of the element.
 *  - html: cleaned HTML with non-content tags removed but preserving
 *          structural tags (e.g. paragraphs, lists).
 *  - text: plain text derived from the cleaned HTML.
 *
 * @param {CheerioAPI} $ - The cheerio instance representing the original document.
 * @param {CheerioElement} el - The element to extract HTML and text from.
 */
export function extractHtmlAndText($, el) {
  // Preserve original inner HTML.
  const rawHtml = $(el).html() || '';

  // Load a copy into a new cheerio instance for cleaning.
  const $clean = cheerioLoad(rawHtml || '');

  // Remove non-content elements: scripts, styles and forms.
  $clean('script, style, noscript').remove();
  $clean('form, .mktoForm, .g-recaptcha').remove();

  // Remove cookie banners, privacy notices, modals, alerts, etc.
  $clean('.cookie, .cookie-banner, .cookie-consent, .cookie__banner').remove();
  $clean('#cookieBanner, #cookie-banner, #cookie-consent').remove();
  $clean('.modal, .modal-dialog, .privacy, .privacy-notice, .alert, .alert-warning').remove();

  // Remove nav/header/footer/aside wrappers that aren’t part of the product content.
  $clean('header, nav, footer, aside').remove();

  // Remove hidden elements.
  $clean('[style*="display:none"], [style*="visibility: hidden"], [hidden], [aria-hidden="true"]').remove();

  // Get the cleaned HTML (preserving <p>, <ul>, <li>, etc.).
  const cleanedHtml = $clean.root().html() || '';

  // Strip tags to get plain text and normalise whitespace.
  const htmlText = stripTags(cleanedHtml);
  const text = norm(htmlText);

  return {
    rawHtml,
    html: cleanedHtml.trim(),
    text
  };
}

import { load } from 'cheerio';

export function sanitizeRawHtml(rawHtml = '') {
  const $ = load(rawHtml, { decodeEntities: true });

  // remove unwanted markup, modals, forms, pop‑ups, etc.
  const junkSelectors = [
    'script', 'style', 'link', 'iframe', 'noscript', 'svg', 'canvas',
    'form', 'input', 'button', 'select', 'option',
    '[id*="contact"]', '[class*="contact"]', '[id*="sales"]', '[class*="sales"]',
    '[class*="modal"]', '[class*="popup"]', '[class*="banner"]',
    '[class*="cookie"]', '[id*="cookie"]',
    '[id*="captcha"]', '[class*="captcha"]', '[class*="mkto"]',
    '[role="dialog"]'
  ];
  $(junkSelectors.join(',')).remove();

  // remove hidden elements
  $('[hidden], [aria-hidden="true"], [style*="display:none"], [style*="visibility: hidden"]').remove();

  // strip inline handlers and unwanted attributes
  $('*').each((_, el) => {
    const $el = $(el);
    Object.keys(el.attribs || {}).forEach(attr => {
      if (/^on[a-z]+/.test(attr) || attr === 'style' || attr.startsWith('data-') || attr.startsWith('aria-')) {
        $el.removeAttr(attr);
      }
    });
  });

  // remove Prop 65 and generic WARNINGS
  $('p:contains("Proposition 65"), p:contains("WARNING")').remove();

  // drop empty elements
  $('*').each((_, el) => {
    const $el = $(el);
    if (!$el.text().trim() && !$el.find('img,a,li,table').length) {
      $el.remove();
    }
  });

  // decode escaped unicode and collapse whitespace
  let cleaned = $.html()
    .replace(/\\u003C/g, '<')
    .replace(/\\u003E/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003D/g, '=')
    .replace(/\\u0022/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

