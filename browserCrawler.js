// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages. It collects
// the fully rendered HTML after interacting with common tab/accordion UI
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
        const t = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) chunks.push(t);
      }
      return chunks.join('\n');
    }
    const main = document.querySelector('main') || document.body;
    return textFrom(main);
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
      included: ['text="What’s in the box"', 'text="Included Items"', 'text="Package Includes"'],
    };
    const serialize = (el) => (el ? el.innerText.replace(/\s+\n/g, '\n').trim() : '');
        function findFirst(selectors) {
          for (const s of selectors) {
            try {
              const el = document.querySelector(s);
              if (el) return el;
            } catch (e) {
              // Ignore invalid CSS selectors (e.g., Playwright-specific selectors like text="..."),
              // and continue checking the next selector.
              continue;
            }
          }
          return null;
        }
    sections.description = serialize(findFirst(map.description));
    sections.specifications = serialize(findFirst(map.specifications));
    sections.features = serialize(findFirst(map.features));
    sections.included = serialize(findFirst(map.included));
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
    const pdfs = anchors.filter((h) => /\.pdf(\?|$)/i.test(h));
    const jsons = anchors.filter((h) => /\.json(\?|$)/i.test(h));
    return {
      anchors: Array.from(new Set(anchors)),
      images: Array.from(new Set(imgs)),
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
    headless = true,
  } = opts;
  let browser;
  try {
    // Attempt to launch the browser. In some server environments the
    // Playwright browser binaries are missing unless `playwright install` has
    // been run. If launch fails due to missing binaries, attempt to
    // download them on the fly.
    browser = await chromium.launch({ headless });
  } catch (err) {
    const msg = String(err || '');
    // Detect the missing executable error that Playwright throws when no
    // browser binary is available. The error message includes the path to
    // the missing headless_shell or chrome executable.
    if (/Executable\s+doesn\'t\s+exist|failed\s+to\s+launch/.test(msg)) {
      try {
        // Run the Playwright install script synchronously. We suppress
        // output (stdio: 'inherit' could be used for debugging) and
        // install all dependencies with system packages. The command will
        // download the Chromium browser into the Playwright cache. When
        // finished we retry launching the browser.
        // Install the browser binaries. We omit the --with-deps flag because
        // it attempts to install system dependencies requiring root privileges.
        // Installing only the browser avoids permission issues on platforms like Render.
        execSync('npx playwright install chromium', { stdio: 'ignore' });
        browser = await chromium.launch({ headless });
      } catch (installErr) {
        return { ok: false, error: String(installErr) };
      }
    } else {
      return { ok: false, error: String(err) };
    }
  }
  const context = await browser.newContext({ userAgent, viewport });
  const page = await context.newPage();
  const consoleLogs = [];
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') consoleLogs.push({ type: t, text: msg.text() });
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {});
    // Accept obvious cookie banners
    const cookieSelectors = ['button:has-text("Accept")', 'button:has-text("I agree")'];
    for (const sel of cookieSelectors) {
      const b = await page.$(sel);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    await autoExpand(page);
    // Trigger lazy-load by scrolling
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(350);
    }
        // Capture the full HTML. We keep it only for debugging and don't
        // include it in the returned object to avoid noise.
        const full_html = await page.content();
    const visible_text = await collectVisibleText(page);
    const sections = await collectSections(page);
    const { anchors, images, pdfs, jsons } = await collectLinks(page);
        return {
          ok: true,
          raw_browse: {
            source_url: url,
            fetched_at: new Date().toISOString(),
            // We intentionally omit full_html from the returned object. It is
            // available in the closure if needed for debugging but not
            // exposed to downstream consumers.
            visible_text,
            sections,
            links: {
              anchors,
              images,
              pdfs,
              jsons,
            },
            console: consoleLogs,
          },
        };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
