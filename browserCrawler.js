// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages. It collects
// the fully rendered HTML after interacting with common tab/accordion UI
// elements, extracts visible text, grabs various sections (description,
// specifications, features, included), plus tabs, microdata, link hints,
// inline data objects, templates, shadow DOM text, CSS backgrounds, SEO meta,
// images with alt text, monitors network/XHR JSON/XML, and advanced extras.
// It also captures outbound links, console warnings/errors, and filters non-English.
// The result augments the existing static scraper output without modifying
// existing scraping logic.

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Common selectors to expand hidden content
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

// Accept common cookie banners
const COOKIE_SELECTORS = [
  'button:has-text("Accept")',
  'button:has-text("I agree")',
];

async function autoExpand(page) {
  for (let pass = 0; pass < 3; pass++) {
    for (const sel of CLICK_SELECTORS) {
      let elements = [];
      try { elements = await page.$$(sel); } catch {}
      for (const el of elements) {
        try {
          if (await el.boundingBox()) await el.click({ timeout:1500 }).catch(()=>{});
        } catch {}
      }
    }
    for (const w of WAITERS) {
      await page.waitForTimeout(300);
      try { await page.locator(w).first().waitFor({ timeout:1200 }); } catch {}
    }
    try { await page.waitForLoadState('networkidle'); } catch {}
  }
}

async function collectVisibleText(page) {
  let text = await page.evaluate(() => {
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
        let p = n.parentElement, skip=false;
        while(p) {
          const t=p.tagName.toLowerCase();
          if(/nav|header|footer|aside/.test(t) || /\b(nav|header|footer|sidebar)\b/.test(p.className||"")) { skip=true; break; }
          p=p.parentElement;
        }
        if(skip) continue;
        const txt = n.nodeValue.replace(/\s+/g,' ').trim();
        if(txt) out.push(txt);
      }
      return out.join('\n');
    }
    const main = document.querySelector('main')||document.body;
    let txt = textFrom(main).trim();
    if(!txt||txt.length<100) txt=document.body.innerText.replace(/\s+\n/g,'\n').trim();
    return txt;
  });
  // Filter non-English lines
  const lines = text.split('\n');
  function isEnglish(l) {
    const total=l.length; if(total===0) return false;
    let ascii=0; for(let i=0;i<l.length;i++){ const c=l.charCodeAt(i); if(c>=0x20&&c<=0x7e) ascii++; }
    return ascii/total>=0.7;
  }
  return lines.filter(l=>isEnglish(l.trim())).join('\n');
}

async function collectNetworkData(page) {
  const calls = [];
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type']||'';
      if(ct.includes('application/json')||ct.includes('application/xml')) {
        const url = res.url();
        const body = await res.text().catch(()=>null);
        calls.push({ url, body });
      }
    } catch {}
  });
  return calls;
}

async function collectSections(page) {
  return page.evaluate(() => {
    const sections = {};
    const map = {
      description: ['#description','.product-description','.description','section#description','.desc','#desc','.product-desc'],
      specifications: ['#specifications','.specs','.specifications','section#specifications','.product-specs','.tech-specs','.spec-list','.specification-list','.spec-table'],
      features: ['.features','#features','section#features','.feature-list','.product-features','#key-features','#feature-highlights','.benefits','.feature-benefits','.highlight-list'],
      included: ['text="What’s in the box"','text="Included Items"','text="Product Includes"','.included','.includes','.in-the-box','.box-contents','#included-items','#package-contents','.accessories','.accessory-list','.item-included','#tab-id-2','[id$="-container"]']
    };
    const serialize = el => el ? el.innerText.replace(/\s+\n/g,'\n').trim() : '';
    function findFirst(arr) { for(const s of arr){ try{ const e=document.querySelector(s); if(e) return e;}catch{} } return null; }
    sections.description = serialize(findFirst(map.description)) || document.querySelector('meta[name="description"]')?.content.trim() || '';
    sections.specifications = serialize(findFirst(map.specifications));
    sections.features = serialize(findFirst(map.features));
    if(!sections.features) {
      for(const h of document.querySelectorAll('h2,h3,h4')){
        const t=h.innerText.toLowerCase(); if(t.includes('feature')){
          let e=h.nextElementSibling;
          while(e && !/^ul|ol$/i.test(e.tagName)) e=e.nextElementSibling;
          if(e){ sections.features=e.innerText.trim(); break; }
        }
      }
    }
    sections.included = serialize(findFirst(map.included));
    return sections;
  });
}

async function collectLinks(page) {
  return page.evaluate(() => {
    const anchors=[...document.querySelectorAll('a[href]')].map(a=>a.href);
    const imgs=[...document.images].map(i=>i.src);
    const pdfAnchors=anchors.filter(h=>/\.pdf(\?|$)/i.test(h));
    // filter catalog images
    let candidateImages = imgs.filter(src=>{ try{ const u=new URL(src); return /\/media\/catalog\/product\//.test(u.pathname.toLowerCase()) && !/logo|loader|banner|theme|footer|payment|icon|spinner/.test(u.pathname); }catch{return false;} });
    const counts={};
    candidateImages.forEach(src=>{ try{ const name=new URL(src).pathname.split('/').pop().toLowerCase(); counts[name]=(counts[name]||0)+1;}catch{} });
    candidateImages=candidateImages.filter(src=>{ try{ const name=new URL(src).pathname.split('/').pop().toLowerCase(); return counts[name]>1||!/-\d/.test(name);}catch{return false;} });
    const imagesByName={};
    candidateImages.forEach(src=>{ try{ const name=new URL(src).pathname.split('/').pop().toLowerCase(); if(!imagesByName[name]) imagesByName[name]=src;}catch{} });
    const limitedImages=Object.values(imagesByName).slice(0,2);
    const jsons=anchors.filter(h=>/\.json(\?|$)/i.test(h));
    return { anchors:Array.from(new Set(pdfAnchors)), images:limitedImages, pdfs:Array.from(new Set(pdfAnchors)), jsons:Array.from(new Set(jsons)) };
  });
}

// Placeholders for other advanced collectors (unchanged)
async function collectMicrodata(page) { /* ... */ }
async function collectLinkHints(page) { /* ... */ }
async function collectTemplates(page) { /* ... */ }
async function collectInlineData(page) { /* ... */ }
async function collectShadowText(page) { /* ... */ }
async function collectCssBackgrounds(page) { /* ... */ }
async function collectSeoMeta(page) { /* ... */ }
async function collectImagesWithAlt(page) { /* ... */ }

export async function browseProduct(url, opts = {}) {
  const { navigationTimeoutMs=30000, userAgent='Mozilla/5.0...', viewport={width:1366,height:900}, headless=true } = opts;
  let browser;
  try { browser = await chromium.launch({ headless }); }
  catch(err){ const msg=String(err);
    if(/doesn\'t.*exist/.test(msg)){
      try{ execSync('npx playwright install chromium',{stdio:'ignore'}); browser=await chromium.launch({headless}); }
      catch(e){ return { ok:false, error:String(e) }; }
    } else return { ok:false, error:msg };
  }
  const context = await browser.newContext({ userAgent, viewport });
  const page = await context.newPage();
  // capture console
  const consoleLogs=[]; page.on('console',msg=>{ if(['error','warning'].includes(msg.type())) consoleLogs.push({type:msg.type(), text:msg.text()}); });
  const networkCalls = await collectNetworkData(page);
  try {
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:navigationTimeoutMs});
    await page.waitForLoadState('networkidle',{timeout:navigationTimeoutMs}).catch(()=>{});
    // accept cookies
    for(const sel of COOKIE_SELECTORS){ const b=await page.$(sel); if(b){ await b.click().catch(()=>{}); await page.waitForTimeout(300); }}
    await autoExpand(page);
    // click hash-link tabs
    try{
      const tabLinks=await page.$$('[href^="#tab-"]');
      for(const link of tabLinks){ const href=await link.getAttribute('href'); await link.click().catch(()=>{}); if(href) await page.waitForSelector(href,{timeout:1000}).catch(()=>{}); await page.waitForTimeout(300);} }
    catch{}
    // lazy-load scroll
    for(let i=0;i<4;i++){ await page.mouse.wheel(0,2000); await page.waitForTimeout(350); }

    const visible_text = await collectVisibleText(page);
    let sections = await collectSections(page);
    const links    = await collectLinks(page);
    // other advanced collectors (unused fields may remain)
    const microdata  = await collectMicrodata(page);
    const linkHints  = await collectLinkHints(page);
    const templates  = await collectTemplates(page);
    const inlineData = await collectInlineData(page);
    const shadowText = await collectShadowText(page);
    const cssBg      = await collectCssBackgrounds(page);
    const seoMeta    = await collectSeoMeta(page);
    const altImages  = await collectImagesWithAlt(page);

    await context.close(); await browser.close();
    return {
      ok: true,
      raw_browse: {
        source_url: url,
        fetched_at: new Date().toISOString(),
        visible_text,
        sections,
        links,
        network: networkCalls,
        console: consoleLogs,
        microdata,
        link_hints: linkHints,
        templates,
        inline_data: inlineData,
        shadow_text: shadowText,
        css_backgrounds: cssBg,
        seo_meta: seoMeta,
        images_with_alt: altImages,
      }
    };
  } catch(err) {
    return { ok:false, error:String(err) };
  }
}
