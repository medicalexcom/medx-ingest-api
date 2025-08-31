// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages. It collects
// fully rendered, user-visible text; canonical product sections (description,
// specifications, features, included); tabs/accordions; definition lists;
// outbound links (with product-image heuristics); microdata/JSON-LD; inline
// data blobs; link hints (manuals/datasheets/etc.); shadow-DOM text; CSS
// background images; SEO meta; images with alt; browser console warnings/errors;
// and JSON/XML network responses. It also handles common cookie banners,
// clicks hash-link tabs, scrolls to trigger lazy loads, and falls back to
// installing Chromium when missing.
//
// The returned shape is designed to augment existing static scraper output
// without modifying the existing scraping logic.

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------- Config ---------------------------------- */

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

const COOKIE_SELECTORS = [
  'button:has-text("Accept")',
  'button:has-text("I agree")',
  'button:has-text("Agree")',
  'button:has-text("Allow all")',
  'button:has-text("Got it")',
  'button[aria-label*="accept" i]',
];

function isEnglishLine(line) {
  const s = (line || '').trim();
  if (!s) return false;
  let ascii = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) ascii++;
  }
  return ascii / s.length >= 0.7;
}

function filterEnglish(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => isEnglishLine(l))
    .join('\n')
    .trim();
}

async function autoExpand(page) {
  for (let pass = 0; pass < 3; pass++) {
    for (const sel of CLICK_SELECTORS) {
      let elements = [];
      try { elements = await page.$$(sel); } catch { }
      for (const el of elements) {
        try {
          const box = await el.boundingBox();
          if (!box) continue;
          await el.click({ timeout: 1500 }).catch(() => {});
        } catch { }
      }
    }
    for (const w of WAITERS) {
      await page.waitForTimeout(300);
      try { await page.locator(w).first().waitFor({ timeout: 1200 }); } catch { }
    }
    try { await page.waitForLoadState('networkidle'); } catch { }
  }
}

async function acceptCookiesIfPresent(page) {
  for (const sel of COOKIE_SELECTORS) {
    try {
      const b = await page.$(sel);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(250);
      }
    } catch { }
  }
}

async function collectVisibleText(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && el.offsetParent !== null;
    }
    function textFrom(root) {
      if (!isVisible(root)) return '';
      const blacklist = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE']);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const chunks = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement || blacklist.has(node.parentElement.tagName)) continue;
        let skip = false;
        let p = node.parentElement;
        while (p) {
          const tag = p.tagName.toLowerCase();
          if (['nav','header','footer','aside'].includes(tag)) { skip = true; break; }
          const cls = (p.className||'').toLowerCase();
          if (/(^|\b)(nav|header|footer|sidebar|breadcrumb|menu|account)(\b|$)/.test(cls)) { skip=true; break; }
          p = p.parentElement;
        }
        if (skip) continue;
        const t = node.nodeValue.replace(/\s+/g,' ').trim();
        if (t) chunks.push(t);
      }
      return chunks.join('\n');
    }
    const main = document.querySelector('main')||document.body;
    const extracted = textFrom(main).trim();
    if (!extracted||extracted.length<10) return document.body.innerText.trim();
    return extracted;
  });
}

async function collectSections(page) {
  return page.evaluate(() => {
    const sections = {};
    const map = {
      description:['#description','.product-description','.description','section#description','.desc','#desc','.product-desc'],
      specifications:['#specifications','.specs','.specifications','section#specifications','.product-specs','.tech-specs','.spec-list','.specification-list','.spec-table'],
      features:['.features','#features','section#features','.feature-list','.product-features','#key-features','#feature-highlights','.benefits','.feature-benefits','.highlight-list','h2:has(+ ul)','h3:has(+ ul)'],
      included:['text="What’s in the box"','text="Included Items"','text="Product Includes"','text="Package Includes"','.included','.includes','.in-the-box','.box-contents','#included-items','#package-contents','.accessories','.accessory-list','.item-included','#tab-id-2','[id$="-container"]'],
    };
    const serialize = el => el?el.innerText.replace(/\s+\n/g,'\n').trim():'';
    const findFirst = selectors=>{for(const s of selectors){try{const el=document.querySelector(s);if(el) return el;}catch{} } return null;};
    const descEl=findFirst(map.description);
    sections.description=serialize(descEl)||document.querySelector('meta[name="description"]')?.content.trim()||'';
    sections.specifications=serialize(findFirst(map.specifications));
    sections.features=serialize(findFirst(map.features));
    if(!sections.features){try{for(const h of document.querySelectorAll('h2,h3,h4')){if(h.innerText.toLowerCase().includes('feature')){let el=h.nextElementSibling;while(el&&!/^ul|ol$/i.test(el.tagName))el=el.nextElementSibling;if(el){sections.features=el.innerText.trim();break;}}}}catch{}
    sections.included=serialize(findFirst(map.included));
    if(!sections.included){const sel=['[role="tabpanel"]','.tab-content','.tab-panel','.accordion-content','[id^="tab-"]','[class*="tab-"]','[class*="Tab"]','[id$="-container"]'].join(',');for(const p of document.querySelectorAll(sel)){const txt=p.innerText.toLowerCase();if(/what’s in the box|included items|product includes|package includes/.test(txt)){sections.included=p.innerText.trim();break;}}}
    const dls=Array.from(document.querySelectorAll('dl')).map(dl=>dl.innerText.trim());if(dls.length)sections.dl=dls.join('\n---\n');
    const rawPanels=document.querySelectorAll('[role="tabpanel"],.tab-content,.tab-panel,.accordion-content,[id^="tab-"],[class*="tab-"],[class*="Tab"],[id$="-container"]');
    const panels=Array.from(rawPanels).filter(p=>!p.closest('.public-sub-menu'));
    sections.tabs={};panels.forEach(p=>{const key=(p.getAttribute('aria-labelledby')||p.id||p.previousElementSibling?.innerText||'tab').trim().slice(0,60);sections.tabs[key]=p.innerText.trim();});
    return sections;
  });
}

async function collectLinks(page,{productImageLimit=2}={}){return page.evaluate(({productImageLimit})=>{/* unchanged */},{productImageLimit});}

async function collectSeoMeta(page){return page.evaluate(()=>{/* unchanged */});}
async function collectMicrodata(page){return page.evaluate(()=>{/* unchanged */});}
async function collectInlineData(page){return page.evaluate(()=>{/* unchanged */});}
async function collectLinkHints(page){return page.evaluate(()=>{/* unchanged */});}
async function collectShadowText(page){return page.evaluate(()=>{/* unchanged */});}
async function collectCssBackgrounds(page){return page.evaluate(()=>{/* unchanged */});}
async function collectImagesWithAlt(page){return page.evaluate(()=>{/* unchanged */});}

export async function browseProduct(url,opts={}){
  const {navigationTimeoutMs=30000,userAgent,viewport,headless,enforceEnglishHeuristic=true,productImageLimit=2,includeHtml=false}=opts;
  let browser;
  try{browser=await chromium.launch({headless});}catch(err){/* unchanged */}
  const context=await browser.newContext({userAgent,viewport});
  const page=await context.newPage();
  const consoleLogs=[];page.on('console',msg=>{const t=msg.type();if(t==='error'||t==='warning')consoleLogs.push({type:t,text:msg.text()});});
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:navigationTimeoutMs});
    await page.waitForLoadState('networkidle',{timeout:navigationTimeoutMs}).catch(()=>{});
    await acceptCookiesIfPresent(page);
    await autoExpand(page);
    try{const tabLinks=await page.$$('[href^="#tab-"]');for(const link of tabLinks){const href=await link.getAttribute('href');await link.click().catch(()=>{});if(href)await page.waitForSelector(href,{timeout:1000}).catch(()=>{});await page.waitForTimeout(200);}}catch{}
    for(let i=0;i<4;i++){await page.mouse.wheel(0,2000);await page.waitForTimeout(350);}    
    await page.evaluate(()=>{document.querySelectorAll('.public-sub-menu').forEach(el=>el.remove());});
    const full_html=includeHtml?await page.content():null;
    let visible_text=await collectVisibleText(page);
    let sections=await collectSections(page);
    if(enforceEnglishHeuristic){visible_text=filterEnglish(visible_text);const cleaned={};for(const key of['description','specifications','features','included'])cleaned[key]=filterEnglish(sections[key]||'');cleaned.dl=sections.dl||'';cleaned.tabs=sections.tabs||{};sections=cleaned;if(sections.features && sections.features.trim().toLowerCase()==='company info')sections.features='';}
    const {links,links_extra}=await collectLinks(page,{productImageLimit});
    const seo_meta=await collectSeoMeta(page);
    const microdata=await collectMicrodata(page);
    const inline_data=await collectInlineData(page);
    const link_hints=await collectLinkHints(page);
    const shadow_text=await collectShadowText(page);
    const css_backgrounds=await collectCssBackgrounds(page);
    const images_with_alt=await collectImagesWithAlt(page);
    const payload={source_url:url,fetched_at:new Date().toISOString(),...(includeHtml?{full_html}:{}),visible_text,sections,links,seo_meta,console:consoleLogs};
    return{ok:true,raw_browse:payload};
  }catch(err){return{ok:false,error:String(err)};}finally{await context.close().catch(()=>{});await browser.close().catch(()=>{});}  
}
