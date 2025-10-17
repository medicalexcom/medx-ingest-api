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

  // 1) Fast removals by tag/role/class and obvious overlays
  $(NOISE_SELECTOR).remove();

  // 2) Strip comments
  $('*').contents().each((_, node) => {
    if (node.type === 'comment') $(node).remove();
  });

  // 3) Heuristic boilerplate removal
  removeBoilerplateHeuristics($);

  // 4) Replace <header>/<footer> that survive with their text if they look content-like; else remove
  $('header, footer').each((_, el) => {
    const $el = $(el);
    const ld = linkDensity($, el);
    const textLen = norm($el.text()).length;
    if (ld > 0.6 || textLen < 40) {
      $el.remove();
    } else {
      $el.replaceWith(`<p>${norm($el.text())}</p>`);
    }
  });

  // 5) Remove non-allowed tags by unwrapping (keep their text)
  $('*').each((_, el) => {
    const tag = el.tagName && el.tagName.toLowerCase();
    if (!tag) return;
    if (!ALLOW_TAGS.has(tag)) {
      const $el = $(el);
      // Convert <img> to its alt text if present; otherwise drop
      if (tag === 'img') {
        const alt = norm($el.attr('alt') || '');
        $el.replaceWith(alt ? alt : '');
      } else {
        $el.replaceWith($el.text());
      }
    }
  });

  // 6) Attribute scrubbing
  scrubAttributes($);

  // 7) Normalise excessive whitespace and empty nodes
  // - collapse consecutive <br>s
  $('br + br').remove();
  // - drop empty paragraphs/list items
  $('p,li,dt,dd,th,td').each((_, el) => {
    if (!norm(cheerioLoad.outerHTML ? cheerioLoad.outerHTML(el) : $(el).text())) {
      if (!norm($(el).text())) $(el).remove();
    }
  });

  // 8) Final tidy HTML string
  let html = $.root().html() || '';
  html = html.replace(/\u00A0/g, ' ');     // nbsp → space
  html = html.replace(/[ \t]+\n/g, '\n');  // trim right
  html = html.replace(/\n{3,}/g, '\n\n');  // collapse blank lines

  return html.trim();
}

/**
 * Given a Cheerio context and a node, return { rawHtml, html, text } with
 * consistent semantics across the codebase.
 */
export function extractHtmlAndText($, node) {
  const rawHtml = outerHtml($, node);
  const cleanedHtml = sanitizeRawHtml(rawHtml);
  const text = norm(stripTags(cleanedHtml));
  return { rawHtml, html: cleanedHtml, text };
}
