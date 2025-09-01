// browserCrawler.js
    // Headless-browsing collector for product pages.
    //
    // This module uses Playwright to fetch and expand product pages. It 
    // collects
    // fully rendered, user-visible text; canonical product sections 
    // (description,
    // specifications, features, included); tabs/accordions; definition lists;
    // outbound links (with product-image heuristics); microdata/JSON-LD; inline
    // data blobs; link hints (manuals/datasheets/etc.); shadow-DOM text; CSS
    // background images; SEO meta; images with alt; browser console 
    // warnings/errors;
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

    /* ------------------------------- Config ----------------------------------
 */

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

      // Spectra-style / hash-link tabs
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

    // Cookie banners we try to accept/dismiss quickly
    const COOKIE_SELECTORS = [
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("Agree")',
      'button:has-text("Allow all")',
      'button:has-text("Got it")',
      'button[aria-label*="accept" i]',
    ];

    /* ---------------------------- Helper utilities ---------------------------
 */

    /** Heuristic: keep lines that are mostly ASCII (approx. English). */
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

    /** Filter a multi-line string to (mostly) English lines. */
    function filterEnglish(text) {
      return String(text || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => isEnglishLine(l))
        .join('\n')
        .trim();
    }

    /* --------------------------- Page-side collectors ------------------------
 */

    /**
     * Utility to scroll and click through interactive elements on the page.
     * Performs multiple passes to reveal content hidden behind tabs/accordions.
     * @param {import('playwright').Page} page
     */
    async function autoExpand(page) {
      for (let pass = 0; pass < 3; pass++) {
        for (const sel of CLICK_SELECTORS) {
          let elements = [];
          try { elements = await page.$$(sel); } catch { /* ignore engine-
specific */ }
          for (const el of elements) {
            try {
              const box = await el.boundingBox();
              if (!box) continue;
              await el.click({ timeout: 1500 }).catch(() => {});
            } catch { /* swallow */ }
          }
        }

        for (const w of WAITERS) {
          await page.waitForTimeout(300);
          try { await page.locator(w).first().waitFor({ timeout: 1200 }); } 
catch { /* ignore */ }
        }

        try { await page.waitForLoadState('networkidle'); } catch { /* ignore */
 }
      }
    }

    /**
     * Try to accept cookie banners quickly to unblock content.
     * @param {import('playwright').Page} page
     */
    async function acceptCookiesIfPresent(page) {
      for (const sel of COOKIE_SELECTORS) {
        try {
          const b = await page.$(sel);
          if (b) {
            await b.click().catch(() => {});
            await page.waitForTimeout(250);
          }
        } catch { /* ignore */ }
      }
    }

    /**
     * Extract user-visible text from the document (runtime context).
     * Avoids nav/header/footer/aside + common noise classes.
     * @param {import('playwright').Page} page
     */
    async function collectVisibleText(page) {
      return page.evaluate(() => {
        function isVisible(el) {
          const style = window.getComputedStyle(el);
          return style && style.visibility !== 'hidden' && style.display !== 
'none' && el.offsetParent !== null;
        }
        function textFrom(root) {
          if (!isVisible(root)) return '';
          const blacklist = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 
'TEMPLATE']);
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, 
null);
          const chunks = [];
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.parentElement || 
blacklist.has(node.parentElement.tagName)) continue;

            // Skip text inside navigation-like areas to reduce noise
            let skip = false;
            let p = node.parentElement;
            while (p) {
              const tag = (p.tagName || '').toLowerCase();
              if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag 
=== 'aside') { skip = true; break; }
              const cls = (p.className ? String(p.className).toLowerCase() : 
'');
              // Skip nav/footer/sidebar/breadcrumb/menu/account classes; also skip cookie/onetrust banners
              if (/(^|\b)(nav|header|footer|sidebar|breadcrumb|menu|account)(\b|$)/.test(cls) || /(cookie|onetrust)/.test(cls)) { 
                skip = true; break; }
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
        if (!extracted || extracted.length < 10) {
          return document.body.innerText.replace(/\s+\n/g, '\n').trim();
        }
        return extracted;
      });
    }

    /**
     * Gather common product sections by querying the DOM (best effort).
     * Also captures DLs and panel/tab content.
     * @param {import('playwright').Page} page
     */
    async function collectSections(page) {
      return page.evaluate(() => {
        const sections = {};
        const map = {
          description: [
            '#description', '.product-description', '.description', 
'section#description',
            '.desc','#desc','.product-desc'
          ],
          specifications: [
            '#specifications', '.specs', '.specifications', 
'section#specifications',
            '.product-specs','.tech-specs','.spec-list','.specification-
list','.spec-table'
          ],
          features: [
            '.features','#features','section#features','.feature-
list','.product-features',
            '#key-features','#feature-highlights','.benefits','.feature-
benefits',
            '.highlight-list', 'h2:has(+ ul)', 'h3:has(+ ul)'
          ],
          included: [
            'text="What’s in the box"','text="Included Items"','text="Product 
Includes"',
            'text="Package Includes"','.included','.includes','.in-the-
box','.box-contents',
            '#included-items','#package-contents','.accessories','.accessory-
list',
            '.item-included','#tab-id-2','[id$="-container"]'
          ],
        };

        const serialize = (el) => (el ? el.innerText.replace(/\s+\n/g, 
'\n').trim() : '');

        function findFirst(selectors) {
          for (const s of selectors) {
            try {
              const el = document.querySelector(s);
              if (el) return el;
            } catch {
              // Ignore invalid selectors (e.g. Playwright's text="...") in DOM 
API
              continue;
            }
          }
          return null;
        }

        // Core sections
        const descEl = findFirst(map.description);
        sections.description = serialize(descEl) ||
          (document.querySelector('meta[name="description"]')?.content || 
'').trim();

        sections.specifications = serialize(findFirst(map.specifications));
        sections.features = serialize(findFirst(map.features));

        // Fallback for features: heading with "feature" + next UL/OL
        if (!sections.features) {
          try {
            const headings = Array.from(document.querySelectorAll('h2, h3, 
h4'));
            for (const h of headings) {
              const txt = (h.innerText || '').toLowerCase();
              if (txt && txt.includes('feature')) {
                let el = h.nextElementSibling;
                while (el && !(el.tagName && (/^ul$/i.test(el.tagName) || 
/^ol$/i.test(el.tagName)))) {
                  el = el.nextElementSibling;
                }
                if (el && el.innerText) {
                  sections.features = el.innerText.replace(/\s+\n/g, 
'\n').trim();
                  break;
                }
              }
            }
          } catch { /* ignore */ }
        }

        // Included
        sections.included = serialize(findFirst(map.included));

        // Fallback for included: scan common panels with header text
        if (!sections.included) {
          const sel = [
            '[role="tabpanel"]','.tab-content','.tab-panel','.accordion-
content',
            
            '[id^="tab-"]','[class*="tab-"]','[class*="Tab"]','[id$="-container"]'
          ].join(',');
          for (const p of document.querySelectorAll(sel)) {
            const txt = (p.innerText || '').toLowerCase();
            if (txt.includes("what’s in the box") || txt.includes("included 
items") || txt.includes("product includes") || txt.includes("package includes"))
  {
              sections.included = p.innerText.replace(/\s+\n/g, '\n').trim();
              break;
            }
          }
        }

        // Definition lists
        const dls = Array.from(document.querySelectorAll('dl')).map(dl => 
dl.innerText.trim());
        if (dls.length) sections.dl = dls.join('\n---\n');

        // Capture all tab/panel bodies
        const panels = document.querySelectorAll([
          '[role="tabpanel"]','.tab-content','.tab-panel','.accordion-content',
          '[id^="tab-"]','[class*="tab-"]','[class*="Tab"]','[id$="-container"]'
        ].join(','));
        sections.tabs = {};
        panels.forEach(p => {
          const key = (p.getAttribute('aria-labelledby') || p.id || 
p.previousElementSibling?.innerText || 'tab')
            .trim()
            .slice(0, 60);
          sections.tabs[key] = (p.innerText || '').trim();
        });

        return sections;
      });
    }

    /**
     * Collect links on the page: anchors, product-like images, PDFs, and JSON 
resources.
     * Returns a shape compatible with Code B, plus extra fields under 
links_extra.
     * @param {import('playwright').Page} page
     */
    async function collectLinks(page, { productImageLimit = 2 } = {}) {
      return page.evaluate(({ productImageLimit }) => {
        const anchorsAll = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter(Boolean)
          .map(h => {
            try { return new URL(h, document.baseURI).href; } catch { return 
null; }
          })
          .filter(Boolean);

        const pdfAnchors = anchorsAll.filter(h => /\.pdf(\?|$)/i.test(h));
        const jsonAnchors = anchorsAll.filter(h => /\.json(\?|$)/i.test(h));

        const imgsAll = Array.from(document.images)
          .map(i => i.getAttribute('src'))
          .filter(Boolean)
          .map(s => {
            try { return new URL(s, document.baseURI).href; } catch { return 
null; }
          })
          .filter(Boolean);

        // Product-ish image heuristic similar to Code B
        let candidateImages = imgsAll.filter(src => {
          try {
            const u = new URL(src);
            const p = u.pathname.toLowerCase();
            return (
              /\/media\/catalog\/product\//.test(p) ||
              /\/products?\//.test(p)
            ) && 
!/logo|loader|banner|theme|footer|payment|icon|spinner/.test(p);
          } catch { return false; }
        });

        // De-dupe by basename and prefer duplicates across caches
        const nameCounts = {};
        const getName = (url) => {
          try { return new URL(url).pathname.split('/').pop().toLowerCase(); } 
catch { return ''; }
        };
        candidateImages.forEach(src => {
          const n = getName(src);
          if (n) nameCounts[n] = (nameCounts[n] || 0) + 1;
        });

        candidateImages = candidateImages.filter(src => {
          const n = getName(src);
          // keep if seen across caches (count>1) OR name doesn't look like 
accessory -\d
          return (nameCounts[n] > 1) || !/-\d/.test(n);
        });

        // De-dupe and truncate
        const imagesByName = {};
        for (const src of candidateImages) {
          const n = getName(src);
          if (n && !imagesByName[n]) imagesByName[n] = src;
        }
        const productImages = Object.values(imagesByName).slice(0, 
productImageLimit);

        // Canonical + alternates
        const canonical = document.querySelector('link[rel="canonical"]')?.href 
|| null;
        const alternates = 
Array.from(document.querySelectorAll('link[rel="alternate"]'))
          .map(l => ({ href: l.href, hreflang: l.hreflang || null }))
          .filter(x => x.href);

        return {
          links: {
            // Keep Code B's expectation (PDF-only anchors)
            anchors: Array.from(new Set(pdfAnchors)),
            images: productImages,
            pdfs: Array.from(new Set(pdfAnchors)),
            jsons: Array.from(new Set(jsonAnchors)),
          },
          links_extra: {
            all_anchors: Array.from(new Set(anchorsAll)),
            all_images: Array.from(new Set(imgsAll)),
            canonical,
            alternates,
          }
        };
      }, { productImageLimit });
    }

    /**
     * Collect JSON/XML network calls during the session.
     * Returns a live array that will be populated as responses arrive.
     * @param {import('playwright').Page} page
     */
    function setupNetworkCapture(page) {
      const calls = [];
      page.on('response', async res => {
        try {
          const ct = (res.headers()['content-type'] || '').toLowerCase();
          if (ct.includes('application/json') || ct.includes('application/xml') 
|| ct.includes('text/xml')) {
            const url = res.url();
            const status = res.status();
            const method = res.request()?.method?.() || '';
            const body = await res.text().catch(() => null);
            calls.push({ url, status, method, content_type: ct, body });
          }
        } catch { /* ignore */ }
      });
      return calls;
    }

    /**
     * Collect SEO-related meta tags, OG/Twitter cards, canonical & robots.
     * @param {import('playwright').Page} page
     */
    async function collectSeoMeta(page) {
      return page.evaluate(() => {
        const pick = (selector, attr) => 
document.querySelector(selector)?.getAttribute(attr) || null;
        const pickContent = (selector) => 
document.querySelector(selector)?.getAttribute('content') || null;

        const meta = {
          title: document.title || null,
          canonical: document.querySelector('link[rel="canonical"]')?.href || 
null,
          robots: pickContent('meta[name="robots"]'),
          description: pickContent('meta[name="description"]'),
          keywords: pickContent('meta[name="keywords"]'),
          og: {
            title: pickContent('meta[property="og:title"]'),
            description: pickContent('meta[property="og:description"]'),
            type: pickContent('meta[property="og:type"]'),
            url: pickContent('meta[property="og:url"]'),
            image: pickContent('meta[property="og:image"]'),
            site_name: pickContent('meta[property="og:site_name"]'),
          },
          twitter: {
            card: pickContent('meta[name="twitter:card"]'),
            title: pickContent('meta[name="twitter:title"]'),
            description: pickContent('meta[name="twitter:description"]'),
            image: pickContent('meta[name="twitter:image"]'),
            site: pickContent('meta[name="twitter:site"]'),
          },
          h1: (document.querySelector('h1')?.innerText || '').trim() || null,
        };
        return meta;
      });
    }

    /**
     * Collect JSON-LD and HTML microdata (itemscope/itemprop).
     * @param {import('playwright').Page} page
     */
    async function collectMicrodata(page) {
      return page.evaluate(() => {
        const jsonLd = [];
        
document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
          const raw = (s.textContent || '').trim();
          if (!raw) return;
          try {
            const parsed = JSON.parse(raw);
            jsonLd.push(parsed);
          } catch {
            jsonLd.push({ __raw: raw.slice(0, 100000) });
          }
        });

        const micro = [];
        const scopes = document.querySelectorAll('[itemscope]');
        scopes.forEach(scope => {
          const type = scope.getAttribute('itemtype') || null;
          const item = { type, props: {} };
          scope.querySelectorAll('[itemprop]').forEach(el => {
            const name = el.getAttribute('itemprop');
            const value = el.getAttribute('content') || (el.textContent || 
'').trim();
            if (!name || !value) return;
            if (!item.props[name]) item.props[name] = [];
            item.props[name].push(value);
          });
          micro.push(item);
        });

        return { json_ld: jsonLd, microdata: micro };
      });
    }

    /**
     * Collect inline data blobs: application/json scripts and common window 
globals.
     * @param {import('playwright').Page} page
     */
    async function collectInlineData(page) {
      return page.evaluate(() => {
        const out = {
          application_json_scripts: [],
          window_vars: {},
        };

        // <script type="application/json"> blobs
        document.querySelectorAll('script[type="application/json"]').forEach(s 
=> {
          const raw = (s.textContent || '').trim();
          if (!raw) return;
          try {
            out.application_json_scripts.push(JSON.parse(raw));
          } catch {
            out.application_json_scripts.push({ __raw: raw.slice(0, 100000) });
          }
        });

        // Common app frameworks / globals
        const WIN_KEYS = [
          '__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__', '__INITIAL_STATE__',
          '__PRELOADED_STATE__', '__REDUX_STATE__'
        ];
        WIN_KEYS.forEach(k => {
          try {
            if (typeof window[k] !== 'undefined') out.window_vars[k] = 
window[k];
          } catch { out.window_vars[k] = null; }
        });
        if (Array.isArray(window.dataLayer)) out.window_vars.dataLayer = 
window.dataLayer;

        // Next.js embedded script by id
        const nextEl = document.querySelector('#__NEXT_DATA__');
        if (nextEl && nextEl.textContent) {
          try { out.window_vars.__NEXT_DATA__ = JSON.parse(nextEl.textContent); 
} catch { /* ignore */ }
        }

        return out;
      });
    }

    /**
     * Collect link hints likely to be manuals, datasheets, IFUs, etc.
     * @param {import('playwright').Page} page
     */
    async function collectLinkHints(page) {
      return page.evaluate(() => {
        const HINTS = [
          'manual', 'datasheet', 'spec sheet', 'specification sheet', 
'brochure', 'catalog',
          'ifu', 'instructions', 'user guide', 'quick start', 'installation', 
'sds', 'msds',
          'safety data sheet', 'warranty', 'size chart', 'compatibility'
        ];
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const out = [];
        for (const a of anchors) {
          const href = a.href;
          const text = (a.innerText || a.title || '').toLowerCase().trim();
          const file = (href || '').toLowerCase();
          const match = HINTS.find(h => text.includes(h) || 
file.includes(h.replace(/\s+/g, '')));
          if (match) out.push({ href, text: a.innerText.trim(), hint: match });
        }
        // de-dup by href
        const seen = new Set();
        return out.filter(x => {
          if (!x.href || seen.has(x.href)) return false;
          seen.add(x.href);
          return true;
        });
      });
    }

    /**
     * Gather shadow DOM text where available.
     * @param {import('playwright').Page} page
     */
    async function collectShadowText(page) {
      return page.evaluate(() => {
        const out = [];
        const all = document.querySelectorAll('*');
        all.forEach(el => {
          const sr = el.shadowRoot;
          if (sr) {
            const txt = (sr.textContent || '').replace(/\s+\n/g, '\n').trim();
            if (txt) out.push(txt);
          }
        });
        return out.join('\n').trim();
      });
    }

    /**
     * Extract background-image URLs from computed styles.
     * @param {import('playwright').Page} page
     */
    async function collectCssBackgrounds(page) {
      return page.evaluate(() => {
        const urls = new Set();
        const all = document.querySelectorAll('*');
        all.forEach(el => {
          const s = getComputedStyle(el);
          const bi = s && s.backgroundImage;
          if (!bi) return;
          const m = bi.match(/url\((['"]?)(.*?)\1\)/g);
          if (m) {
            m.forEach(u => {
              const inner = u.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/,
  '');
              try {
                const abs = new URL(inner, document.baseURI).href;
                urls.add(abs);
              } catch { /* ignore */ }
            });
          }
        });
        return Array.from(urls);
      });
    }

    /**
     * Collect images with alt text.
     * @param {import('playwright').Page} page
     */
    async function collectImagesWithAlt(page) {
      return page.evaluate(() => {
        const imgs = Array.from(document.images || []);
        return imgs.map(img => ({
          src: (() => { try { return new URL(img.src, document.baseURI).href; } 
catch { return img.src || null; } })(),
          alt: img.alt || null,
          width: img.width || null,
          height: img.height || null,
        }));
      });
    }

    /* ------------------------------- Main API --------------------------------
 */

    /**
     * Browse a product URL with Playwright, expand content, and extract a 
comprehensive payload.
     *
     * @param {string} url
     * @param {object} [opts]
     * @param {number} [opts.navigationTimeoutMs=30000]
     * @param {string} [opts.userAgent='Mozilla/5.0 (X11; Linux x86_64) 
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36']
     * @param {{width:number,height:number}} 
[opts.viewport={width:1366,height:900}]
     * @param {boolean} [opts.headless=true]
     * @param {boolean} [opts.enforceEnglishHeuristic=true]   // apply ASCII-
heavy line filtering
     * @param {number}  [opts.productImageLimit=2]            // cap filtered 
product images in links.images
     * @param {boolean} [opts.includeHtml=false]              // attach 
full_html (debug)
     */
    export async function browseProduct(url, opts = {}) {
      const {
        navigationTimeoutMs = 30000,
        userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, 
like Gecko) Chrome/120 Safari/537.36',
        viewport = { width: 1366, height: 900 },
        headless = true,
        enforceEnglishHeuristic = true,
        productImageLimit = 2,
        includeHtml = false,
      } = opts;

      let browser;
      try {
        browser = await chromium.launch({ headless });
      } catch (err) {
        const msg = String(err || '');
        if (/Executable\s+doesn\'t\s+exist|failed\s+to\s+launch/i.test(msg)) {
          try {
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
        if (t === 'error' || t === 'warning') consoleLogs.push({ type: t, text: 
msg.text() });
      });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 
navigationTimeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 
navigationTimeoutMs }).catch(() => {});

        await acceptCookiesIfPresent(page);
        await autoExpand(page);

        // Explicitly click all hash-link tabs (e.g., Spectra's #tab-2)
        try {
          const tabLinks = await page.$$('[href^="#tab-"]');
          for (const link of tabLinks) {
            const href = await link.getAttribute('href');
            await link.click().catch(() => {});
            if (href) await page.waitForSelector(href, { timeout: 1000 
}).catch(() => {});
            await page.waitForTimeout(200);
          }
        } catch { /* ignore */ }

        // Trigger lazy-loads by scrolling
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 2000);
          await page.waitForTimeout(350);
        }

        // Optionally capture full HTML for debugging (not returned by default)
        const full_html = includeHtml ? await page.content() : null;

        // Collect primary artifacts
        let visible_text = await collectVisibleText(page);
        let sections = await collectSections(page);

        // Clean sections (and visible text) with English-line heuristic if 
enabled
        if (enforceEnglishHeuristic) {
          visible_text = filterEnglish(visible_text);

          const cleaned = {};
          for (const key of ['description', 'specifications', 'features', 
'included']) {
            cleaned[key] = filterEnglish(sections[key] || '');
          }
          // carry over dl and tabs (not filtered for fidelity)
          cleaned.dl = sections.dl || '';
          cleaned.tabs = sections.tabs || {};
          sections = cleaned;

          // Drop trivial placeholder features
          if (sections.features && sections.features.trim().toLowerCase() === 
'company info') {
            sections.features = '';
          }
        }

        const { links, links_extra } = await collectLinks(page, { 
productImageLimit });
        const seo_meta = await collectSeoMeta(page);
        const microdata = await collectMicrodata(page);
        const inline_data = await collectInlineData(page);
        const link_hints = await collectLinkHints(page);
        const shadow_text = await collectShadowText(page);
        const css_backgrounds = await collectCssBackgrounds(page);
        const images_with_alt = await collectImagesWithAlt(page);

        const payload = {
          source_url: url,
          fetched_at: new Date().toISOString(),
          ...(includeHtml ? { full_html } : {}), // excluded by default
          visible_text,
          sections, // includes .dl and .tabs
          links,    // Code B-compatible: {anchors, images, pdfs, jsons}
          seo_meta,
          console: consoleLogs,
        };

        return { ok: true, raw_browse: payload };
      } catch (err) {
        return { ok: false, error: String(err) };
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    }
