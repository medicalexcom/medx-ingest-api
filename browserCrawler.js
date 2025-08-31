// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages. It collects
// the fully rendered HTML after interacting with common tab/accordion UI
// elements, extracts visible text, grabs various sections (description,
// specifications, features, included), plus tabs, microdata, link hints,
// inline data objects, templates, monitors XHR/Fetch, and advanced extras
// (shadow DOM, CSS backgrounds, meta tags, alt text). The result
// is designed to augment the existing static scraper output without
// modifying existing scraping logic.

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLICK_SELECTORS = [ /* unchanged */ ];
const WAITERS = [ /* unchanged */ ];

async function autoExpand(page) { /* unchanged */ }
async function collectVisibleText(page) { /* unchanged */ }
async function collectNetworkData(page) { /* unchanged */ }
async function collectSections(page) { /* unchanged */ }
async function collectMicrodata(page){ /* unchanged */ }
async function collectLinkHints(page){ /* unchanged */ }
async function collectTemplates(page){ /* unchanged */ }
async function collectInlineData(page){ /* unchanged */ }

// New: collect shadow DOM text
async function collectShadowText(page) {
  return page.evaluate(() => {
    const out = [];
    function recurse(root) {
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) recurse(el.shadowRoot);
        if (el.textContent) out.push(el.textContent.trim());
      });
    }
    recurse(document);
    return out.join('\n');
  });
}

// New: collect CSS background-image URLs
async function collectCssBackgrounds(page) {
  return page.evaluate(() => {
    const urls = new Set();
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).getPropertyValue('background-image');
      const match = /url\(([^)]+)\)/.exec(bg);
      if (match) urls.add(match[1].replace(/['"]/g, ''));
    });
    return Array.from(urls);
  });
}

// New: collect standard SEO meta tags (og:*, twitter:*)
async function collectSeoMeta(page) {
  return page.evaluate(() => {
    const metas = {};
    document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')
      .forEach(m => metas[m.getAttribute('property')||m.getAttribute('name')] = m.getAttribute('content'));
    return metas;
  });
}

// New: collect all images with alt text
async function collectImagesWithAlt(page) {
  return page.evaluate(() =>
    [...document.images].map(i => ({ src: i.src, alt: i.alt || null }))
  );
}

export async function browseProduct(url, opts = {}) {
  const {
    navigationTimeoutMs = 30000,
    userAgent = 'Mozilla/5.0...',
    viewport = { width: 1366, height: 900 },
    headless = true
  } = opts;

  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (err) {
    const msg = String(err);
    if (/doesn't.*exist/.test(msg)) {
      try { execSync('npx playwright install chromium', { stdio: 'ignore' }); browser = await chromium.launch({ headless }); }
      catch (e) { return { ok: false, error: String(e) }; }
    } else return { ok: false, error: msg };
  }

  const context = await browser.newContext({ userAgent, viewport });
  const page = await context.newPage();
  const consoleLogs = [];
  page.on('console', msg => { if (['error','warning'].includes(msg.type())) consoleLogs.push({ type: msg.type(), text: msg.text() }); });
  const networkCalls = collectNetworkData(page);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {});
    // cookie banner acceptance unchanged
    await autoExpand(page);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(350); }

    const full_html = await page.content();
    const visible_text = await collectVisibleText(page);
    const shadow_text = await collectShadowText(page);
    const css_backgrounds = await collectCssBackgrounds(page);
    const seo_meta = await collectSeoMeta(page);
    const images_with_alt = await collectImagesWithAlt(page);
    const sections = await collectSections(page);
    const microdata = await collectMicrodata(page);
    const linkHints = await collectLinkHints(page);
    const templates = await collectTemplates(page);
    const inlineData = await collectInlineData(page);
    const seo_links = await collectLinks(page);

    await context.close();
    await browser.close();

    return {
      ok: true,
      raw_browse: {
        source_url: url,
        fetched_at: new Date().toISOString(),
        visible_text,
        shadow_text,
        css_backgrounds,
        seo_meta,
        images_with_alt,
        sections,
        microdata,
        link_hints: linkHints,
        templates,
        inline_data: inlineData,
        network_calls: await networkCalls,
        links: seo_links,
        console: consoleLogs
      }
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
