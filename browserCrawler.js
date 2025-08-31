// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages. It collects
// the fully rendered HTML after interacting with common tab/accordion UI
// elements, extracts visible text, grabs various sections (description,
// specifications, features, included), plus tabs, microdata, link hints,
// inline data objects, templates, and monitors XHR/Fetch. The result
// is designed to augment the existing static scraper output without
// modifying existing scraping logic.

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // product-specific patterns
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

async function autoExpand(page) {
  for (let pass = 0; pass < 3; pass++) {
    for (const sel of CLICK_SELECTORS) {
      let els = [];
      try { els = await page.$$(sel); } catch {}
      for (const el of els) {
        try { if (await el.boundingBox()) await el.click({ timeout:1500 }).catch(()=>{}); } catch {}
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
  return page.evaluate(() => {
    function isVisible(el) {
      const s = getComputedStyle(el);
      return s && s.visibility!=='hidden' && s.display!=='none' && el.offsetParent!==null;
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
        while(p){ const t=p.tagName.toLowerCase(); if(/nav|header|footer|aside/.test(t)||/(\bnav\b|\bheader\b|\bfooter\b|\bsidebar\b)/.test(p.className||"")){skip=true;break;} p=p.parentElement; }
        if(skip) continue;
        const txt = n.nodeValue.replace(/\s+/g,' ').trim(); if(txt) out.push(txt);
      }
      return out.join('\n');
    }
    const main = document.querySelector('main')||document.body;
    let txt = textFrom(main).trim();
    if(!txt||txt.length<10) txt=document.body.innerText.replace(/\s+\n/g,'\n').trim();
    return txt;
  });
}

async function collectNetworkData(page) {
  const calls = [];
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type']||'';
      if(ct.includes('application/json')||ct.includes('application/xml')){
        const url = res.url();
        const body = await res.text().catch(()=>null);
        calls.push({ url, body });
      }
    } catch {};
  });
  return calls;
}

async function collectSections(page) {
  return page.evaluate(() => {
    const sections={}, map={
      description: ['#description','.product-description','.description','section#description','.desc','#desc','.product-desc'],
      specifications: ['#specifications','.specs','.specifications','section#specifications','.product-specs','.tech-specs','.spec-list','.specification-list','.spec-table'],
      features: ['.features','#features','section#features','.feature-list','.product-features','#key-features','#feature-highlights','.benefits','.feature-benefits','.highlight-list'],
      included: ['text="What’s in the box"','text="Included Items"','text="Package Includes"','.included','.includes','.in-the-box','.box-contents','#included-items','#package-contents','.accessories','.accessory-list','.item-included']
    };
    const serialize=el=>el?el.innerText.replace(/\s+\n/g,'\n').trim():'';
    function findFirst(arr){ for(const s of arr){ try{const e=document.querySelector(s); if(e) return e;}catch{} } return null; }
    sections.description=serialize(findFirst(map.description))||document.querySelector('meta[name="description"]')?.content.trim()||'';
    sections.specifications=serialize(findFirst(map.specifications));
    sections.features=serialize(findFirst(map.features));
    if(!sections.features){ for(const h of document.querySelectorAll('h2,h3,h4')){ const t=h.innerText.toLowerCase(); if(t.includes('feature')){ let e=h.nextElementSibling; while(e&&!/^ul|ol$/i.test(e.tagName)) e=e.nextElementSibling; if(e){ sections.features=e.innerText.trim(); break;} } } }
    sections.included=serialize(findFirst(map.included));
    // definition lists
    const dls=[...document.querySelectorAll('dl')].map(dl=>dl.innerText.trim()); if(dls.length) sections.dl= dls.join('\n---\n');
    // tabs/panels
    const panels=[...document.querySelectorAll('[role="tabpanel"],.tab-content,.tab-panel,.accordion-content')];
    sections.tabs={}; panels.forEach(p=>{ const key=p.getAttribute('aria-labelledby')||p.previousElementSibling?.innerText||'tab'; sections.tabs[key.trim().slice(0,30)]=p.innerText.trim(); });
    return sections;
  });
}

async function collectMicrodata(page){
  return page.evaluate(()=>{
    const items={}; [...document.querySelectorAll('[itemscope]')].forEach(el=>{
      const t=el.getAttribute('itemtype')||el.getAttribute('vocab'); const ps={}; [...el.querySelectorAll('[itemprop]')].forEach(p=>ps[p.getAttribute('itemprop')]=p.textContent.trim()); items[t]=ps;
    });
    [...document.querySelectorAll('[typeof]')].forEach(el=>{
      const t=el.getAttribute('typeof'); const ps={}; [...el.querySelectorAll('[property]')].forEach(p=>ps[p.getAttribute('property')]=p.textContent.trim()); items[`rdfa:${t}`]=ps;
    });
    return items;
  });
}

async function collectLinkHints(page){
  return page.evaluate(()=>{
    const hints={}; [...document.querySelectorAll('link[rel]')].forEach(l=>{ const r=l.getAttribute('rel'); if(!hints[r]) hints[r]=[]; hints[r].push(l.getAttribute('href')); }); return hints; });
}

async function collectTemplates(page){
  return page.evaluate(()=>({
    templates:[...document.querySelectorAll('template')].map(t=>t.innerHTML.trim()),
    noscript:[...document.querySelectorAll('noscript')].map(n=>n.innerText.trim()),
    hiddenInputs:[...document.querySelectorAll('input[type="hidden"]').entries()].map(([_,i])=>i.getAttribute('data-specs')||'')
  }));
}

async function collectInlineData(page){
  return page.evaluate(()=>{
    const scripts=[...document.querySelectorAll('script')].map(s=>s.textContent), found={};
    scripts.forEach(txt=>{ if(/window\.__INITIAL_STATE__/.test(txt)) found.initial=txt.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/)?.[1]; if(/var\s+productData/.test(txt)) found.productData=txt.match(/var\s+productData\s*=\s*(\{[\s\S]*?\});/)?.[1]; }); return found;
  });
}

export async function browseProduct(url, opts={}){
  const {navigationTimeoutMs=30000,userAgent='Mozilla/5.0...',viewport={width:1366,height:900},headless=true}=opts;
  let browser;
  try{ browser=await chromium.launch({headless}); }catch(err){ const msg=String(err); if(/Executable.*doesn't.*exist/.test(msg)){ try{ execSync('npx playwright install chromium',{stdio:'ignore'}); browser=await chromium.launch({headless}); }catch(e){ return {ok:false,error:String(e)}; } }else return {ok:false,error:msg}; }
  const context=await browser.newContext({userAgent,viewport}); const page=await context.newPage();
  const consoleLogs=[]; page.on('console',msg=>{ if(['error','warning'].includes(msg.type())) consoleLogs.push({type:msg.type(),text:msg.text()}); });
  const networkCalls=collectNetworkData(page);
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:navigationTimeoutMs}); await page.waitForLoadState('networkidle',{timeout:navigationTimeoutMs}).catch(()=>{});
    for(const sel of ['button:has-text("Accept")','button:has-text("I agree")']){ const b=await page.$(sel); if(b){ await b.click().catch(()=>{}); await page.waitForTimeout(300);} }
    await autoExpand(page);
    for(let i=0;i<4;i++){ await page.mouse.wheel(0,2000); await page.waitForTimeout(350); }
    const full_html=await page.content();
    let visible_text=await collectVisibleText(page);
    function isEng(l){const tot=l.length;let a=0;for(const c of l){ if(c.charCodeAt(0)>=0x20&&c.charCodeAt(0)<=0x7e) a++; } return tot>0&&a/tot>=0.7; }
    visible_text=visible_text.split('\n').filter(l=>isEng(l.trim())).join('\n');
    const sections=await collectSections(page);
    const microdata=await collectMicrodata(page);
    const linkHints=await collectLinkHints(page);
    const templates=await collectTemplates(page);
    const inlineData=await collectInlineData(page);
    const {anchors,images,pdfs,jsons}=await collectLinks(page);
    await context.close(); await browser.close();
    return { ok:true, raw_browse:{ source_url:url, fetched_at:new Date().toISOString(), visible_text, sections, microdata, link_hints:linkHints, templates, inline_data:inlineData, network_calls:await networkCalls, links:{anchors,images,pdfs,jsons}, console:consoleLogs } };
  }catch(err){ return {ok:false,error:String(err)}; }
}
