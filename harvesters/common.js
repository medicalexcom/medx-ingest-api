// common.js
import { load as cheerioLoad } from 'cheerio';

/** Strip all tags and normalise whitespace into single spaces. */
export function stripTags(html = '') {
  const $ = cheerioLoad(html || '');
  return $.root().text().replace(/\s+/g, ' ').trim();
}

/** Normalise whitespace and trim. */
export const norm = (t = '') => String(t).replace(/\s+/g, ' ').trim();

/** Escape-hatch: allowed structural tags we keep in the cleaned HTML. */
const ALLOW_TAGS = new Set([
  'article','section','main',
  'h1','h2','h3','h4','h5','h6',
  'p','ul','ol','li','dl','dt','dd',
  'blockquote','pre','code',
  'table','thead','tbody','tfoot','tr','th','td',
  'figure','figcaption','hr','br','a'
]);

/** Quick selectors that are almost always noise. */
const NOISE_SELECTOR = [
  // scripts, styles, boilerplate containers
  'script','style','template','noscript','canvas','svg','picture','source','iframe','object','embed','video','audio',
  // forms / UI
  'form','input','select','textarea','button','label',
  // common chrome
  'aside','nav','[role="navigation"]','[role="search"]','[role="banner"]','[role="complementary"]',
  '[aria-modal="true"]','[aria-hidden="true"]','.modal','.overlay',
  // social / share / comments
  '.share','.sharing','.social','.addthis','.comments','.comment','[aria-label*="share" i]',
  // promos / ads / sponsors
  '[class*="ad-"]','.ads','.advert','.advertisement','.sponsor','.sponsored','.promo',
  // cookie / consent / newsletter
  '.cookie','.cookies','.consent','.gdpr','.newsletter','.subscribe','.subscription',
  // breadcrumbs/pagination (boilerplate)
  '.breadcrumb','.breadcrumbs','.pagination',
].join(',');

/** Class/ID regexes for drop decisions. */
const KILL_CLASS_ID_RX = new RegExp([
  'cookie','consent','gdpr','newsletter','subscribe','promo','advert','sponsor',
  'banner','popup','modal','overlay','tooltip','share','social',
  'breadcrumb','breadcrumbs','pagination',
  'nav','navbar','site-nav','menu','sidebar','widget',
  'disclaimer','legal','terms','privacy','tracking'
].join('|'), 'i');

/** Boilerplate text snippets to filter tiny blocks. */
const BOILERPLATE_TEXT_RX = new RegExp([
  'accept (all )?cookies','we use cookies','manage preferences',
  'subscribe','newsletter','sign up','sign in','log in',
  'share (this|on)','related (articles|posts)','back to top','skip to content',
  'read more','recommended','sponsored'
].join('|'), 'i');

/** Utility: get outerHTML of a Cheerio element. */
function outerHtml($, el) {
  const wrap = $('<div/>');
  wrap.append($(el).clone());
  return wrap.html() || '';
}

/** Remove noisy attributes; keep only meaningful ones. */
function scrubAttributes($) {
  $('*').each((_, el) => {
    const keep = new Set(['href','colspan','rowspan','scope']);
    for (const [name] of Object.entries(el.attribs || {})) {
      const lower = name.toLowerCase();
      if (keep.has(lower)) continue;
      if (lower.startsWith('on')) { $(el).removeAttr(name); continue; } // onclick, etc.
      if (lower === 'style' || lower.startsWith('data-') || lower === 'id' || lower === 'class' ||
          lower === 'aria-hidden' || lower === 'aria-modal') {
        $(el).removeAttr(name);
      }
    }
  });
}

/** Link density: ratio of link text to total text in an element. */
function linkDensity($, el) {
  const $el = $(el);
  const t = norm($el.text() || '');
  if (!t) return 0;
  const lt = norm($el.find('a').text() || '');
  return lt.length / t.length;
}

/** Heuristic removal of low-value blocks. */
function removeBoilerplateHeuristics($) {
  const toCheck = $('div,section,aside,header,footer,ul,ol').toArray();
  for (const el of toCheck) {
    const $el = $(el);
    const textLen = norm($el.text()).length;
    const clsid = `${$el.attr('class')||''} ${$el.attr('id')||''}`;
    const aria = `${$el.attr('role')||''} ${$el.attr('aria-label')||''}`;

    const ld = linkDensity($, el);
    const hasHidden =
      $el.is('[hidden]') ||
      /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|clip|left:\s*-\d+/i.test($el.attr('style') || '');
    const classIdMatch = KILL_CLASS_ID_RX.test(clsid) || /(navigation|banner|complementary|menu|toolbar|search)/i.test(aria);
    const tinyAndBoiler = textLen < 120 && BOILERPLATE_TEXT_RX.test($el.text());

    // Drop if: nav-like OR hidden OR mostly links OR tiny boilerplate
    if (classIdMatch || hasHidden || (ld > 0.6 && textLen < 600) || tinyAndBoiler) {
      $el.remove();
    }
  }
}

/**
 * Sanitize a fragment of HTML while preserving meaningful structure (P/H/LIs/etc).
 * Returns cleaned HTML as a string.
 */
export function sanitizeRawHtml(rawHtml = '') {
  if (!rawHtml) return '';
  const $ = cheerioLoad(rawHtml);

  // 1️⃣ Quick nukes — obvious boilerplate or UI components
  $([
    'script', 'style', 'template', 'noscript', 'canvas', 'svg', 'iframe', 'object', 'embed', 'video', 'audio',
    'form', 'input', 'select', 'textarea', 'button', 'label',
    '.slick-slider', '.carousel', '.gallery', '.slider', '.image-gallery',
    '.modal', '.popup', '.overlay', '.lightbox',
    '.login', '.signup', '.register', '.contact-form', '.form-group', '.form-control',
    '.cookie', '.consent', '.privacy', '.gdpr',
    '.compare-products', '.breadcrumbs', '.pagination', '.nav', '.navbar', '.site-nav',
    '.footer', '.header', '.banner', '.promo', '.ad', '.advertisement', '.sponsor',
    '.fa-angle-left', '.fa-angle-right', '.btn', '.collapse', '.expand', '.accordion-button',
    '[aria-hidden="true"]', '[hidden]', '[role="navigation"]'
  ].join(',')).remove();

  // 2️⃣ Drop entire divs/sections if they look like cookie or form text
  $('div, section').each((_, el) => {
    const text = ($(el).text() || '').toLowerCase();
    const tag = $(el).prop('tagName')?.toLowerCase() || '';
    const tooManyTags = $(el).find('*').length > 40 && $(el).text().length < 400;
    const cookieish = /cookie|privacy|your preferences|allow cookies|we use cookies/.test(text);
    const formish = /(name\*|zipcode\*|email\*|comments\*|log in|quote|contact sales|submit)/.test(text);
    const navish = /(next|previous|collapse|expand|compare|design your own|download|view alternatives)/.test(text);
    if (tooManyTags || cookieish || formish || navish) $(el).remove();
  });

  // 3️⃣ Keep structural tags only
  const ALLOW_TAGS = new Set([
    'article', 'section', 'main',
    'h1','h2','h3','h4','h5','h6',
    'p','ul','ol','li',
    'table','thead','tbody','tr','th','td',
    'blockquote','pre','code','hr','br','a'
  ]);
  $('*').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (!ALLOW_TAGS.has(tag)) {
      const $el = $(el);
      if (tag === 'img') {
        const alt = $el.attr('alt') || '';
        $el.replaceWith(alt ? alt : '');
      } else {
        $el.replaceWith($el.text());
      }
    }
  });

  // 4️⃣ Drop empty nodes
  $('p, li, div, section, span').each((_, el) => {
    if (!($(el).text() || '').trim()) $(el).remove();
  });

  // 5️⃣ Remove repeated lines, normalize whitespace
  let html = $.root().html() || '';
  html = html
    .replace(/\u00A0/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(Collapse|Expand|Next|Previous|Log in.*|Submit|Download.*|Add to Compare.*)/gi, '')
    .trim();

  return html;
}

