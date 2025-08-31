// browserCrawler.js
// Headless-browsing collector for product pages — network JSON/XML collection removed.

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLICK_SELECTORS = [
  'button[aria-controls]',
  '[role="tab"]',
  '[data-toggle="tab"]',
  '.tabs [role="tab"]',
  '.accordion button',
  '.accordion .accordion-button',
  '.accordion .accordion-header',
  'details > summary',
  'button:has-text("Show more")',
  'button:has-text("View more")',
  'button:has-text("Read more")',
  'a:has-text("Show more")',
  'a:has-text("View more")',
  'a:has-text("Read more")',
  'a:has-text("Specifications")',
  'a:has-text("Features")',
  'a:has-text("Included")',
  'a:has-text("What’s in the box")',
  'button:has-text("Specifications")',
  'button:has-text("Features")',
  'button:has-text("Included")',
  'a[href^="#tab-"]',
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

async function autoExpand(page) {
  for (let pass = 0; pass < 3; pass++) {
    for (const sel of CLICK_SELECTORS) {
      let elements = [];
      try { elements = await page.$$(sel); } catch {}
      for (const el of elements) {
        try {
          const box = await el.boundingBox();
          if (!box) continue;
          await el.click({ timeout: 1500 }).catch(() => {});
        } catch {}
      }
    }
    for (const w of WAITERS) {
      await page.waitForTimeout(300);
      try { await page.locator(w).first().waitFor({ timeout: 1200 }); } catch {}
    }
    try { await page.waitForLoadState('networkidle'); } catch {}
  }
}

async function collectVisibleText(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const s = getComputedStyle(el);
      return s && s.visibility !== 'hidden' && s.display !== 'none' && el.offsetParent !== null;
    }
    function textFrom(el) {
      if (!isVisible(el)) return '';
      const blk = new Set(['SCRIPT','STYLE','NOSCRIPT']);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const out = [];
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!n.parentElement || blk.has(n.parentElement.tagName)) continue;
        let p = n.parentElement, skip = false;
        while (p) {
          const t = p.tagName.toLowerCase();
          if (/nav|header|footer|aside/.test(t)) { skip = true; break; }
          p = p.parentElement;
        }
        if (skip) continue;
        const txt = n.nodeValue.replace(/\s+/g,' ').trim();
        if (txt) out.push(txt);
      }
      return out.join('\n');
    }
    const main = document.querySelector('main') || document.body;
    const extracted = textFrom(main).trim();
    if (!extracted || extracted.length < 10) {
      return document.body.innerText.replace(/\s+\n/g,'\n').trim();
    }
    return extracted;
  });
}

async function collectSections(page) {
  return page.evaluate(() => {
    const sections = {};
    const map = {
      description: ['#description','.product-description','.description','section#description'],
      specifications: ['#specifications','.specs','.specifications','section#specifications'],
      features: ['.features','#features','section#features','h2:has(+ ul)','h3:has(+ ul)'],
      included: ['text="What’s in the box"','text="Included Items"','text="Package Includes"'],
    };
    const serialize = el => el ? el.innerText.replace(/\s+\n/g,'\n').trim() : '';
    function findFirst(selectors) {
      for (const s of selectors) {
        try { const el = document.querySelector(s); if (el) return el; } catch {};
      }
      return null;
    }
    // Description
    const descEl = findFirst(map.description);
    sections.description = serialize(descEl);
    if (!sections.description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta && meta.content) sections.description = meta.content.trim();
    }
    sections.specifications = serialize(findFirst(map.specifications));
    sections.features = serialize(findFirst(map.features));
    if (!sections.features) {
      const headings = Array.from(document.querySelectorAll('h2,h3,h4'));
      for (const h of headings) {
        const t = (h.innerText||'').toLowerCase();
        if (t.includes('feature')) {
          let el = h.nextElementSibling;
          while (el && !/^ul|ol$/i.test(el.tagName)) el = el.nextElementSibling;
          if (el) { sections.features = el.innerText.trim(); break; }
        }
      }
    }
    sections.included = serialize(findFirst(map.included));
    return sections;
  });
}

export async function browseProduct(url, opts = {}) {
  const { navigationTimeoutMs = 30000, userAgent = 'Mozilla/5.0...', viewport = { width:1366,height:900 }, headless = true } = opts;
  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (err) {
    const msg = String(err);
    if (/Executable\s+doesn\'t\s+exist|failed\s+to\s+launch/.test(msg)) {
      execSync('npx playwright install chromium',{stdio:'ignore'});
      browser = await chromium.launch({ headless });
    } else {
      return { ok:false, error:msg };
    }
  }
  const context = await browser.newContext({ userAgent, viewport });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:navigationTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout:navigationTimeoutMs }).catch(()=>{});

    // cookie banners
    for (const sel of ['button:has-text("Accept")','button:has-text("I agree")']) {
      const b = await page.$(sel);
      if (b) { await b.click().catch(()=>{}); await page.waitForTimeout(300); }
    }

    await autoExpand(page);
    for (let i=0;i<4;i++){ await page.mouse.wheel(0,2000); await page.waitForTimeout(350); }

    let visible_text = await collectVisibleText(page);
    // filter non-english
    function isEnglish(line) {
      const tot=line.length; if (!tot) return false;
      let ascii=0;
      for (let c of line) if (c.charCodeAt(0)>=0x20&&c.charCodeAt(0)<=0x7E) ascii++;
      return ascii/tot>=0.7;
    }
    visible_text = visible_text.split('\n').filter(l=>isEnglish(l.trim())).join('\n');

    const sections = await collectSections(page);
    await context.close(); await browser.close();

    return {
      ok: true,
      raw_browse: {
        source_url: url,
        fetched_at: new Date().toISOString(),
        visible_text,
        sections,
      }
    };
  } catch (err) {
    return { ok:false, error:String(err) };
  }
}
