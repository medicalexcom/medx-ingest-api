// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages. It
// collects the fully rendered HTML after interacting with common tab/accordion UI
// elements, extracts visible text, and grabs various sections (description,
// specifications, features, included) as well as outbound links. The result
// is designed to augment the existing static scraper output without
// modifying the existing scraping logic.

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Click selectors attempt to expand tabs, accordions, and other lazy
// sections. Many e‑commerce sites hide important content behind UI
// interactions. These selectors should remain fairly generic; per-site
// customisations can be layered on top if necessary.
const CLICK_SELECTORS = [
  // common tabs/accordions
  'button[aria-controls]',
  '[role="tab"]',
  '[data-toggle="tab"]',
  '.tabs [role="tab"]',
  '.accordion button',
  '.accordion .accordion-button',
  '.accordion .accordion-header',
  'details > summary',
  // generic “show more” patterns
  'button:has-text("Show more")',
  'button:has-text("View more")',
  'button:has-text("Read more")',
  'a:has-text("Show more")',
  'a:has-text("View more")',
  'a:has-text("Read more")',
  // product-specific patterns we often see
  'a:has-text("Specifications")',
  'a:has-text("Features")',
  'a:has-text("Included")',
  'a:has-text("What’s in the box")',
  'button:has-text("Specifications")',
  'button:has-text("Features")',
  'button:has-text("Included")',
];

const WAITERS = [
  '.product-description',
  '#description',
  '#specifications',
  '.specs',
  '.specifications',
  '.features',
  '.accordion',
  '.tabs',
  'main',
  'article',
];

/**
 * Utility to scroll and click through interactive elements on the page.
 * Performs multiple passes to ensure that content hidden behind tabs or
 * accordions is revealed. During each pass the function clicks any
 * matching selectors, waits briefly for content to load, and waits for
 * network activity to settle.
 *
 * @param {import('playwright').Page} page
 */
async function autoExpand(page) {
  for (let pass = 0; pass < 3; pass++) {
    for (const sel of CLICK_SELECTORS) {
      let elements = [];
      try {
        elements = await page.$$(sel);
      } catch {
        // ignore bad selectors on sites that do not support :has
      }
      for (const el of elements) {
        try {
          const box = await el.boundingBox();
          if (!box) continue;
          await el.click({ timeout: 1500 }).catch(() => {});
        } catch {
          /* swallow */
        }
      }
    }
    for (const w of WAITERS) {
      await page.waitForTimeout(300);
      try {
        await page.locator(w).first().waitFor({ timeout: 1200 });
      } catch {
        /* ignore */
      }
    }
    // Wait for network idle to flush any lazy loads
    try {
      await page.waitForLoadState('networkidle');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Extract user-visible text from the document. Cheerio cannot see
 * dynamically rendered content, so we do this in the browser context.
 *
 * @param {import('playwright').Page} page
 */
async function collectVisibleText(page) {
  // Evaluate in browser context to extract visible text.  If the typical
  // main-section extraction yields very little content (e.g. on highly dynamic sites),
  // fall back to the entire body's innerText to capture dynamically rendered content.
  return page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      return (
        style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        el.offsetParent !== null
      );
    }
    function textFrom(el) {
      if (!isVisible(el)) return '';
      const blacklist = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      const chunks = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement || blacklist.has(node.parentElement.tagName)) continue;
        // Skip text inside navigation, header, footer or sidebar elements to reduce noise
        let skip = false;
        let p = node.parentElement;
        while (p) {
          const tag = p.tagName && p.tagName.toLowerCase();
          if (tag && (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside')) { skip = true; break; }
          const cls = p.className ? String(p.className).toLowerCase() : '';
          if (/(\bnav\b|\bheader\b|\bfooter\b|\bsidebar\b|\bbreadcrumb\b|\bmenu\b|\baccount\b)/.test(cls)) { skip = true; break; }
          p = p.parentElement;
        }
        if (skip) continue;
        const t = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) chunks.push(t);
      }
      return chunks.join('\n');
    }
    const main = document.querySelector('main') || document.body;
    const extracted = textFrom(main).trim();
    /*
     * If the initial extraction yields very little text, fall back to the
     * entire document body. Previously this threshold was set to 50
     * characters, which caused the crawler to pick up site‑wide navigation
     * menus when the main element contained a modest amount of text. By
     * increasing the threshold, we reduce the likelihood of falling back
     * unnecessarily and pulling in navigation or sidebar content. The
     * fallback is now only triggered when the main extraction contains
     * fewer than 100 characters.
     */
    if (!extracted || extracted.length < 10) {
      return document.body.innerText.replace(/\s+\n/g, '\n').trim();
    }
    return extracted;
  });
}

/**
 * Gather common product sections by querying the DOM. This is a best effort
 * attempt: if a section is not found the field will be an empty string.
 *
 * @param {import('playwright').Page} page
 */
async function collectSections(page) {
  return page.evaluate(() => {
    const sections = {};
    const map = {
      description: ['#description', '.product-description', '.description', 'section#description'],
      specifications: ['#specifications', '.specs', '.specifications', 'section#specifications'],
      features: ['.features', '#features', 'section#features', 'h2:has(+ ul)', 'h3:has(+ ul)'],
      // Included: avoid invalid text= selectors (handled in fallback below)
      included: ['.included', '#included', 'section#included', '.product-includes'],
    };
    const serialize = (el) => (el ? el.innerText.replace(/\s+\n/g, '\n').trim() : '');
    function findFirst(selectors) {
      for (const s of selectors) {
        try {
          const el = document.querySelector(s);
          if (el) return el;
        } catch (e) {
          // Ignore invalid CSS selectors, and continue checking the next selector.
          continue;
        }
      }
      return null;
    }
    // Description: prefer explicit description nodes; fallback to meta description if empty
    const descEl = findFirst(map.description);
    sections.description = serialize(descEl);
    if (!sections.description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta && meta.content) sections.description = meta.content.trim();
    }
    sections.specifications = serialize(findFirst(map.specifications));
    sections.features = serialize(findFirst(map.features));
    // Fallback: if no features were found by the default selectors, search
    // headings containing “feature” and take the next <ul>/<ol> list as the
    // feature list.  This captures “Features & Benefits” lists without a dedicated selector.
    try {
      if (!sections.features) {
        const headings = Array.from(document.querySelectorAll('h2, h3, h4'));
        for (const h of headings) {
          const txt = (h.innerText || '').trim().toLowerCase();
          if (!txt) continue;
          if (txt.includes('feature')) {
            let el = h.nextElementSibling;
            while (el && !(el.tagName && (/^ul$/i.test(el.tagName) || /^ol$/i.test(el.tagName)))) {
              el = el.nextElementSibling;
            }
            if (el && el.innerText) {
              sections.features = el.innerText
                .replace(/\s+\n/g, '\n')
                .trim();
              break;
            }
          }
        }
      }
    } catch (_) {
      /* swallow */
    }
    sections.included = serialize(findFirst(map.included));

    // Additional fallback: look for any element containing 'feature' or 'benefit'
    // and capture the next UL/OL as the features list.
    if (!sections.features) {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        const t = (el.innerText || '').toLowerCase();
        if (t && (t.includes('feature') || t.includes('benefit'))) {
          let nxt = el.nextElementSibling;
          while (nxt && !(nxt.tagName && (/^ul$/i.test(nxt.tagName) || /^ol$/i.test(nxt.tagName)))) {
            nxt = nxt.nextElementSibling;
          }
          if (nxt && nxt.innerText) {
            sections.features = nxt.innerText.replace(/\s+\n/g, '\n').trim();
            break;
          }
        }
      }
    }

    // Fallback for included: search any element containing 'include' and take the next list
    if (!sections.included) {
      const allEls2 = Array.from(document.querySelectorAll('*'));
      for (const el of allEls2) {
        const t = (el.innerText || '').toLowerCase();
        if (t && t.includes('include')) {
          let nxt = el.nextElementSibling;
          while (nxt && !(nxt.tagName && (/^ul$/i.test(nxt.tagName) || /^ol$/i.test(nxt.tagName)))) {
            nxt = nxt.nextElementSibling;
          }
          if (nxt && nxt.innerText) {
            sections.included = nxt.innerText.replace(/\s+\n/g, '\n').trim();
            break;
          }
        }
      }
    }

    return sections;
  });
}

/**
 * Collect links on the page: anchors, images, PDFs, and JSON resources.
 *
 * @param {import('playwright').Page} page
 */
async function collectLinks(page) {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href]')].map((a) => a.href);
    const imgs = [...document.images].map((i) => i.src);
    // Only keep anchors that link to PDFs. Drop all other anchors to avoid noise.
    const pdfAnchors = anchors.filter((h) => /\.pdf(\?|$)/i.test(h));
    // Filter images: retain those in the product catalog and exclude logos, loaders, banners, and footer images.
    let candidateImages = imgs.filter((src) => {
      try {
        const url = new URL(src);
        const path = url.pathname.toLowerCase();
        return (
          /\/media\/catalog\/product\//.test(path) &&
          !/logo|loader|banner|theme|footer|payment|icon|spinner/.test(path)
        );
      } catch {
        return false;
      }
    });
    // Group by base filename to identify duplicate images across caches.
    const nameCounts = {};
    const baseNames = candidateImages.map((src) => {
      try {
        const url = new URL(src);
        return url.pathname.split('/').pop().toLowerCase();
      } catch {
        return '';
      }
    });
    baseNames.forEach((name) => {
      if (name) nameCounts[name] = (nameCounts[name] || 0) + 1;
    });

    // Filter images again: keep if the base filename appears more than once across caches,
    // or if it does not contain a dash followed by a digit (to exclude accessory images).
    candidateImages = candidateImages.filter((src) => {
      try {
        const url = new URL(src);
        const name = url.pathname.split('/').pop().toLowerCase();
        return (nameCounts[name] > 1) || !/-\d/.test(name);
      } catch {
        return false;
      }
    });

    // Also collect standalone PDF URLs (direct links) in the page
    const pdfs = anchors.filter((h) => /\.pdf(\?|$)/i.test(h));
    const jsons = anchors.filter((h) => /\.json(\?|$)/i.test(h));

    // Deduplicate images by base filename: keep only one image (the first encountered) for each filename.
    const imagesByName = {};
    for (const src of candidateImages) {
      try {
        const name = new URL(src).pathname.split('/').pop().toLowerCase();
        if (!imagesByName[name]) imagesByName[name] = src;
      } catch {
        continue;
      }
    }

    // From the deduplicated images, take only the first few (e.g. first two) to
    // avoid including unrelated accessory photos. We rely on insertion order
    // preserved by Object.values().
    const allImages = Object.values(imagesByName);
    const limitedImages = allImages.slice(0, 2);

    return {
      anchors: Array.from(new Set(pdfAnchors)),
      images: limitedImages,
      pdfs: Array.from(new Set(pdfs)),
      jsons: Array.from(new Set(jsons)),
    };
  });
}

/**
 * Browse a product URL with Playwright. Expands tabs/accordions, scrolls
 * through the page, and extracts a raw browse payload to augment the
 * existing scraper output. The return value always includes an `ok`
 * field; on failure `ok` will be false and `error` will contain the
 * exception message. On success the object will include a `raw_browse`
 * field with the extracted data.
 *
 * @param {string} url Product URL to browse.
 * @param {object} opts Optional browser overrides.
 */
export async function browseProduct(url, opts = {}) {
  const {
    navigationTimeoutMs = 30000,
    userAgent =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport = { width: 1366, height: 900 },
  } = opts;

  let browser;
  let page;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent, viewport });
    page = await context.newPage();

    // Block telemetry / analytics calls to speed up crawling
    await page.route('**/google-analytics.com/**', (route) => route.abort());
    await page.route('**/gtag/js', (route) => route.abort());
    await page.route('**/analytics.js', (route) => route.abort());

    await page.goto(url, { timeout: navigationTimeoutMs, waitUntil: 'domcontentloaded' });
    await autoExpand(page);
    const raw_browse = {};
    raw_browse.visible_text = await collectVisibleText(page);
    raw_browse.sections = await collectSections(page);
    raw_browse.links = await collectLinks(page);
    return { ok: true, raw_browse };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
