/* medx-ingest-api/server.js */
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { URL } from "node:url";
import net from "node:net";
import { parsePdfFromUrl } from './pdfParser.js';
import { enrichFromManuals } from './pdfEnrichment.js';
import { createWorker } from 'tesseract.js';
import { harvestTabsFromHtml } from './tabHarvester.js';



/* ================== Config via env ================== */
const RENDER_API_URL   = (process.env.RENDER_API_URL || "").trim(); // e.g. https://medx-render-api.onrender.com
const RENDER_API_TOKEN = (process.env.RENDER_API_TOKEN || "").trim(); // optional if renderer enforces auth
const MIN_IMG_PX_ENV   = parseInt(process.env.MIN_IMG_PX || "200", 10);
const EXCLUDE_PNG_ENV  = String(process.env.EXCLUDE_PNG || "false").toLowerCase() === "true";

// Hardening & performance knobs
const DEFAULT_RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || "20000", 10);
const MAX_TOTAL_TIMEOUT_MS      = parseInt(process.env.TOTAL_TIMEOUT_MS  || "30000", 10);
const MAX_HTML_BYTES            = parseInt(process.env.MAX_HTML_BYTES    || "3000000", 10); // ~3MB safety cap
const CACHE_TTL_MS              = parseInt(process.env.CACHE_TTL_MS      || "180000", 10); // 3 min
const CACHE_MAX_ITEMS           = parseInt(process.env.CACHE_MAX_ITEMS   || "100", 10);
const ENABLE_CACHE              = String(process.env.ENABLE_CACHE        || "true").toLowerCase() === "true";
const ENABLE_BASIC_SSRF_GUARD   = String(process.env.ENABLE_SSRF_GUARD   || "true").toLowerCase() === "true";

/* ================== App setup ================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/",  (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

// near the top, after app setup
app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/* ================== Utilities ================== */
function cid() { return crypto.randomBytes(6).toString("hex"); }
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeDecodeOnce(s){
  try {
    const decoded = decodeURIComponent(s);
    if (!decoded || /%[0-9A-Fa-f]{2}/.test(decoded)) return s;
    return decoded;
  } catch { return s; }
}

function cleanup(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function decodeHtml(s){
  return s
    ? s.replace(/&amp;/g,'&')
         .replace(/&quot;/g,'"')
         .replace(/&#39;/g,"'")
         .replace(/&lt;/g,'<')
         .replace(/&gt;/g,'>')
    : s;
}

function isHttpUrl(u){
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch { return false; }
}

function safeHostname(u){
  try { return new URL(u).hostname; } catch { return ""; }
}

function isIp(host){ return net.isIP(host) !== 0; }

function isPrivateIp(ip){
  if (!isIp(ip)) return false;
  const v4 = ip.split(".").map(n => parseInt(n,10));
  if (v4.length === 4){
    const [a,b] = v4;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
  }
  if (ip.includes(":")){
    const lower = ip.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower === "::1") return true;
    if (lower.startsWith("fe80")) return true;
  }
  return false;
}

function isLikelyDangerousHost(host){
  const lower = String(host || "").toLowerCase();
  if (!lower) return true;
  if (lower === "localhost") return true;
  if (lower.endsWith(".local") || lower.endsWith(".localhost")) return true;
  if (isPrivateIp(lower)) return true;
  return false;
}

function abs(base, link){
  try {
    if (!link) return link;
    if (/^https?:\/\//i.test(link)) return link;
    const u = new URL(base);
    if (link.startsWith('//')) return u.protocol + link;
    if (link.startsWith('/'))  return u.origin + link;
    const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^\/]*$/,'/');
    return u.origin + basePath + link;
  } catch(e){ return link; }
}

// Simple OCR helper using tesseract.js
async function ocrImageFromUrl(imageUrl) {
  const worker = await createWorker();
  try {
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    const { data: { text } } = await worker.recognize(imageUrl);
    return text;
  } finally {
    await worker.terminate();
  }
}

/* === NEW: Image classification helpers (ADD-ONLY) === */
function getAttrNumeric($el, name) {
  const v = String($el.attr(name) || "").trim();
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
function parseCssPx(val) {
  const m = /(\d+(\.\d+)?)\s*px/i.exec(String(val||""));
  return m ? parseFloat(m[1]) : 0;
}
function looksLikeSwatch($el, url) {
  const cls = String($el.attr('class') || '').toLowerCase();
  const alt = String($el.attr('alt')   || '').toLowerCase();
  const txt = cls + ' ' + alt + ' ' + String(url||'').toLowerCase();
  return /\b(swatch|variant[-_ ]?(chip|swatch)|color[-_ ]?option|pattern[-_ ]?swatch|fabric[-_ ]?swatch)\b/.test(txt);
}
function isHeroOrBanner($, el) {
  return $(el).closest(
    '.hero, .page-hero, .category-hero, .site-hero, .banner, .promo, .promo-banner, [role="banner"], #header, .header'
  ).length > 0;
}
function isPaymentOrTrustImage($el, url) {
  const text = (String($el.attr('alt') || $el.attr('title') || '') + ' ' + String(url||'')).toLowerCase();
  return /\b(visa|mastercard|amex|american[- ]?express|discover|paypal|klarna|affirm|afterpay|sezzle|shop[- ]?pay|apple[- ]?pay|google[- ]?pay|trust|badge|secure|ssl|bbb|norton|mcafee|authorize\.net|verisign|trustpilot|rating|stars?)\b/.test(text)
      || /\/(payment|payments|badges?|trust|seals?|icons?)\//.test(text);
}
function isLogoOrBrandMark($el, url) {
  const text = (String($el.attr('alt') || $el.attr('title') || '') + ' ' + String(url||'')).toLowerCase();
  return /\b(logo|brandmark|favicon)\b/.test(text) || /\/(logo|logos|brand|branding|favicon)\//.test(text);
}
function isMarketingOrUiImage($, $el, url){
  if (!url) return true;
  if (isHeroOrBanner($, $el)) return true;
  if (isPaymentOrTrustImage($el, url)) return true;
  if (isLogoOrBrandMark($el, url)) return true;
  const cls = String($el.attr('class') || '').toLowerCase();
  if (/(breadcrumb|menu|nav|sidebar|footer|social|icon|sprite)/.test(cls)) return true;
  return false;
}

/* === NEW: Site- & pattern-specific bad image URL filter (ADD-ONLY) === */
function isBadImageUrl(u, $el){
  if (!u) return true;
  let url = String(u).trim();
  try { url = decodeURIComponent(url); } catch {}
  url = url.toLowerCase();

  // Universal placeholders / UI
  if (/\/(placeholder|no[-_]?image|missingimage|blank|spacer|pixel|loader|preloader)\b/.test(url)) return true;
  if (/\b(logo|brandmark|favicon|sprite|icon|social|facebook|twitter|instagram|linkedin)\b/.test(url)) return true;

  // Banners / promos / theme builder assets
  if (/\/(banner|banners|promo|promotions?|slides?|slider|rbslider|theme_options)\//.test(url)) return true;
  if (/\/wysiwyg\/.*(banner|payment|footer)/.test(url)) return true;

  // Payments / trust badges
  if (/\/(payment|payments|trust|badge|badges|seals?)\//.test(url)) return true;

  // Specific reported offenders
  if (/unicosci\.com\/media\/wysiwyg\/footer-image\/payment\.png/.test(url)) return true;
  if (/unicosci\.com\/media\/aw_rbslider\/slides\//.test(url)) return true;
  if (/unicosci\.com\/media\/theme_options\/websites\//.test(url)) return true;
  if (/compasshealthbrands\.com\/media\/images\/items\/noimage/i.test(url)) return true;

  // McKesson packaging-angle variants
  if (/imgcdn\.mckesson\.com\/cumulusweb\/images\/item_detail\/\d+_ppkg(?:left|right|back)\d*\.jpg/.test(url)) return true;

  // Thumbs / swatches
  if (/\b(thumb|thumbnail|swatch)\b/.test(url)) return true;

  // Very small via query params (e.g., ?w=120 or ?height=150)
  try {
    const qs = new URL(u).searchParams;
    const w = parseInt(qs.get('w') || qs.get('width') || qs.get('size') || '0', 10);
    const h = parseInt(qs.get('h') || qs.get('height') || '0', 10);
    if ((w && w < 300) || (h && h < 300)) return true;
  } catch {}

  // Element hints
  if ($el && $el.length){
    const hint = (String($el.attr('class')||'') + ' ' + String($el.attr('alt')||'') + ' ' + String($el.attr('title')||'')).toLowerCase();
    if (/\b(payment|visa|mastercard|paypal|klarna|afterpay|trust|secure|badge|banner|hero)\b/.test(hint)) return true;
  }
  return false;
}

/* ================== ADD-ONLY helpers for image/CDN/manual capture ================== */
function getRegistrableDomain(host) {
  try {
    const parts = String(host||"").toLowerCase().split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const twoPartTLD = new Set(["co.uk","org.uk","gov.uk","ac.uk","com.au","net.au","co.jp"]);
    const last2 = parts.slice(-2).join(".");
    const last3 = parts.slice(-3).join(".");
    return twoPartTLD.has(last2) ? last3 : last2;
  } catch { return String(host||"").toLowerCase(); }
}

function isSameSiteOrCdn(baseUrl, otherUrl) {
  try {
    const a = new URL(baseUrl);
    const b = new URL(otherUrl);
    const aReg = getRegistrableDomain(a.hostname);
    const bReg = getRegistrableDomain(b.hostname);
    if (a.hostname === b.hostname) return true;
    if (aReg && bReg && aReg === bReg) return true;
    if (/(cdn|cloudfront|akamai|akamaized|azureedge|fastly|shopifycdn|bigcommerce|mzstatic|cdn.shopify)/i.test(b.hostname)) return true;
    return false;
  } catch { return false; }
}

// --- Compass helpers (ADD-ONLY) ---
function isCompassHost(u){
  try { return /(^|\.)compasshealthbrands\.com$/i.test(new URL(u).hostname); }
  catch { return false; }
}
function isCompassPlaceholder(u){
  try { return isCompassHost(u) && /\/media\/images\/items\/noimage/i.test(u);
  } catch { return false; }
}

function isMainProductNode($, el) {
  const $el = $(el);
  if (!$el || !$el.length) return false;
  if ($el.closest('[itemscope][itemtype*="Product" i]').length) return true;
  if ($el.closest('.product, .product-page, .product-detail, .product-details, #product, [id*="product" i]').length) return true;
  if ($el.closest('.product-media, .product__media, .product-gallery, #product-gallery, [data-gallery]').length) return true;
  return $el.closest('main,#main,.main,#content,.content,article').length > 0;
}

function findMainProductScope($) {
  const scopes = [
    '[itemscope][itemtype*="Product" i]',
    '.product, .product-detail, .product-details, #product',
    '.product-media, .product__media, .product-gallery, #product-gallery, [data-gallery]',
    'main, #main, .main, #content, .content, article'
  ];
  for (const sel of scopes) {
    const $hit = $(sel).first();
    if ($hit && $hit.length) return $hit;
  }
  return $.root();
}

function scoreByContext($, node, { mainOnly=false } = {}) {
  if (isRecoBlock($, node) || isFooterOrNav($, node)) return -999;
  const inMain = isMainProductNode($, node);
  if (mainOnly) return inMain ? 2 : -999;
  return inMain ? 2 : 0;
}

function keyForImageDedup(url) {
  const u = String(url||"");
  const base = u.split("/").pop().split("?")[0];
  const size = (u.match(/(\d{2,5})x(\d{2,5})/) || []).slice(1).join("x");
  return size ? `${base}#${size}` : base;
}

function dedupeImageObjs(cands, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const c of cands) {
    const k = keyForImageDedup(c.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: c.url });
    if (out.length >= limit) break;
  }
  return out;
}

function dedupeManualUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const k = u.replace(/#.*$/,'').trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/* ================== HTML cache (TTL + naive LRU) ================== */
const htmlCache = new Map(); // key -> { html, expires, last }

function cacheGet(key){
  if (!ENABLE_CACHE) return null;
  const hit = htmlCache.get(key);
  if (!hit) return null;
  if (hit.expires < now()){
    htmlCache.delete(key);
    return null;
  }
  hit.last = now();
  return hit.html;
}

function cacheSet(key, html){
  if (!ENABLE_CACHE) return;
  if (htmlCache.size >= CACHE_MAX_ITEMS){
    let oldestK = null, oldestT = Infinity;
    for (const [k,v] of htmlCache.entries()){
      if (v.last < oldestT){ oldestT = v.last; oldestK = k; }
    }
    if (oldestK) htmlCache.delete(oldestK);
  }
  htmlCache.set(key, { html, expires: now() + CACHE_TTL_MS, last: now() });
}

/* ================== Robust fetch with retry/timeout ================== */
async function fetchWithRetry(endpoint, { headers, attempts=3, timeoutMs=DEFAULT_RENDER_TIMEOUT_MS, initialBackoff=600 }) {
  let lastErr = null, lastStatus = 0, lastBody = "";
  for (let i=1, delay=initialBackoff; i<=attempts; i++, delay = Math.floor(delay * 1.8)) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(new Error("render-timeout")), timeoutMs);
    try{
      const r = await fetch(endpoint, { headers, signal: ctrl.signal, redirect: "follow" });
      lastStatus = r.status;
      if (r.ok){
        const buf = await r.arrayBuffer();
        if (buf.byteLength > MAX_HTML_BYTES) throw new Error(`html-too-large(${buf.byteLength})`);
        return { html: Buffer.from(buf).toString("utf8"), status: r.status };
      }
      lastBody = (await r.text().catch(()=> "")) || "";
      lastErr = new Error(`render-status-${r.status}`);
    }catch(e){
      lastErr = e;
      lastBody = String((e && e.message) || e);
    }finally{
      clearTimeout(to);
    }
    if (i < attempts){
      const jitter = Math.floor(Math.random()*0.3*delay);
      await sleep(delay + jitter);
    }
  }
  const err = new Error(`Render API failed: status=${lastStatus} body=${String(lastBody).slice(0,280)}`);
  err.status = lastStatus;
  throw err;
}

async function fetchDirectHtml(url, { headers={}, timeoutMs=DEFAULT_RENDER_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error("direct-timeout")), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) {
      const err = new Error(`direct-fetch-status-${r.status}`);
      err.status = r.status;
      throw err;
    }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) throw new Error(`html-too-large(${buf.byteLength})`);
    return Buffer.from(buf).toString("utf8");
  } finally {
    clearTimeout(to);
  }
}

function mergeDescriptions(a = "", b = "") {
  const seen = new Set();
  const lines = (a + "\n" + b)
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);
  const out = [];
  for (const l of lines) {
    const k = l.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  return out.join("\n");
}

function toTitleCase(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, c => c.toUpperCase());
}

function splitIntoSentences(t = "") {
  return String(t)
    // Split sentences not only on punctuation but also on newlines and bullet/dash markers.
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+|(?:^|\s)[\u2022\-]\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/* ================== Ingest route ================== */
/**
 * GET /ingest?url=<https://...>&selector=.css&wait=ms&timeout=ms&mode=fast|full
 * &minpx=200&excludepng=true&aggressive=true
 * &harvest=true&sanitize=true
 * &markdown=true
 * &debug=true
 * &mainonly=true   <-- ADD-ONLY flag to restrict to main product scope
 */
app.get("/ingest", async (req, res) => {
  const started = now();
  const reqId = cid();
  const debug = String(req.query.debug || "false").toLowerCase() === "true";
  const diag = { reqId, warnings: [], timings: {} };

  try {
    const rawUrl = String(req.query.url || "");
    if (!rawUrl) return res.status(400).json({ error: "Missing url param" });

    const targetUrl = safeDecodeOnce(rawUrl);
    if (!isHttpUrl(targetUrl)) return res.status(400).json({ error: "Invalid url param" });

    const host = safeHostname(targetUrl);
    if (ENABLE_BASIC_SSRF_GUARD && isLikelyDangerousHost(host)){
      return res.status(400).json({ error: "Blocked host" });
    }

    if (!RENDER_API_URL) return res.status(500).json({ error: "RENDER_API_URL not set" });

    const selector = req.query.selector ? `&selector=${encodeURIComponent(String(req.query.selector))}` : "";
    const wait     = req.query.wait     != null ? `&wait=${encodeURIComponent(String(req.query.wait))}` : "";
    const timeout  = req.query.timeout  != null ? `&timeout=${encodeURIComponent(String(req.query.timeout))}` : "";
    // Prefer fully rendered pages by default so that dynamic content (e.g. hooks
    // injected after initial load) is available to downstream parsers.  If a
    // client explicitly passes a mode, honour it; otherwise default to full.
    const mode     = req.query.mode ? `&mode=${encodeURIComponent(String(req.query.mode))}` : "&mode=full";

    const minImgPx   = Number.isFinite(parseInt(String(req.query.minpx),10)) ? parseInt(String(req.query.minpx),10) : MIN_IMG_PX_ENV;
    const excludePng = typeof req.query.excludepng !== "undefined"
      ? String(req.query.excludepng).toLowerCase() === "true"
      : EXCLUDE_PNG_ENV;

    const aggressive = String(req.query.aggressive || "false").toLowerCase() === "true";
    const doSanitize = String(req.query.sanitize  || "false").toLowerCase() === "true";
    const doHarvest  = req.query.harvest != null
      ? String(req.query.harvest).toLowerCase() === "true"
      : true;
    const wantMd     = String(req.query.markdown  || "false").toLowerCase() === "true";
    const mainOnly   = String(req.query.mainonly  || "false").toLowerCase() === "true"; // ADD-ONLY
    const wantPdf    = String(req.query.pdf || "false").toLowerCase();

    const endpoint = `${RENDER_API_URL.replace(/\/+$/,"")}/render?url=${encodeURIComponent(targetUrl)}${selector}${wait}${timeout}${mode}`;

    const headers = { "User-Agent": "MedicalExIngest/1.7" };
    if (RENDER_API_TOKEN) headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;

    const cacheKey = `render:${endpoint}`;
    let html = cacheGet(cacheKey);
    let fetched = false;
    if (!html){
      const t0 = now();

      let rendered = "";
      try {
        const r = await fetchWithRetry(endpoint, { headers });
        rendered = r.html;
      } catch (e) {
        const status = e && e.status ? Number(e.status) : 0;
        if (status === 502 || status === 503 || status === 504) {
          diag.warnings.push(`render-upstream-${status}; falling back to direct fetch`);
          try {
            rendered = await fetchDirectHtml(targetUrl, { headers });
          } catch (e2) {
            throw e;
          }
        } else {
          throw e;
        }
      }
      diag.timings.renderMs = now() - t0;
      html = rendered;
      cacheSet(cacheKey, html);
      fetched = true;

    } else {
      diag.timings.cacheHit = true;
    }

    const t1 = now();
    let norm = extractNormalized(targetUrl, html, { minImgPx, excludePng, aggressive, diag, mainOnly }); // ADD-ONLY pass mainOnly
    diag.timings.extractMs = now() - t1;

    if (!norm.name_raw && (!norm.description_raw || norm.description_raw.length < 10)) {
      return res.status(422).json({ error: "No extractable product data (JSON-LD/DOM empty)." });
    }

    if (doHarvest) {
      const t2 = now();
      norm = await augmentFromTabs(norm, targetUrl, html, { minImgPx, excludePng, mainOnly }); // ADD-ONLY propagate
      diag.timings.harvestMs = now() - t2;
    }

    // === MEDX ADD: optionally enrich from PDF manuals ===
    if (wantPdf === "true" || wantPdf === "1" || wantPdf === "yes") {
      try {
        norm = await enrichFromManuals(norm, { maxManuals: 3, maxCharsText: 20000 });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        diag.warnings.push(`pdf-enrich: ${msg}`);
      }
    }

    // === Compass-only additive harvest (keeps your existing data intact) ===
    if (isCompass(targetUrl)) {
      const $ = cheerio.load(html);

      // (1) Overview: full paragraphs + bullets (merged once)
      try {
        const compassOverview = harvestCompassOverview($);
        if (compassOverview) {
          const seen = new Set(String(norm.description_raw || "")
            .split(/\n+/).map(s=>s.trim().toLowerCase()).filter(Boolean));

          const merged = [];
          for (const l of String(norm.description_raw || "").split(/\n+/).map(s=>s.trim()).filter(Boolean)) merged.push(l);
          for (const l of String(compassOverview).split(/\n+/).map(s=>s.trim()).filter(Boolean)) {
            const k = l.toLowerCase();
            if (!seen.has(k)) { merged.push(l); seen.add(k); }
          }
          norm.description_raw = merged.join("\n");
        }
      } catch(e){
        const msg = e && e.message ? e.message : String(e);
        diag.warnings.push(`compass-overview: ${msg}`);
      }

      // (2) Technical Specifications (union-merge; existing keys win)
      try {
        const compassSpecs = harvestCompassSpecs($);
        if (Object.keys(compassSpecs).length) {
          norm.specs = { ...(norm.specs || {}), ...compassSpecs };
        }
      } catch(e){
        const msg = e && e.message ? e.message : String(e);
        diag.warnings.push(`compass-specs: ${msg}`);
      }
    }
    // === end Compass-only additions ===

    /* ==== MEDX ADD-ONLY: final spec enrichment before sanitize v1 ==== */
    try { norm.specs = enrichSpecsWithDerived(norm.specs || {}); } catch {}

    if (wantMd) {
      const $ = cheerio.load(html);
      try { norm.description_md = extractDescriptionMarkdown($) || textToMarkdown(norm.description_raw || ""); }
      catch(e){ diag.warnings.push(`desc-md: ${e.message||e}`); }

      try { norm.features_md = (norm.features_raw || []).map(t => `- ${t}`).join("\n"); } catch(e){}
      try { norm.specs_md    = objectToMarkdownTable(norm.specs || {}); } catch(e){}
    }

    if (doSanitize) {
      norm = sanitizeIngestPayload(norm);
      if (wantMd) {
        norm.features_md = (norm.features_raw || []).map(t => `- ${t}`).join("\n");
        norm.specs_md    = objectToMarkdownTable(norm.specs || {});
        if (!norm.description_md) norm.description_md = textToMarkdown(norm.description_raw || "");
      }
    }

    const totalMs = now() - started;
    if (totalMs > MAX_TOTAL_TIMEOUT_MS){
      diag.warnings.push(`total-timeout ${totalMs}ms`);
    }

    if (debug) return res.json({ ...norm, _debug: { ...diag, fetched } });
    return res.json(norm);

  } catch (e) {
    console.error("INGEST ERROR:", e);
    const status = e && e.status && Number.isFinite(+e.status) ? Number(e.status) : 500;
    return res.status(status >= 400 && status <= 599 ? status : 500).json({ error: String((e && e.message) || e) });
  }
});

// GET /parse-pdf?url=<PDF_URL>
app.get('/parse-pdf', async (req, res) => {
  const pdfUrl = String(req.query.url || '');
  if (!pdfUrl) return res.status(400).json({ error: 'Missing url param' });
  try {
    const result = await parsePdfFromUrl(pdfUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /ocr?image=<IMAGE_URL>
app.get('/ocr', async (req, res) => {
  const imageUrl = String(req.query.image || '');
  if (!imageUrl) return res.status(400).json({ error: 'Missing image param' });
  try {
    const text = await ocrImageFromUrl(imageUrl);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

/* ================== Normalization ================== */
function extractNormalized(baseUrl, html, opts) {
  const { diag } = opts || {};
  const $ = cheerio.load(html);

  // Structured data
  let jsonld = {};
  try { jsonld = extractJsonLd($); }
  catch(e){ diag && diag.warnings.push(`jsonld: ${e.message||e}`); }

  let micro = {};
  try { micro = extractMicrodataProduct($); }
  catch(e){ diag && diag.warnings.push(`microdata: ${e.message||e}`); }

  let rdfa = {};
  try { rdfa = extractRdfaProduct($); }
  catch(e){ diag && diag.warnings.push(`rdfa: ${e.message||e}`); }

  const mergedSD = mergeProductSD(jsonld, micro, rdfa);

  // OpenGraph (+ product tags)
  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content") || $('meta[property="og:image:secure_url"]').attr("content") || "",
    product: extractOgProductMeta($)
  };

  // ==== FIX: define name and brand before using them ====
  const name = cleanup(mergedSD.name || og.title || $("h1").first().text());
  let brand = cleanup(mergedSD.brand || "");
  if (!brand && name) brand = inferBrandFromName(name);
  // =====================================================

  let description_raw = cleanup(
    mergedSD.description || (() => {
      // 1) Prefer obvious description containers
      const selectors = [
        '[itemprop="description"]',
        '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description, .overview, .product-overview, .intro, .summary',
        '.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-tabs',
        // generic safety net: any node with "description/details/overview/copy" in id or class
        '[id*="description" i], [class*="description" i], [id*="details" i], [class*="details" i], [id*="overview" i], [class*="overview" i], [id*="copy" i], [class*="copy" i]'
      ].join(', ');

      let best = "";
      $(selectors).each((_, el) => {
        // ADD: skip footer/nav wrappers & legal-like text
        if (isFooterOrNav($, el)) return;
        const elText = cleanup($(el).text() || "");
        if (!elText) return;
        if (LEGAL_MENU_RE.test(elText) || /^©\s?\d{4}/.test(elText)) return;

        const $el = $(el);
        // headings + lead + paragraphs feel like a true description
        const text = [
          $el.find('h1,h2,h3,h4,h5,strong,b,.lead,.intro').map((i, n) => $(n).text()).get().join(' '),
          $el.find('p').map((i, n) => $(n).text()).get().join(' ')
        ].join(' ');
        const cleaned = cleanup(text);
        if (cleaned && cleaned.length > cleanup(best).length) best = cleaned;
      });

      // 2) Fallback: longest paragraph anywhere in main content (skip footer/nav)
      if (!best) {
        const scope = $('main,#main,.main,#content,.content').first(); // avoid body-wide scan
        const paras = scope.find('p').map((i, el) => {
          if (isFooterOrNav($, el)) return "";
          const t = cleanup($(el).text());
          return LEGAL_MENU_RE.test(t) ? "" : t;
        }).get().filter(Boolean);

        best = paras.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), "");
      }
      return best || "";
    })() || og.description || $('meta[name="description"]').attr('content') || ""
  );

  const images  = extractImages($, mergedSD, og, baseUrl, name, html, opts);
  const manuals = extractManuals($, baseUrl, name, html, opts);

  /* ================== SKU Helpers (ADD-ONLY) ================== */
  function _normSkuVal(v){
    return String(v||"").trim().replace(/\s+/g, " ");
  }
  
  function _isLikelyGtinOnly(s){
    // Reject plain 8/12/13/14 digit GTIN-like values when no letters are present
    const digits = s.replace(/\D+/g,'');
    return /^\d+$/.test(s) && [8,12,13,14].includes(digits.length);
  }
  
  const _skuKeySynonyms = [
    // high confidence first
    "sku","productid","product_id","product-id","retailer_item_id","retailer:sku","item_number","item_no","item #","item",
    "model_number","model no","model #","model",
    "part_number","part no","part #","part",
    "product_code","product code","code","id"
  ];
  
  function _collectSkuCandidates($, { mergedSD={}, og={}, html="", name="", brand="" }){
    const out = [];
  
    const push = (val, how, label="")=>{
      const v = _normSkuVal(val);
      if (!v) return;
      if (_isLikelyGtinOnly(v)) return; // avoid GTIN-only values as "SKU"
      out.push({ v, how, label });
    };
  
    // 1) Structured data specs first
    const sdSpecs = mergedSD.specs || {};
    for (const k of Object.keys(sdSpecs)){
      const kl = k.toLowerCase().replace(/[\s_-]+/g,'');
      if (_skuKeySynonyms.includes(kl)) push(sdSpecs[k], "sd-spec", k);
    }
    // JSON-LD common top-levels mapped via mergeProductSD already ended up in specs,
    // but keep a light extra check:
    if (mergedSD && mergedSD.name && sdSpecs && sdSpecs.sku) push(sdSpecs.sku, "sd-direct", "sku");
  
    // 2) OpenGraph product extras (e.g., product:retailer_item_id)
    if (og && og.product){
      const ogk = og.product;
      for (const k of Object.keys(ogk)){
        const kl = k.toLowerCase().replace(/[\s:_-]+/g,'');
        if (_skuKeySynonyms.includes(kl)) push(ogk[k], "og-product", k);
      }
    }
  
    // 3) Explicit DOM selectors
    // itemprop=sku
    $('[itemprop="sku"]').each((_, el)=>{
      const $el = $(el);
      const v = $el.attr('content') || $el.text();
      push(v, "dom:itemprop=sku");
    });
    // data-* attributes that often carry sku
    $('[data-sku],[data-product-sku],[data-productid],[data-item],[data-item-number],[data-model-number]').each((_, el)=>{
      const $el = $(el);
      const v = $el.attr('data-sku') || $el.attr('data-product-sku') || $el.attr('data-productid') ||
                $el.attr('data-item') || $el.attr('data-item-number') || $el.attr('data-model-number');
      push(v, "dom:data-attr");
    });
  
    // 4) Labeled key:value in tables/lists/paras (SKU:, Product ID:, Item #, Model No., Code, etc.)
    const labelRx = /\b(sku|product\s*id|productid|item\s*(?:number|no|#)?|model\s*(?:number|no|#)?|part\s*(?:number|no|#)?|product\s*code|code|id)\b/i;
    const kvRx    = /\b(?:sku|product\s*id|productid|item\s*(?:number|no|#)?|model\s*(?:number|no|#)?|part\s*(?:number|no|#)?|product\s*code|code|id)\b[:\s#-]*([A-Za-z0-9][A-Za-z0-9._\-\/]{1,60})/i;
  
    $('tr, li, p, dt, dd').each((_, el)=>{
      const t = ($(el).text() || "").replace(/\s+/g,' ').trim();
      if (!labelRx.test(t)) return;
      const m = kvRx.exec(t);
      if (m && m[1]) push(m[1], "dom:labeled");
    });
  
    // 5) Very light URL hint (only if explicitly labeled param present)
    try {
      const u = new URL((html.match(/<base[^>]*href="([^"]+)"/i)?.[1]) || "") // prefer <base> if present
             || new URL(location.href); // fallback (ignored in SSR)
      const params = ["sku","productid","item","item_number","model","code","id"];
      for (const p of params){
        const v = u.searchParams.get(p);
        if (v) push(v, "url:param", p);
      }
    } catch {}
  
    // Scoring & selection
    const seen = new Set();
    const uniq = [];
    for (const c of out){
      const key = c.v.toLowerCase();
      if (!seen.has(key)){ seen.add(key); uniq.push(c); }
    }
  
    const score = (c)=>{
      let s = 0;
      if (c.how.startsWith("sd"))            s += 5;
      else if (c.how === "og-product")       s += 4;
      else if (c.how === "dom:itemprop=sku") s += 4;
      else if (c.how === "dom:data-attr")    s += 3;
      else if (c.how === "dom:labeled")      s += 3;
      else if (c.how === "url:param")        s += 1;
  
      // Prefer alpha-numeric mixes; de‑prefer very short or very long
      if (/[A-Za-z]/.test(c.v) && /\d/.test(c.v)) s += 2;
      if (c.v.length >= 3 && c.v.length <= 40)     s += 1;
  
      return s;
    };
  
    uniq.sort((a,b)=> score(b)-score(a));
  
    return uniq.map(o=>o.v);
  }
  
  function resolveSku($, ctx){
    const cands = _collectSkuCandidates($, ctx);
    return cands[0] || ""; // pick best
  }

  /* ==== ADD-ONLY: merge extra images/manuals from enhanced passes ==== */
  try {
    const extraImgs = extractImagesPlus($, mergedSD, og, baseUrl, name, html, opts);
    if (extraImgs && extraImgs.length) {
      const combined = [...(images||[]).map(i => ({ url: i.url })), ...extraImgs];
      const ranked = combined
        .map(x => ({ url: x.url, score: /cdn|cloudfront|akamai|uploads|product|gallery/i.test(x.url) ? 2 : 0 }))
        .sort((a,b)=> b.score - a.score);
      const deduped = dedupeImageObjs(ranked, 12);
      images.length = 0; deduped.forEach(x => images.push(x));
    }
  } catch {}

  try {
    const extraMans = extractManualsPlus($, baseUrl, name, html, opts);
    if (extraMans && extraMans.length) {
      const combined = dedupeManualUrls([ ...(manuals||[]), ...extraMans ]);
      manuals.length = 0; combined.forEach(x => manuals.push(x));
    }
  } catch {}
  /* ==== END ADD-ONLY ==== */

  let specs    = Object.keys(mergedSD.specs || {}).length ? mergedSD.specs : extractSpecsSmart($);

  /* ==== MEDX ADD-ONLY: merge extras from embedded JSON v1 ==== */
  try {
    const extraJsonSpecs = extractSpecsFromScripts($);
    if (extraJsonSpecs && Object.keys(extraJsonSpecs).length) {
      specs = mergeSpecsAdditive(specs, extraJsonSpecs);
    }
  } catch {}

  /* ==== MEDX ADD-ONLY: merge JSON-LD specs from all Product nodes v1 ==== */
  try {
    const jsonldAll = extractJsonLdAllProductSpecs($); // (ADD: now internally constrained to same page)
    if (jsonldAll && Object.keys(jsonldAll).length) {
      specs = mergeSpecsAdditive(specs, jsonldAll);
    }
  } catch {}

  /* ==== MEDX ADD-ONLY: global K:V sweep to fill remaining gaps v1 ==== */
  try {
    const globalPairs = extractAllSpecPairs($);
    if (globalPairs && Object.keys(globalPairs).length) {
      specs = mergeSpecsAdditive(specs, globalPairs);
    }
  } catch {}

  // ==== ADD: prune parts/accessories noise from specs (add-only) ====
  try { specs = prunePartsLikeSpecs(specs); } catch {}

  // Collect features both from structured data tabs and from paragraphs/lists to ensure
  // bullet lists in Product Description or similar sections are captured.  Always combine
  // features extracted from the page with any structured-data features, then deduplicate.
  const featSmart = extractFeaturesSmart($);
  const featPara  = deriveFeaturesFromParagraphs($);
  // Limit the number of features to a higher count to avoid truncating bullet lists.
  let features = dedupeList([...(featSmart || []), ...(featPara || [])]).slice(0, 40);
  if (mergedSD.features && mergedSD.features.length) {
    features = dedupeList([...(mergedSD.features || []), ...features]).slice(0, 40);
  }

  const imgs = images.length ? images : fallbackImagesFromMain($, baseUrl, og, opts);
  const mans = manuals.length ? manuals : fallbackManualsFromPaths($, baseUrl, name, html);

  if (!features.length) features = deriveFeaturesFromParagraphs($);
  if (!Object.keys(specs).length) specs = deriveSpecsFromParagraphs($);
  if (!description_raw) description_raw = firstGoodParagraph($);
  const sku_final = resolveSku($, { mergedSD, og, html, name, brand });

  return {
    source: baseUrl,
    name_raw: name,
    description_raw,
    specs,
    features_raw: features,
    images: imgs,
    manuals: mans,
    brand,
    sku: sku_final
  };
}
/* ================== Structured Data Extractors ================== */
function schemaPropsToSpecs(props){
  const out = {};
  try{
    (props || []).forEach(p=>{
      const k=(p.name||p.property||'').toString().trim().toLowerCase().replace(/\s+/g,'_');
      const v=(p.value||p['@value']||p.description||'').toString().trim();
      if (k && v) out[k]=v;
    });
  }catch{}
  return out;
}

function extractJsonLd($){
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      if (!raw || !raw.trim()) return;
      const parsed = JSON.parse(raw.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      arr.forEach(obj => {
        if (obj && obj['@graph'] && Array.isArray(obj['@graph'])) {
          obj['@graph'].forEach(g => nodes.push(g));
        } else {
          nodes.push(obj);
        }
      });
    } catch {}
  });

  const prodCandidates = nodes.filter(n => {
    const t = String(n && n['@type'] || '').toLowerCase();
    return t.includes('product') || n.name || n.offers || n.sku || n.mpn;
  });

  const p = prodCandidates[0] || {};

  const images = (() => {
    const img = p.image;
    if (!img) return [];
    if (Array.isArray(img)) {
      return img.map(v => (typeof v === 'string' ? v : (v.url || v.contentUrl || v['@id'] || ''))).filter(Boolean);
    }
    if (typeof img === 'object') return [p.image.url || p.image.contentUrl || p.image['@id']].filter(Boolean);
    if (typeof img === 'string')  return [img];
    return [];
  })();

  // Heuristic: filter structured-data images to avoid unrelated product pictures.
  // Some pages embed multiple images in JSON-LD, including other products from the same brand.
  // We assume the true product images share a common filename prefix (letters/digits) with
  // the first image.  If more than 3 images are present, derive a prefix from the first
  // filename and keep only those images whose basename starts with that prefix.  Finally
  // limit to the first 3 images after filtering.
  let filteredImages = images;
  try {
    if (images.length > 3) {
      const firstName = String(images[0] || '').split('/').pop().split('?')[0] || '';
      // Extract initial alphanumeric prefix (e.g., BSBCWB from BSBCWB_Prod2.jpg)
      const prefixMatch = firstName.match(/^([A-Za-z0-9]+)/);
      const prefix = prefixMatch ? prefixMatch[1] : firstName.split('_')[0];
      if (prefix && prefix.length >= 3) {
        filteredImages = images.filter(u => {
          const fname = String(u || '').split('/').pop().split('?')[0] || '';
          return fname.startsWith(prefix);
        });
      }
      // In case the filter removes all images, fall back to original list
      if (!filteredImages.length) filteredImages = images;
      // Limit to the first 3 images to reduce noise
      filteredImages = filteredImages.slice(0, 3);
    }
  } catch {}

  const specs = schemaPropsToSpecs(
    p.additionalProperty || p.additionalProperties || (p.additionalType === "PropertyValue" ? [p] : [])
  );

  const features = Array.isArray(p.featureList) ? p.featureList : [];

  const addKV = {};
  ["sku","mpn","gtin13","gtin14","gtin12","gtin8","productID","color","size","material","model","category"]
    .forEach(k => { if (p[k]) addKV[k] = String(p[k]); });

  // Only include availability information from offers.  Prices and currencies are intentionally
  // omitted since pricing information is not needed for product integration.
  const offer = Array.isArray(p.offers) ? p.offers[0] : (p.offers || {});
  if (offer && offer.availability) {
    addKV["availability"] = String(offer.availability).split('/').pop();
  }

    return {
    name: p.name || '',
    description: p.description || '',
    brand: (p.brand && (p.brand.name || p.brand)) || '',
    specs: { ...specs, ...addKV },
    features,
    images: filteredImages
  };
}

function extractMicrodataProduct($){
  const out = { specs: {}, images: [], features: [] };
  const $prod = $('[itemscope][itemtype*="Product"]').first();
  if (!$prod.length) return out;

  const getProp = (prop) => {
    const el = $prod.find(`[itemprop="${prop}"]`).first();
    if (!el.length) return "";
    if (el.is("meta")) return cleanup(el.attr("content") || "");
    if (el.is("img"))  return cleanup(el.attr("src") || el.attr("data-src") || "");
    return cleanup(el.text() || "");
  };

  out.name = getProp("name");
  out.description = getProp("description");

  const brandEl = $prod.find('[itemprop="brand"]').first();
  if (brandEl.length){
    const bName = brandEl.find('[itemprop="name"]').first().text() || brandEl.attr("content") || brandEl.text();
    out.brand = cleanup(bName);
  }

  ["sku","mpn","gtin13","gtin14","gtin12","gtin8","productID","color","size","material","model","category"].forEach(k=>{
    const v = getProp(k);
    if (v) out.specs[k] = v;
  });

  const offers = $prod.find('[itemprop="offers"]').first();
  if (offers.length){
    // Extract only availability; omit price and currency data for this integration
    const avail = offers.find('[itemprop="availability"]').attr("href") || offers.find('[itemprop="availability"]').text();
    if (avail) out.specs["availability"] = cleanup(String(avail).split('/').pop());
  }

  $prod.find('[itemprop="image"]').each((_, el)=>{
    const $el = $(el);
    const src = $el.is("meta") ? $el.attr("content") : ($el.attr("src") || $el.attr("data-src"));
    if (src) out.images.push(src);
  });

  return out;
}

function extractRdfaProduct($){
  const out = { specs: {}, images: [], features: [] };
  const $prod = $('[typeof*="Product"]').first();
  if (!$prod.length) return out;

  const getProp = (prop) => {
    const el = $prod.find(`[property="${prop}"]`).first();
    if (!el.length) return "";
    if (el.is("meta")) return cleanup(el.attr("content") || "");
    if (el.is("img"))  return cleanup(el.attr("src") || el.attr("data-src") || "");
    return cleanup(el.text() || el.attr("content") || "");
  };

  out.name = getProp("name");
  out.description = getProp("description") || getProp("summary");
  out.brand = getProp("brand") || getProp("manufacturer");

  ["sku","mpn","gtin13","gtin14","gtin12","gtin8","productID","color","size","material","model","category"].forEach(k=>{
    const v = getProp(k);
    if (v) out.specs[k] = v;
  });

  // Omit price and currency properties for this integration
  // const price = getProp("price");
  // const cur   = getProp("priceCurrency");
  // if (price) out.specs["price"] = price;
  // if (cur)   out.specs["price_currency"] = cur;

  $prod.find('[property="image"]').each((_, el)=>{
    const $el = $(el);
    const src = $el.is("meta") ? $el.attr("content") : ($el.attr("src") || $el.attr("data-src"));
    if (src) out.images.push(src);
  });

  return out;
}

function extractOgProductMeta($){
  const out = {};
  $('meta[property^="product:"]').each((_, el) => {
    const p = String($(el).attr("property") || "");
    const v = String($(el).attr("content")  || "");
    if (!p || !v) return;
    // Skip price-related OpenGraph product fields (e.g., product:price:amount, product:price:currency)
    if (/^product:price/i.test(p)) return;
    const key = p.replace(/^product:/,'').replace(/:/g,'_');
    out[key] = v;
  });
  return out;
}

function mergeProductSD(a={}, b={}, c={}){
  const pick = (x,y)=> x && String(x).trim() ? x : y;
  const name        = pick(a.name,        pick(b.name,        c.name));
  const description = pick(a.description, pick(b.description, c.description));
  const brand       = pick(a.brand,       pick(b.brand,       c.brand));
  const images = [...new Set([...(a.images||[]), ...(b.images||[]), ...(c.images||[])])];
  // Apply a prefix-based heuristic to filter out images belonging to other products.
  // Many e-commerce sites include images of related or variant items in microdata/RDFa. We derive
  // a prefix from the filename of the first image and retain only images that start with that
  // prefix. If more than 3 images are present, limit the list to three. If filtering removes all
  // images, fall back to the original list.
  let filteredImages = images;
  try {
    if (images.length > 3) {
      const firstName = String(images[0] || '').split('/').pop().split('?')[0] || '';
      const prefixMatch = firstName.match(/^([A-Za-z0-9]+)/);
      const prefix = prefixMatch ? prefixMatch[1] : firstName.split('_')[0];
      if (prefix && prefix.length >= 3) {
        filteredImages = images.filter(u => {
          const fname = String(u || '').split('/').pop().split('?')[0] || '';
          return fname.startsWith(prefix);
        });
      }
      if (!filteredImages.length) filteredImages = images;
      filteredImages = filteredImages.slice(0, 3);
    }
  } catch {}
  const specs  = { ...(c.specs || {}), ...(b.specs || {}), ...(a.specs || {}) };

  const feats  = [];
  const seen   = new Set();
  [ ...(a.features||[]), ...(b.features||[]), ...(c.features||[]) ].forEach(t=>{
    const k = String(t||"").toLowerCase();
    if (k && !seen.has(k)){ seen.add(k); feats.push(t); }
  });

  return { name, description, brand, images: filteredImages, specs, features: feats };
}

/* === Images === */
function pickLargestFromSrcset(srcset) {
  if (!srcset) return "";
  try {
    const parts = String(srcset)
      .split(",").map(s => s.trim()).filter(Boolean)
      .map(s => {
        const [u, d] = s.split(/\s+/);
        const n = d && /\d+/.test(d) ? parseInt(d, 10) : 0; // "2x" or "800w"
        return { u, n };
      });
    if (!parts.length) return "";
    parts.sort((a, b) => b.n - a.n);
    return parts[0].u || parts[0];
  } catch {
    return String(srcset).split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean)[0] || "";
  }
}
function inferSizeFromUrl(u) {
  try {
    const out = { w: 0, h: 0 };
    const lower = u.toLowerCase();
    const fn = lower.split("/").pop() || "";
    let m = fn.match(/(?:_|-)(\d{2,5})x(\d{2,5})/);
    if (m) { out.w = +m[1]; out.h = +m[2]; return out; }
    m = fn.match(/(?:_|-)(\d{2,5})x/);
    if (m) { out.w = +m[1]; return out; }
    m = fn.match(/(\d{2,5})x(\d{2,5})/);
    if (m) { out.w = +m[1]; out.h = +m[2]; return out; }
    const q = u.split("?")[1] || "";
    if (q) {
      const params = new URLSearchParams(q);
      const widthKeys  = ["w","width","maxwidth","mw","size"];
      const heightKeys = ["h","height","maxheight","mh"];
      widthKeys.forEach(k => { const v = params.get(k); if (v && /^\d{2,5}$/.test(v))  out.w = Math.max(out.w, parseInt(v,10)); });
      heightKeys.forEach(k=> { const v = params.get(k); if (v && /^\d{2,5}$/.test(v)) out.h = Math.max(out.h, parseInt(v,10)); });
    }
    return out;
  } catch { return { w: 0, h: 0 }; }
}

/* ================== Specs: canonicalization & enrichment (ADD-ONLY) ================== */
/* ==== MEDX ADD-ONLY: specs canonicalization & enrichment v1 ==== */

// Canonical names for common spec keys (lowercased text → canonical snake_case key)
const SPEC_SYNONYMS = new Map([
  // Dimensions & size
  ["dimensions", "dimensions"],
  ["overall dimensions", "overall_dimensions"],
  ["overall size", "overall_dimensions"],
  ["overall width", "overall_width"],
  ["overall height", "overall_height"],
  ["overall length", "overall_length"],
  ["overall depth", "overall_depth"],
  ["width", "width"],
  ["height", "height"],
  ["length", "length"],
  ["depth", "depth"],
  ["seat width", "seat_width"],
  ["seat depth", "seat_depth"],
  ["seat height", "seat_height"],
  ["back height", "back_height"],
  ["arm height", "arm_height"],
  ["handle height", "handle_height"],

  // Weight/capacity
  ["weight capacity", "weight_capacity"],
  ["max weight", "weight_capacity"],
  ["maximum weight", "weight_capacity"],
  ["capacity", "weight_capacity"],
  ["user weight capacity", "weight_capacity"],
  ["product weight", "product_weight"],
  ["unit weight", "product_weight"],
  ["shipping weight", "shipping_weight"],
  ["packaged weight", "shipping_weight"],

  // Other frequent keys
  ["sku", "sku"],
  ["mpn", "mpn"],
  ["model", "model"],
  ["model number", "model"],
  ["upc", "gtin12"],
  ["gtin", "gtin14"],
  ["color", "color"],
  ["material", "material"],
  ["warranty", "warranty"],
  ["category", "category"],
  ["brand", "brand"],
  ["manufacturer", "manufacturer"]
]);

function canonicalizeSpecKey(k = "") {
  const base = String(k).trim().replace(/\s+/g, " ");
  const lower = base.toLowerCase();

  // Quick synonym lookup
  if (SPEC_SYNONYMS.has(lower)) return SPEC_SYNONYMS.get(lower);

  // Heuristics → snake_case
  return lower
    .replace(/[^\p{L}\p{N}\s/.-]+/gu, "")
    .replace(/\//g, "_")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeUnitsInText(v = "") {
  // Normalize common units typography
  return String(v)
    // inch mark to "in"
    .replace(/(\d)\s*["”]/g, "$1 in")
    // feet mark to "ft"
    .replace(/(\d)\s*[\'’]/g, "$1 ft")
    // pound variants to lb
    .replace(/\b(pounds?|lbs?)\b/gi, "lb")
    // ounce to oz
    .replace(/\b(ounces?)\b/gi, "oz")
    // millimeter to mm, centimeter to cm, kilogram to kg, gram to g
    .replace(/\b(millimet(er|re)s?)\b/gi, "mm")
    .replace(/\b(centimet(er|re)s?)\b/gi, "cm")
    .replace(/\b(kilograms?)\b/gi, "kg")
    .replace(/\b(grams?)\b/gi, "g")
    // tidy spaces
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Try to parse WxDxH or similar patterns; returns { width, depth, height, unit } when possible
function parseDimensionsBlock(v = "") {
  const t = normalizeUnitsInText(v).toLowerCase();

  // 1) "W x D x H" with unit repeated or trailing
  // Examples: "20 in W x 18 in D x 35 in H", "20 x 18 x 35 in"
  let m = t.match(
    /\b(\d+(?:\.\d+)?)\s*(in|cm|mm|ft)?\s*[×x]\s*(\d+(?:\.\d+)?)\s*(in|cm|mm|ft)?\s*[×x]\s*(\d+(?:\.\d+)?)\s*(in|cm|mm|ft)?\b/
  );
  if (m) {
    const w = parseFloat(m[1]), d = parseFloat(m[3]), h = parseFloat(m[5]);
    const unit = (m[2] || m[4] || m[6] || "in").toLowerCase();
    return { width: w, depth: d, height: h, unit };
  }
  return null;
}

function enrichSpecsWithDerived(specs = {}) {
  const out = { ...specs };

  // 1) Expand overall_dimensions into components if parsable
  const candidates = [
    "overall_dimensions",
    "dimensions",
    "overall_size",
  ];
  for (const key of candidates) {
    const val = out[key];
    if (val && typeof val === "string") {
      const dims = parseDimensionsBlock(val);
      if (dims) {
        const u = dims.unit;
        if (dims.width  != null && out["overall_width"]  == null) out["overall_width"]  = `${dims.width} ${u}`;
        if (dims.depth  != null && out["overall_depth"]  == null) out["overall_depth"]  = `${dims.depth} ${u}`;
        if (dims.height != null && out["overall_height"] == null) out["overall_height"] = `${dims.height} ${u}`;
      }
    }
  }

  // 2) Normalize units for dimension-like values (adds-only)
  const DIM_KEYS = [
    "overall_width","overall_height","overall_length","overall_depth",
    "width","height","length","depth",
    "seat_width","seat_height","seat_depth","back_height","arm_height","handle_height",
    "product_weight","shipping_weight","weight_capacity"
  ];
  for (const k of DIM_KEYS) {
    if (out[k] && typeof out[k] === "string") {
      out[k] = normalizeUnitsInText(out[k]);
    }
  }

  return out;
}

// Merge two specs objects where `primary` wins on conflicts (additive).
function mergeSpecsAdditive(primary = {}, secondary = {}) {
  const merged = { ...secondary, ...primary };
  return enrichSpecsWithDerived(merged);
}

/* ==== MEDX ADD-ONLY: Pluck JSON-like objects from JS v1 ==== */
function pluckJsonObjectsFromJs(txt, maxBlocks = 3) {
  const out = [];
  let i = 0, n = txt.length;
  const pushBlock = (start, openChar, closeChar) => {
    let depth = 0, j = start, inStr = false, esc = false;
    const isQuote = c => c === '"' || c === "'";
    let quote = null;

    while (j < n) {
      const c = txt[j];
      if (inStr) {
        if (esc) { esc = false; }
        else if (c === '\\') { esc = true; }
        else if (c === quote) { inStr = false; quote = null; }
      } else {
        if (isQuote(c)) { inStr = true; quote = c; }
        else if (c === openChar) depth++;
        else if (c === closeChar) {
          depth--;
          if (depth === 0) {
            out.push(txt.slice(start, j + 1));
            return j + 1;
          }
        }
      }
      j++;
    }
    return start; // failed to close
  };

  while (i < n && out.length < maxBlocks) {
    const ch = txt[i];
    if (ch === '{' || ch === '[') {
      const next = pushBlock(i, ch, ch === '{' ? '}' : ']');
      if (next > i) { i = next; continue; }
    }
    i++;
  }
  return out;
}

/* ================== Specs: pull from embedded JSON (ADD-ONLY) ================== */
/* ==== MEDX ADD-ONLY: extract specs from scripts v1 (with reco-path guard) ==== */
function extractSpecsFromScripts($, container /* optional */) {
  const scope = container ? $(container) : $;
  if (container && (isFooterOrNav($, container) || isRecoBlock($, container))) return {};

  const out = {};
  const RECO_PATH_RE = /(related|recommend|upsell|cross|also(view|bought)|similar|fbt|suggest)/i;

  const pushKV = (name, value) => {
    const k = canonicalizeSpecKey(name);
    const v = cleanup(String(value || ""));
    if (!k || !v) return;
    if (!out[k]) out[k] = v; // first occurrence wins; DOM/SD will win later via merge order
  };

  const visit = (node, path = "") => {
    if (node == null) return;
    if (typeof node === "string") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], `${path}[${i}]`);
      return;
    }

    if (typeof node === "object") {
      // If path looks like recommendations, skip collecting KV from this subtree
      const looksReco = RECO_PATH_RE.test(path);
      const nameLike  = node.name || node.label || node.title || node.displayName || node.key || node.property;
      const valueLike = node.value || node.displayValue || node.val || node.text || node.content || node.description;
      if (!looksReco && nameLike && (valueLike != null && valueLike !== "")) pushKV(nameLike, valueLike);

      const containers = [
        "specs","specifications","technicalSpecifications","attributes","attributeGroups",
        "productAttributes","properties","features","details","data","dataSheet","Specification","Specifications",
        "custom_fields","customFields","customfields"
      ];
      containers.forEach(c => { if (node[c]) visit(node[c], `${path}.${c}`); });

      // BigCommerce/BCData shapes
      if (node.product && (node.product.attributes || node.product.custom_fields)) {
        visit(node.product.attributes || [], `${path}.product.attributes`);
        visit(node.product.custom_fields || [], `${path}.product.custom_fields`);
      }

      // Recurse into other fields with path context
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    }
  };

  // 1) Strict JSON blobs
  scope.find('script[type="application/json"], script[type="application/ld+json"]').each((_, el) => {
    if (isRecoBlock($, el)) return;
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    try { visit(JSON.parse(raw.trim()), "$"); } catch {}
  });

  // 2) Looser JS blobs (window.__NEXT_DATA__, __NUXT__, BCData, etc.)
  scope.find("script").each((_, el) => {
    if (isRecoBlock($, el)) return;
    const txt = String($(el).contents().text() || "");
    if (!txt || txt.length < 40) return;
    if (!/\b(__NEXT_DATA__|__NUXT__|BCData|Shopify|spec|attribute|dimensions?)\b/i.test(txt)) return;

    const blocks = pluckJsonObjectsFromJs(txt, 5);
    for (const block of blocks) {
      try { visit(JSON.parse(block), "$"); } catch {}
    }
  });

  const canon = {};
  Object.entries(out).forEach(([k, v]) => {
    const ck = canonicalizeSpecKey(k);
    if (!canon[ck]) canon[ck] = normalizeUnitsInText(v);
  });

  return enrichSpecsWithDerived(canon);
}

/* ==== MEDX ADD-ONLY: JSON-LD extras from all Product nodes v1 (ADD: now filtered to page) ==== */
function extractJsonLdAllProductSpecs($){
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      if (!raw || !raw.trim()) return;
      const parsed = JSON.parse(raw.trim());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(obj => {
        if (obj && obj['@graph'] && Array.isArray(obj['@graph'])) nodes.push(...obj['@graph']);
        else nodes.push(obj);
      });
    } catch {}
  });

  // ADD: detect page canonical URL to constrain merges
  const pageUrl =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    "";

  let pageHost = "";
  let pagePath = "";
  try {
    const u = new URL(pageUrl);
    pageHost = (u.hostname || "").toLowerCase();
    pagePath = u.pathname || "";
  } catch {}

  const prods = nodes.filter(n => String(n && n['@type'] || '').toLowerCase().includes('product'));

  // ADD: narrow to products that belong to the same page/host if possible
  const filtered = prods.filter(p => {
    const url = String(p.url || p['@id'] || "");
    if (!url) return !!pageHost ? false : true;
    try {
      const u = new URL(url, pageUrl || "https://example.com/");
      if (pageHost && u.hostname.toLowerCase() !== pageHost) return false;
      if (pagePath && u.pathname && u.pathname !== pagePath) return false;
      return true;
    } catch { return false; }
  });

  const chosen = filtered.length ? filtered : (prods.length ? [prods[0]] : []);
  const merged = {};
  for (const p of chosen) {
    const specs = schemaPropsToSpecs(
      p.additionalProperty || p.additionalProperties || (p.additionalType === "PropertyValue" ? [p] : [])
    );
    Object.assign(merged, specs);
  }
  return merged;
}

/* ==== MEDX ADD-ONLY: Global spec sweep v1 (now reco-aware & parts-aware) ==== */
function extractAllSpecPairs($){
  const out = {};

  // Tables
  $('table').each((_, tbl)=>{
    if (isFooterOrNav($, tbl) || isRecoBlock($, tbl) || isPartsOrAccessoryTable($, tbl)) return; // ADD reco + parts guard
    let hits = 0;
    const local = {};
    $(tbl).find('tr').each((__, tr)=>{
      const cells = $(tr).find('th,td');
      if (cells.length >= 2) {
        const k = cleanup($(cells[0]).text());
        const v = cleanup($(cells[1]).text());
        // ADD: ignore legal/menu rows
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) return;
        if (k.length <= 80 && v.length <= 400) {
          local[canonicalizeSpecKey(k)] = v;
          hits++;
        }
      }
    });
    if (hits >= 3) Object.assign(out, local);
  });

  // Definition lists
  $('dl').each((_, dl)=>{
    if (isFooterOrNav($, dl) || isRecoBlock($, dl)) return; // ADD reco guard
    const dts=$(dl).find('dt'), dds=$(dl).find('dd');
    if (dts.length === dds.length && dts.length >= 3){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text());
        const v=cleanup($(dds[i]).text());
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) continue; // ADD
        out[canonicalizeSpecKey(k)] = v;
      }
    }
  });

  // Colon/hyphen pairs in main/product areas (keep scope, but still guard)
  $('main, #main, .main, .content, #content, .product, .product-details, .product-detail').find('li,p').each((_, el)=>{
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return; // ADD reco guard
    const t = cleanup($(el).text());
    if (!t || LEGAL_MENU_RE.test(t)) return; // ADD
    const m = t.match(/^([^:–—-]{2,60})[:–—-]\s*(.{2,300})$/);
    if (m) out[canonicalizeSpecKey(m[1])] ||= m[2];
  });

  const norm = {};
  for (const [k,v] of Object.entries(out)) norm[k] = normalizeUnitsInText(v);
  return enrichSpecsWithDerived(norm);
}

/* === Images (REPLACE THIS FUNCTION) === */
function extractImages($, structured, og, baseUrl, name, rawHtml, opts){
  const minPx      = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng = (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const aggressive = !!(opts && opts.aggressive);
  const mainOnly   = !!(opts && (opts.mainOnly || opts.mainonly));

  const allowWebExt = excludePng
    ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i
    : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;

  const set        = new Set();
  const imgWeights = new Map();
  const imgContext = new Map(); // url -> { inReco: bool, inMain: bool }

  const markCtx = (absu, ctx) => {
    const prev = imgContext.get(absu) || { inReco:false, inMain:false };
    imgContext.set(absu, { inReco: prev.inReco || !!ctx.inReco, inMain: prev.inMain || !!ctx.inMain });
  };

  const titleTokens    = (name || "").toLowerCase().split(/\s+/).filter(Boolean);
  const codeCandidates = collectCodesFromUrl(baseUrl);
  const preferRe = /(\/media\/images\/items\/|\/images\/(products?|catalog)\/|\/uploads\/|\/products?\/|\/product\/|\/pdp\/|\/assets\/product|\/product-images?\/|\/commerce\/products?\/|\/zoom\/|\/large\/|\/hi-res?\/|\/wp-content\/uploads\/)/i;

  // Placeholder/UI filter (base + we’ll add isBadImageUrl())
  const badReBase = [
    'logo','brandmark','favicon','sprite','placeholder','no-?image','missingimage','loader',
    'coming[-_]?soon','image[-_]?coming[-_]?soon','awaiting','spacer','blank','default','dummy','sample','temp',
    'spinner','icon','badge','flag','cart','arrow','pdf','facebook','twitter','instagram','linkedin',
    '\\/wcm\\/connect','/common/images/','/icons/','/social/','/share/','/static/','/cms/','/ui/','/theme/','/wp-content/themes/',
    'pixel','1x1','transparent','blank\\.gif','data:image'
  ];
  if (!aggressive) badReBase.push('/search/','/category/','/collections/','/filters?','/banners?/');
  const badRe = new RegExp(badReBase.join('|'), 'i');

  // Same-site/CDN allow
  const allowHostRe = new RegExp([
    getRegistrableDomain(safeHostname(baseUrl)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'cdn','cloudfront','akamai','akamaized','azureedge','fastly','shopifycdn','cdn\\.shopify','myshopify',
    'bigcommerce','cloudinary','imgix','scene7','mzstatic'
  ].join('|'), 'i');

  const pushEl = ($el, url, baseWeight = 0) => {
    if (!url) return;
    if (/^data:/i.test(url)) return;
    const absu = abs(baseUrl, url);
    if (isCompassPlaceholder(absu)) return;
    if (!absu) return;

    if (!allowWebExt.test(absu)) return;
    if (badRe.test(absu)) return;
    if (isBadImageUrl(absu, $el)) return;                  // << hard block for listed offenders

    // prefer same site or known CDNs unless aggressive
    if (!aggressive && !isSameSiteOrCdn(baseUrl, absu) && !/\/media\/images\/items\//i.test(absu)) return;

    const ctxScore = scoreByContext($, $el[0] || $el, { mainOnly });
    if (ctxScore <= -999) return;

    // quick size gate from attrs/styles (cheaper than URL parsing)
    const wAttr = $el && $el.length ? getAttrNumeric($el, 'width') : 0;
    const hAttr = $el && $el.length ? getAttrNumeric($el, 'height') : 0;
    const style = $el && $el.length ? String($el.attr('style')||'') : '';
    const wCss  = parseCssPx(style);
    const maxSide = Math.max(wAttr, hAttr, wCss);
    if (maxSide && maxSide < minPx) return;

    // compute score
    let score = baseWeight + ctxScore;
    const L = absu.toLowerCase();

    // Prefer real Compass product images, but block placeholders
    if (/compasshealthbrands\.com\/media\/images\/items\//i.test(absu)) {
      if (/noimage/i.test(absu)) return; // hard stop: don't add this image
      score += 6; // strong nudge to keep PB42BARBED Angle.jpg and friends
    }
    
    if (preferRe.test(L)) score += 2;
    if (codeCandidates.some(c => c && L.includes(c))) score += 2;
    if (titleTokens.some(t => t.length > 2 && L.includes(t))) score += 1;
    if (/(_\d{3,}x\d{3,}|-?\d{3,}x\d{3,}|(\?|&)(w|width|h|height|size)=\d{3,})/.test(L)) score += 1;
    if (/\b(thumb|thumbnail|swatch)\b/.test(L)) score -= 3;

    const prev = imgWeights.get(absu) || 0;
    if (score > prev) imgWeights.set(absu, score);
    markCtx(absu, { inMain: ctxScore > 0 });
    set.add(absu);
  };

  // 1) Structured data images: strongest
  (structured.images || []).forEach(u => pushEl($.root(), u, 8));

  // 2) Product gallery/media areas (skip reco)
  const gallerySelectors = [
    '.product-media','.product__media','.product-gallery','#product-gallery','[data-gallery]',
    '.product-images','.product-image-gallery','.pdp-gallery',
    '.slick-slider','.slick','.swiper','.swiper-container','.carousel',
    '.owl-carousel','.fotorama','.MagicZoom','.cloudzoom-zoom','.zoomWindow','.zoomContainer',
    '.lightbox','.thumbnails'
  ].join(', ');
  $(gallerySelectors).each((_, container) => {
    if (isRecoBlock($, container)) return;
    $(container).find('img, source').each((__, el) => {
      const $el = $(el);
      const cands = [
        $el.attr('src'), $el.attr('data-src'), $el.attr('data-original'),
        $el.attr('data-zoom'), $el.attr('data-zoom-image'),
        $el.attr('data-image'), $el.attr('data-large_image'),
        $el.attr('data-lazy'), pickLargestFromSrcset($el.attr('srcset'))
      ];
      cands.forEach(u => pushEl($el, u, 6));
    });
  });

  // 3) OpenGraph / Twitter
  if (og.image) pushEl($.root(), og.image, 3);
  const tw = $('meta[name="twitter:image"]').attr('content'); if (tw) pushEl($.root(), tw, 2);

  // 4) Preloads (often main gallery)
  $('link[rel="preload"][as="image"]').each((_, el) => pushEl($(el), $(el).attr('href'), 3));

  // 5) Main-scope images (context-gated)
  $('main, #main, .main, article, .product, .product-detail, .product-details')
    .find('img, source, picture source').each((_, el) => {
      if (isRecoBlock($, el)) return;
      const $el = $(el);
      const cands = [
        $el.attr('src'), $el.attr('data-src'), $el.attr('data-lazy'),
        $el.attr('data-original'), $el.attr('data-image'),
        $el.attr('data-zoom-image'), pickLargestFromSrcset($el.attr('srcset'))
      ];
      cands.forEach(u => pushEl($el, u, 3));
    });

  // 6) Background images (main scope)
  $('main, #main, .main, article, .product, .product-detail, .product-details')
    .find('[style*="background"]').each((_, el) => {
      const $el = $(el);
      const style = String($el.attr("style") || "");
      const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
      if (m && m[2]) pushEl($el, m[2], 2);
    });

  // 7) CSS <style> url(...) (low weight, still filtered)
  $('style').each((_, el) => {
    const css = String($(el).contents().text() || '');
    if (!/url\(/i.test(css)) return;
    const re = /url\((['"]?)([^'")]+)\1\)/ig;
    let m; while ((m = re.exec(css))) pushEl($(el), m[2], 1);
  });

  // 8) JSON-in-attributes (galleries stored as JSON on data-*)
  $('[data-gallery],[data-images],[data-photoswipe],[data-zoom-gallery],[data-media]').each((_, el) => {
    const $el = $(el);
    ['data-gallery','data-images','data-photoswipe','data-zoom-gallery','data-media'].forEach(attr => {
      const raw = $el.attr(attr);
      if (!raw) return;
      const s = String(raw).trim();
      if (!/^[\[{]/.test(s)) return;
      try {
        const obj = JSON.parse(s);
        deepFindImagesFromJson(obj).forEach(u => pushEl($el, u, 3));
      } catch {}
    });
  });

  // 9) noscript fallbacks
  $('noscript').each((_, n) => {
    if (isRecoBlock($, n)) return;
    const inner = $(n).html() || "";
    const _$ = cheerio.load(inner);
    _$('img').each((__, el) => {
      const $el = _$(el);
      const src = $el.attr('src') || $el.attr('data-src') || pickLargestFromSrcset($el.attr('srcset'));
      if (src) pushEl($(n), src, 3);
    });
  });

  // 10) Script blobs & raw HTML (last resort)
  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!/\.(?:jpe?g|png|webp)\b/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      deepFindImagesFromJson(obj).forEach(u => pushEl($(el), u, 2));
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) pushEl($(el), m[1], 1);
    }
  });
  if (rawHtml) {
    const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m; while ((m = re.exec(rawHtml))) pushEl($.root(), m[1], 0);
  }

  // Score + dedupe by basename
  // Prioritize images that are within the main product scope and not part of recommendation blocks.
  // Filter out any images that appear in recommendation/related sections.  If there are no such
  // images, fall back to all candidates but still prefer inMain over others.
  const allCandidates = Array.from(set);
  const primary = allCandidates.filter(u => {
    const ctx = imgContext.get(u) || {};
    return ctx.inMain && !ctx.inReco;
  });
  const secondary = allCandidates.filter(u => {
    const ctx = imgContext.get(u) || {};
    return !primary.includes(u) && !ctx.inReco;
  });
  const candidates = primary.length ? primary : secondary.length ? secondary : allCandidates;
  const scored = candidates.map(u => {
    let score = imgWeights.get(u) || 0;
    const ctx = imgContext.get(u) || {};
    if (ctx.inReco) score -= 5;
    if (ctx.inMain) score += 3;
    return { url: decodeHtml(u), score };
  }).sort((a,b) => b.score - a.score);
  const seen = new Set();
  const out  = [];
  for (const s of scored) {
    const baseRaw = s.url.split("/").pop().split("?")[0];
    let baseKey = baseRaw.toLowerCase();
    try { baseKey = decodeURIComponent(baseRaw).toLowerCase(); } catch {}
    if (seen.has(baseKey)) continue;
    seen.add(baseKey);
    out.push({ url: s.url });
    if (out.length >= 12) break;
  }
  return out;
}

/* ================== ADD-ONLY: Enhanced image harvester (CDN + main scope) ================== */
/* === Compass image harvester (ADD-ONLY) === */
function harvestCompassItemImages($, baseUrl, rawHtml){
  const out = new Set();
  const add = (u) => {
    if (!u) return;
    const absu = abs(baseUrl, u);
    if (!absu) return;
    if (isCompassPlaceholder(absu)) return;
    if (!/\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(absu)) return;
    out.add(absu);
  };

  // 1) Direct anchors
  $('a[href]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    if (/\/media\/images\/items\//i.test(href)) add(href);
  });

  // 2) Common product attributes
  $('[data-zoom-image],[data-large_image],[data-image]').each((_, el) => {
    ['data-zoom-image','data-large_image','data-image'].forEach(attr => add($(el).attr(attr)));
  });

  // 3) MagicZoom / CloudZoom
  $('.MagicZoom, .cloudzoom-zoom, [data-zoom]').each((_, el) => {
    add($(el).attr('href') || $(el).attr('data-zoom'));
  });

  // 4) Script & raw HTML sweep
  const scan = (txt) => {
    if (!txt) return;
    const re = /(https?:\/\/[^"'<>]+\/media\/images\/items\/[^"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m; while ((m = re.exec(txt))) add(m[1]);
  };
  $('script').each((_, s) => scan(String($(s).contents().text() || '')));
  scan(rawHtml || '');

  // Rank likely angles higher
  const ranked = Array.from(out)
    .map(u => {
      let score = 0;
      if (/(angle|front|left|right|back|hi[-_]?res|zoom)/i.test(u)) score += 3;
      if (/%20|[-_](angle|front|left|right|back)\b/i.test(u)) score += 2;
      return { url: u, score };
    })
    .sort((a,b) => b.score - a.score)
    .map(x => x.url);

  return ranked;
}

function extractImagesPlus($, structured, og, baseUrl, name, rawHtml, opts) {
  const excludePng = (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const mainOnly   = !!(opts && (opts.mainOnly || opts.mainonly));
  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i
                                 : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;

  const scope = findMainProductScope($);
  const scores = new Map(); // url -> score

  const push = (node, url, baseScore = 0) => {
    if (!url) return;
    const u = decodeHtml(abs(baseUrl, url));
    if (!u || !allowWebExt.test(u)) return;
    if (isBadImageUrl(u)) return;
    if (!isSameSiteOrCdn(baseUrl, u)) return;

    const ctx = scoreByContext($, node, { mainOnly });
    if (ctx <= -999) return;

    let score = baseScore + ctx;

    // Prefer Compass real product images (but never placeholders)
    if (/compasshealthbrands\.com\/media\/images\/items\//i.test(u)) {
      if (/noimage/i.test(u)) return;
      score += 6;
    }

    scores.set(u, Math.max(scores.get(u) || 0, score));
  };

  // 1) Gallery/media in main scope
  scope.find('.product-media, .product__media, .product-gallery, #product-gallery, [data-gallery], .slick, .swiper, .carousel, .fotorama')
    .find('img, source').each((_, el) => {
      const $el = $(el);
      const cands = [
        $el.attr('src'), $el.attr('data-src'), $el.attr('data-original'),
        $el.attr('data-zoom'), $el.attr('data-zoom-image'),
        $el.attr('data-image'), $el.attr('data-large_image'),
        pickLargestFromSrcset($el.attr('srcset'))
      ];
      cands.forEach(u => push(el, u, 6));
    });

  // 2) Preloads & social metas
  $('link[rel="preload"][as="image"]').each((_, el) => push(el, $(el).attr('href'), 3));
  const tw = $('meta[name="twitter:image"]').attr('content'); if (tw) push($.root(), tw, 2);

  // 3) General main-scope images
  scope.find('img, source, picture source').each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr('src'), $el.attr('data-src'), $el.attr('data-lazy'),
      $el.attr('data-original'), $el.attr('data-image'),
      $el.attr('data-zoom-image'), pickLargestFromSrcset($el.attr('srcset'))
    ];
    cands.forEach(u => push(el, u, 3));
  });

  // 4) Backgrounds in main scope
  scope.find('[style*="background"]').each((_, el) => {
    const style = String($(el).attr('style') || '');
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(el, m[2], 2);
  });

  // 5) JSON blobs
  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!/\.(?:jpe?g|png|webp)\b/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      deepFindImagesFromJson(obj, []).forEach(u => push(el, u, 2));
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) push(el, m[1], 1);
    }
  });

  // --- final ranking & dedupe ---
  const ranked = Array.from(scores.entries())
    .map(([url, score]) => ({ url, score }))
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, 8).map(r => ({ url: r.url }));
  
  const seen = new Set();
  let out = [];
  for (const s of scored) {
    if (isCompassPlaceholder(s.url)) continue; // final guard
    let baseKey = s.url.split("/").pop().split("?")[0];
    try { baseKey = decodeURIComponent(baseKey); } catch {}
    baseKey = baseKey.toLowerCase();
    if (seen.has(baseKey)) continue;
    seen.add(baseKey);
    out.push({ url: s.url });
    if (out.length >= 12) break;
  }

  // --- Compass fix-up: merge real /media/images/items/* images if we have room
  try {
    if (isCompassHost(targetUrl)) {
      const compImgs = harvestCompassItemImages($, baseUrl, rawHtml);
      if (compImgs.length) {
        const have = new Set(out.map(o => {
          let b = (o.url || '').split('/').pop().split('?')[0];
          try { b = decodeURIComponent(b); } catch {}
          return b.toLowerCase();
        }));
        for (const u of compImgs) {
          let k = u.split('/').pop().split('?')[0];
          try { k = decodeURIComponent(k); } catch {}
          k = k.toLowerCase();
          if (!have.has(k)) { out.push({ url: u }); have.add(k); }
          if (out.length >= 12) break;
        }
      }
    }
  } catch {}

  return out;
}


function fallbackImagesFromMain($, baseUrl, og, opts){
  const minPx     = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng= (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
  const badRe = /(logo|favicon|sprite|placeholder|no-?image|missingimage|icon|social|facebook|twitter|instagram|linkedin|\/common\/images\/|\/icons\/|\/wp-content\/themes\/)/i;

  const set = new Set();
  const push = u => { if (u) set.add(abs(baseUrl, u)); };

  $('main, #main, .main, article, .product, .product-detail, .product-details').first().find('img').each((_, el)=>{
    // Skip images that are within footer/nav or recommendation/upsell sections to reduce noise
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
    push($(el).attr('src'));
    push($(el).attr('data-src'));
    push(pickLargestFromSrcset($(el).attr('srcset')));
  });

  // noscript fallbacks in main area. Skip noscript blocks in footer/nav or recommendation areas.
  $('main, #main, .main, article').first().find('noscript').each((_, n)=>{
    if (isFooterOrNav($, n) || isRecoBlock($, n)) return;
    const inner = $(n).html() || "";
    const _$ = cheerio.load(inner);
    _$("img").each((__, el)=>{
      const src = _$(el).attr("src") || _$(el).attr("data-src") || pickLargestFromSrcset(_$(el).attr("srcset"));
      if (src) push(src);
    });
  });

  if (og && og.image) push(og.image);

  let arr = Array.from(set).filter(Boolean).map(decodeHtml)
    .filter(u => allowWebExt.test(u))
    .filter(u => !badRe.test(u))
    .filter(u => {
      const { w,h } = inferSizeFromUrl(u);
      if (!w && !h) return true;
      return Math.max(w||0,h||0) >= minPx;
    });

  const out  = [];
  const seen = new Set();
  for (const u of arr) {
    const base = u.split('/').pop().split('?')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url: u });
    if (out.length >= 3) break;
  }
  return out;
}

/* === Manuals === */
function extractManuals($, baseUrl, name, rawHtml, opts){
  const urls = new Set();
  const allowRe = /(manual|ifu|instruction|instructions|user[- ]?guide|owner[- ]?manual|assembly|install|installation|setup|quick[- ]?start|spec(?:sheet)?|datasheet|guide|brochure)/i;
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;

  const scopeSel = [
    '.product-details','.product-detail','.product-description','.product__info',
    '.tab-content','.tabs-content','[role="tabpanel"]','#tabs','main','#main','.main','#content','.content',
    '.downloads','.documents','.resources','.manuals','.product-resources','.product-documents'
  ].join(', ');

  const scope = $(scopeSel);
  scope.find('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href = String($(el).attr("href")||"");
    const txt  = cleanup($(el).text()).toLowerCase();
    const full = abs(baseUrl, href);
    if (!full) return;
    const L = (txt + " " + full).toLowerCase();
    if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
  });

  if (!urls.size) {
    $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
      const href=String($(el).attr("href")||"");
      const txt =cleanup($(el).text()).toLowerCase();
      const full=abs(baseUrl, href);
      if (!full) return;
      const L = (txt + " " + full).toLowerCase();
      if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
    });
  }

  $('script').each((_, el)=>{
    const txt = String($(el).contents().text() || '');
    if (!/\.pdf\b/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      deepFindPdfsFromJson(obj).forEach(u => {
        const full = abs(baseUrl, u);
        if (!full) return;
        const L = full.toLowerCase();
        if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
      });
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.pdf)(?:\?[^"'<>]*)?/ig;
      let m;
      while ((m = re.exec(txt))) {
        const full = abs(baseUrl, m[1]);
        if (!full) continue;
        const L = full.toLowerCase();
        if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
      }
    }
  });

  const titleTokens = (name||"").toLowerCase().split(/\s+/).filter(Boolean);
  const codes = collectCodesFromUrl(baseUrl);

  const arr = Array.from(urls);
  arr.sort((a,b)=>{
    const A = a.toLowerCase(), B = b.toLowerCase();
    const as = (codes.some(c=>A.includes(c)) ? 2 : 0) + (titleTokens.some(t=>t.length>2 && A.includes(t)) ? 1 : 0);
    const bs = (codes.some(c=>B.includes(c)) ? 2 : 0) + (titleTokens.some(t=>t.length>2 && B.includes(t)) ? 1 : 0);
    return bs - as;
  });

  return arr;
}
/* ================== ADD-ONLY: Enhanced manuals harvester ================== */
function extractManualsPlus($, baseUrl, name, rawHtml, opts) {
  const mainOnly = !!(opts && (opts.mainOnly || opts.mainonly));
  const urls = new Map(); // url -> score
  const allowRe = /(manual|ifu|instruction|instructions|user[- ]?guide|owner[- ]?manual|assembly|install|installation|setup|quick[- ]?start|spec(?:sheet)?|datasheet|guide|brochure)/i;
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;

  const push = (node, url, baseScore = 0) => {
    if (!url) return;
    const u = decodeHtml(abs(baseUrl, url));
    if (!u) return;
    const L = u.toLowerCase();
    const ctx = scoreByContext($, node, { mainOnly });
    if (ctx <= -999) return;
        // If the URL does not look like a PDF or a known proxy (document, view,
        // download, asset, file) then skip it unless the baseScore is high.
        // A high baseScore (>= 4) indicates the anchor text strongly suggested
        // a manual (e.g. "User Manual"), so allow it through for further
        // processing. This makes it possible to follow manual pages that
        // ultimately link to PDFs, without polluting results with unrelated
        // pages. Existing behaviour for direct PDF or known proxy URLs is
        // preserved.
        if (!/\.pdf(?:[?#].*)?$/i.test(u) && !/document|view|download|asset|file/i.test(L)) {
          if (baseScore < 4) return;
        }
    if (blockRe.test(L)) return;
    const cur = urls.get(u) || 0;
    urls.set(u, Math.max(cur, baseScore + ctx));
  };

  const scope = findMainProductScope($);

  // 1) Direct anchors with wider attribute coverage
  scope.find('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || $el.attr('data-href') || $el.attr('data-url') || $el.attr('data-file');
    const t = ($el.text() || $el.attr('aria-label') || '').toLowerCase();
    // If the anchor text strongly suggests a manual (matches allowRe), assign a higher
    // base score (5) so that the link passes the subsequent filtering threshold even
    // if the URL itself does not look like a PDF or known proxy. Otherwise use the
    // default score of 4 for direct PDFs or known proxy URLs. This is additive and
    // preserves existing behaviour for other links.
    if (href && (allowRe.test(t) || /\.pdf(?:[?#].*)?$/i.test(href))) {
      const base = allowRe.test(t) ? 5 : 4;
      push(el, href, base);
    }
  });

  // 2) onclick handlers that open PDFs
  $('a[onclick], button[onclick]').each((_, el) => {
    const s = String($(el).attr('onclick') || '');
    const m = s.match(/https?:\/\/[^\s"'<>]+?\.pdf(?:\?[^"'<>]*)?/i);
    if (m) push(el, m[0], 3);
  });

  // 3) PDF in <object>/<embed>/<iframe>
  $('object[type="application/pdf"], embed[type="application/pdf"], iframe[src*=".pdf"]').each((_, el) => {
    const $el = $(el);
    push(el, $el.attr('data') || $el.attr('src') || '', 5);
  });

  // 4) JSON blobs (documents arrays)
  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!/\.(pdf)\b/i.test(txt) && !/documents?|downloads?|resources?/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      const arr = deepFindPdfsFromJson(obj, []);
      for (const u of arr) {
        const L = String(u||'').toLowerCase();
        if (allowRe.test(L) && !blockRe.test(L)) push(el, u, 3);
      }
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.pdf)(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) push(el, m[1], 2);
    }
  });

  // 5) Last-resort: global anchors with strong text hints
  $('a[href*=".pdf"], a[download]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const txt  = ($el.text() || $el.attr('title') || '').toLowerCase();
    if (allowRe.test(txt)) push(el, href, 2);
  });

  const ranked = Array.from(urls.entries())
    .map(([url, score]) => ({ url, score }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.url);

  return dedupeManualUrls(ranked);
}

function fallbackManualsFromPaths($, baseUrl, name, rawHtml){
  const out = new Set();
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;
  const pathHint= /(manual|ifu|document|documents|download|downloads|resources|instructions?|user[- ]?guide|datasheet|spec|sheet|brochure)/i;
  const host = safeHostname(baseUrl);

  $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href=String($(el).attr("href")||"");
    const full=abs(baseUrl, href);
    if (!full) return;
    if (safeHostname(full) !== host) return;
    const L = full.toLowerCase();
    if (!blockRe.test(L) && pathHint.test(L)) out.add(full);
  });

  const html = $.root().html() || "";
  const re = /(https?:\/\/[^\s"'<>]+?\.pdf)(?:\?[^"'<>]*)?/ig;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1]);
      if (u.hostname !== host) continue;
      const L = m[1].toLowerCase();
      if (!blockRe.test(L) && pathHint.test(L)) out.add(m[1]);
    } catch {}
  }
  return Array.from(out);
}
/* === Specs (scoped → dense block → global) === */
function extractSpecsSmart($){
  let specPane = resolveTabPane($, [
  'technical specifications','technical specification',
  'tech specs','specifications','specification',
  'size & weight','size and weight','dimensions','dimension','sizing',
  'details'
]);

  // ADD: Make spec pane selection “footer-aware”
  if (specPane && (isFooterOrNav($, specPane) || isRecoBlock($, specPane))) {
    specPane = null;
  }

  if (specPane) {
    const scoped = extractSpecsFromContainer($, specPane);
    if (Object.keys(scoped).length) return scoped;
  }

  const dense = extractSpecsFromDensestBlock($);
  if (Object.keys(dense).length) return dense;

  const out = {};
  
  // Tables (global fallback)
  $('table').each((_, tbl)=>{
    if (isFooterOrNav($, tbl) || isRecoBlock($, tbl) || isPartsOrAccessoryTable($, tbl)) return; // ADD reco + parts guard
    $(tbl).find('tr').each((__, tr)=>{
      const cells=$(tr).find('th,td');
      if (cells.length>=2){
        const k=cleanup($(cells[0]).text());
        const v=cleanup($(cells[1]).text());
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) return; // ADD
        const kk = k.toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        if (kk && v && kk.length<80 && v.length<400) out[kk]=v;
      }
    });
  });

  // Definition lists
  $('dl').each((_, dl)=>{
    if (isFooterOrNav($, dl) || isRecoBlock($, dl)) return; // ADD reco guard
    const dts=$(dl).find('dt'), dds=$(dl).find('dd');
    if (dts.length === dds.length && dts.length){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text());
        const v=cleanup($(dds[i]).text());
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) continue; // ADD
        const kk = k.toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        if (kk && v && kk.length<80 && v.length<400) out[kk]=v;
      }
    }
  });

  // LI pairs
  $('li').each((_, li)=>{
    if (isFooterOrNav($, li) || isRecoBlock($, li)) return; // ADD reco guard
    const t = cleanup($(li).text());
    if (!t || t.length < 3 || t.length > 250) return;
    const m = t.split(/[:\-–]\s+/);
    if (m.length >= 2){
      const k = m[0].toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
      const v = m.slice(1).join(': ').trim();
      if (k && v && !out[k]) out[k]=v;
    }
  });

  return out;
}

function extractSpecsFromDensestBlock($){
  const candidates = [
    '[role="tabpanel"]','.tab-pane','.tabs-content > *','.accordion-content','.product-tabs *',
    '.tab-content *','section','.panel','.panel-body','.content'
  ].join(', ');
  let bestEl = null, bestScore = 0;

  $(candidates).each((_, el)=>{
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return; // ADD reco guard
    const $el = $(el);
    let score = 0;

    $el.find('tr').each((__, tr)=>{
      const cells=$(tr).find('th,td');
      if (cells.length>=2){
        const k = cleanup($(cells[0]).text());
        const v = cleanup($(cells[1]).text());
        if (k && v && /:|back|warranty|weight|capacity|handles|depth|height/i.test(k)) score++;
      }
    });

    const dts = $el.find('dt').length;
    const dds = $el.find('dd').length;
    if (dts && dds && dts === dds) score += Math.min(dts, 12);

    $el.find('li').each((__, li)=>{
      const t = cleanup($(li).text());
      if (/^[^:]{2,60}:\s+.{2,300}$/.test(t)) score++;
    });

    if (score > bestScore) { bestScore = score; bestEl = el; }
  });

  return bestEl ? extractSpecsFromContainer($, bestEl) : {};
}

function deriveSpecsFromParagraphs($){
  const out = {};
  $('main, #main, .main, .product, .product-detail, .product-details, .product__info, .content, #content')
    .find('p, li').each((_, el)=>{
      if (isFooterOrNav($, el) || isRecoBlock($, el)) return; // ADD reco guard
      const t = cleanup($(el).text());
      if (!t) return;
      const m = t.match(/^([^:]{2,60}):\s*(.{2,300})$/);
      if (m){
        const k = m[1].toLowerCase().replace(/\s+/g,'_');
        const v = m[2];
        if (k && v && !out[k]) out[k]=v;
      }
    });
  return out;
}

/* === Features === */
function extractFeaturesSmart($){
  const items = [];
  const scopeSel = [
    '.features','.feature-list','.product-features','[data-features]',
    '.product-highlights','.key-features','.highlights'
  ].join(', ');

  const excludeSel = [
    'nav','.breadcrumb','.breadcrumbs','[aria-label="breadcrumb"]',
    '.related','.upsell','.cross-sell','.menu','.footer','.header','.sidebar',
    '.category','.collections','.filters',
    '.frequently-bought','.frequently-bought-together','.also-viewed','.people-also-viewed','.recommendations','.product-recommendations'
  ].join(', ');

  const pushIfGood = (txt) => {
    const t = cleanup(txt);
    if (!t) return;
    if (t.length < 7 || t.length > 220) return;
    if (/>|›|»/.test(t)) return;
    if (/\b(privacy|terms|trademark|copyright|newsletter|subscribe)\b/i.test(t)) return;
    if (/(https?:\/\/|www\.)/i.test(t)) return;
    items.push(t);
  };

  $(scopeSel).each((_, el)=>{
    const $el = $(el);
    if ($el.closest(excludeSel).length) return;
    $el.find('li').each((__, li)=> pushIfGood($(li).text()));
    $el.find('h3,h4,h5').each((__, h)=> pushIfGood($(h).text()));
  });

  // Also search for 'product description' or 'description' tabs, since some sites
  // embed feature lists under those headings.  This helps capture bullet lists
  // that live within the Product Description tab (e.g. Spectra S1+ page).
  const featPane = resolveTabPane($, ['feature','features','features/benefits','benefits','key features','highlights','product description','description']);
  if (featPane){
    const $c = $(featPane);
    $c.find('li').each((_, li)=> pushIfGood($(li).text()));
    $c.find('h3,h4,h5').each((_, h)=> pushIfGood($(h).text()));
  }

  /*
   * Some merchants hide their feature lists under a heading like
   * “Features & Benefits” or “Features and Benefits” within the product
   * description tab.  Those sections often contain a bullet list
   * immediately following the heading.  To ensure those bullets are
   * captured, we scan for elements whose text matches a regex and then
   * grab the first following <ul> or <ol>.  The bullets are pushed
   * through the same pushIfGood filter as other features.
   */
  try {
    // Scan for headings or paragraphs that introduce a feature or included-items list.
    // Two separate regexes: one for Features & Benefits, another for Products Include / What's in the Box.
    const featureLabelRe = /\bfeatures\s*(?:&|and|\/|\+)?\s*benefits\b/i;
    const includesLabelRe = /\b(products?\s*include|product\s*includes|what'?s\s+in\s+the\s+box|inclusions?|package\s+contents?)\b/i;
    $('p, h2, h3, h4, h5, strong, span, div').each((_, el) => {
      const txt = cleanup($(el).text());
      if (!txt) return;
      let labelType = null;
      if (featureLabelRe.test(txt)) labelType = 'feature';
      else if (includesLabelRe.test(txt)) labelType = 'include';
      if (!labelType) return;
      // Find the first <ul> or <ol> after the label or within its parent.
      let list = $(el).nextAll('ul,ol').first();
      if (!list.length) list = $(el).parent().find('ul,ol').first();
      if (!list.length) return;
      list.find('li').each((__, li) => pushIfGood($(li).text()));
    });
  } catch (err) { /* ignore errors */ }

  const seen = new Set();
  const out=[];
  for (const t of items){
    const key = t.toLowerCase();
    if (!seen.has(key)){
      seen.add(key);
      out.push(t);
    }
    if (out.length>=20) break;
  }
  return out;
}
function deriveFeaturesFromParagraphs($){
  /**
   * Collect a set of candidate feature strings from both paragraphs and list items in the main
   * content area.  We intentionally include paragraphs here because some merchants embed
   * feature‑like statements in prose rather than in an explicit list.  To avoid overwhelming the
   * feature list with every sentence from the description, we break paragraphs into sentences
   * with the `splitIntoSentences` helper and then filter them via `pushIfGood`.  Bullet items are
   * collected whole.  Results are deduplicated case‑insensitively and truncated to a reasonable
   * count.  Longer lines (up to 400 characters) are allowed because certain features may be
   * verbose.
   */
  const out = [];
  const pushIfGood = (txt) => {
    const t = cleanup(txt);
    if (!t) return;
    // allow longer feature lines up to 400 characters (was 220)
    if (t.length < 7 || t.length > 400) return;
    // skip arrows and navigation markers
    if (/>|›|»/.test(t)) return;
    // skip common non-feature words
    if (/\b(privacy|terms|trademark|copyright|newsletter|subscribe)\b/i.test(t)) return;
    // skip lines containing URLs
    if (/(https?:\/\/|www\.)/i.test(t)) return;
    out.push(t);
  };
  // Define a selector for the main content area where we search for paragraphs and list items.
  const contentSelector = 'main, #main, .main, .product, .product-detail, .product-details, .product__info, .content, #content, .tab_inner_content, .tab_content';
  // First collect candidate sentences from paragraphs.  Splitting paragraphs into sentences
  // means each sentence is treated as a potential feature.  This provides a fallback when no
  // bullet list is available.  We still limit the total number of features later.
  $(contentSelector).find('p').each((_, p) => {
    if (isFooterOrNav($, p) || isRecoBlock($, p)) return;
    const raw = cleanup($(p).text());
    if (!raw) return;
    const sentences = splitIntoSentences(raw);
    sentences.forEach((s) => pushIfGood(s));
  });
  // Collect bullet list items in the same content area.  These are often true features and
  // should be kept whole.  They typically override any prose-derived sentences.
  $(contentSelector).find('li').each((_, li) => {
    if (isFooterOrNav($, li) || isRecoBlock($, li)) return;
    const raw = cleanup($(li).text());
    if (!raw) return;
    pushIfGood(raw);
  });
  // Deduplicate case-insensitively and limit to 30 entries.  Longer lists are unlikely to be
  // useful and may overwhelm downstream consumers.
  const seen = new Set();
  const uniq = [];
  for (const t of out) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(t);
      if (uniq.length >= 30) break;
    }
  }
  return uniq;
}

/* === Resolve tabs === */
function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function documentQueryById($, id){
  try { return id ? $(`#${CSS.escape(id)}`)[0] : null; }
  catch { return id ? $(`#${id}`)[0] : null; }
}

function resolveTabPane($, names){
  const nameRe = new RegExp(`\\b(?:${names.map(n=>escapeRe(n)).join('|')})\\b`, 'i');
  let pane = null;

  $('a,button,[role="tab"]').each((_, el)=>{
    const label = cleanup($(el).text());
    if (!label || !nameRe.test(label)) return;

    let href = $(el).attr('href') || '';
    if (!href && $(el).is('[role="tab"]')) {
      const innerA = $(el).find('a[href^="#"]').first().attr('href');
      if (innerA) href = innerA;
    }
    
    const controls = $(el).attr('aria-controls') || '';
    const dataTarget = $(el).attr('data-target') || $(el).attr('data-tab') || '';
    let target = null;

    if (href && href.startsWith('#')) target = $(href)[0];
    if (!target && controls) target = documentQueryById($, controls);
    if (!target && dataTarget && dataTarget.startsWith('#')) target = $(dataTarget)[0];

    if (target) { pane = target; return false; }
  });

  if (!pane){
    $('[role="tabpanel"], .tab-pane, .panel, .tabs-content, .accordion-content').each((_, el)=>{
      const heading = cleanup($(el).find('h2,h3,h4').first().text());
      if (heading && nameRe.test(heading)) { pane = el; return false; }
    });
  }

  if (!pane){
    const classRe = new RegExp(names.map(n=>escapeRe(n)).join('|'), 'i');
    $('[class]').each((_, el)=>{
      if (classRe.test($(el).attr('class')||'')) { pane = el; return false; }
    });
  }
  return pane;
}

/* ===== Dojo/dijit TabContainer helpers ===== */
function parseDojoTabs($, baseUrl, tablistRoot) {
  const out = [];
  const $root = tablistRoot ? $(tablistRoot) : $('[role="tablist"]').first();
  if (!$root.length) return out;

  $root.find('[role="tab"]').each((_, el) => {
    const $tab = $(el);
    const tabId = $tab.attr('id') || '';
    const title = (String($tab.attr('title') || '').trim()) || (String($tab.text() || '').trim());

    let paneId = $tab.attr('aria-controls') || '';
    if (!paneId && tabId && tabId.includes('tablist_')) {
      paneId = tabId.slice(tabId.indexOf('tablist_') + 'tablist_'.length);
    }
    if (!paneId) return;

    let $panel;
    try {
      $panel = $(`#${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(paneId) : paneId}`);
    } catch {
      $panel = $(`#${paneId}`);
    }
    if (!$panel.length && tabId) $panel = $(`[role="tabpanel"][aria-labelledby="${tabId}"]`);

    const html = $panel.html() || '';
    const text = (String($panel.text() || '')).replace(/\s+/g,' ').trim();

    let href = $panel.attr('href') || $panel.attr('data-href') || '';
    if (!href) {
      const props = $panel.attr('data-dojo-props') || '';
      const m = /href\s*:\s*['"]([^'"]+)['"]/.exec(props);
      if (m) href = m[1];
    }

    out.push({
      tab_id: tabId,
      panel_id: paneId,
      title: title || '',
      html,
      text,
      href: href ? abs(baseUrl, href) : ''
    });
  });

  return out;
}

async function hydrateLazyTabs(tabs, renderApiUrl, headers = {}) {
  if (!tabs || !tabs.length || !renderApiUrl) return tabs || [];
  const base = renderApiUrl.replace(/\/+$/,'');
  const out = [];

  for (const t of tabs) {
    const tt = { ...t };
    if (!tt.html && tt.href) {
      try {
        const url = `${base}/render?url=${encodeURIComponent(tt.href)}&mode=full`;
        const { html } = await fetchWithRetry(url, { headers });
        const $p = cheerio.load(html);
        tt.html = $p.root().html() || '';
        tt.text = $p.root().text().replace(/\s+/g,' ').trim();
      } catch {}
    }
    out.push(tt);
  }
  return out;
}

function mergeTabTexts(tabs, order = ['Overview','Technical Specifications','Features','Downloads']) {
  const rank = t => {
    const i = order.findIndex(x => x && t && x.toLowerCase() === t.toLowerCase());
    return i === -1 ? 999 : i;
  };
  return (tabs || [])
    .slice()
    .sort((a,b) => rank(a.title) - rank(b.title))
    .map(t => t.text)
    .filter(Boolean)
    .join('\n');
}

function resolveAllPanes($, names){
  const out = new Set();
  const nameRe = new RegExp(`\\b(?:${names.map(n=>escapeRe(n)).join('|')})\\b`, 'i');

  $('a,button,[role="tab"]').each((_, el)=>{
    const label = cleanup($(el).text());
    if (!label || !nameRe.test(label)) return;

    const href = $(el).attr('href') || '';
    const controls = $(el).attr('aria-controls') || '';
    const dataTarget = $(el).attr('data-target') || $(el).attr('data-tab') || '';

    if (href && href.startsWith('#')) {
      const t = $(href)[0]; if (t) out.add(t);
    }
    if (controls) {
      const t = documentQueryById($, controls); if (t) out.add(t);
    }
    if (dataTarget && dataTarget.startsWith('#')) {
      const t = $(dataTarget)[0]; if (t) out.add(t);
    }
  });

  $('[role="tabpanel"], .tab-pane, .panel, .tabs-content, .accordion-content, section').each((_, el)=>{
    const heading = cleanup($(el).find('h1,h2,h3,h4,h5').first().text());
    if (heading && nameRe.test(heading)) out.add(el);
  });

  const classRe = new RegExp(names.map(n=>escapeRe(n)).join('|'), 'i');
  $('[class]').each((_, el)=>{
    if (classRe.test($(el).attr('class') || '')) out.add(el);
  });

  return Array.from(out);
}

/* ================== ADD-ONLY: Tab title normalization ================== */
const TAB_SYNONYMS = {
  overview: ['overview','description','product description','product details','details','about','info','information'],
  specs: ['specifications','specification','technical specifications','tech specs','technical','size & weight','size and weight','dimensions','sizing'],
  features: ['features','key features','highlights','benefits','features/benefits'],
  downloads: ['downloads','documents','resources','manuals','documentation','technical resources','sds','msds','spec sheet','datasheet','brochure'],
};

function normTabTitle(s=''){
  const t = String(s).toLowerCase().replace(/\s+/g,' ').trim();
  const hit = (list)=> list.some(x => t.includes(x));
  if (hit(TAB_SYNONYMS.overview)) return 'overview';
  if (hit(TAB_SYNONYMS.specs))    return 'specs';
  if (hit(TAB_SYNONYMS.features)) return 'features';
  if (hit(TAB_SYNONYMS.downloads))return 'downloads';
  return '';
}

function firstNonEmpty(...xs){ for (const x of xs){ const v=cleanup(x); if (v) return v; } return ''; }

/* ================== ADD-ONLY: Remote/lazy content discovery ================== */
function paneRemoteHref($, panel){
  const $p = $(panel);
  // Direct attributes used by many themes/libs
  const attrs = ['data-url','data-href','data-content-url','data-remote','data-src','data-load','data-fragment','data-include','data-file','hx-get','hx-get-url'];
  for (const a of attrs){
    const v = $p.attr(a); if (v) return v;
  }
  // Dojo already handled elsewhere, but keep a fallback
  const dojo = $p.attr('data-dojo-props') || '';
  const m = /href\s*:\s*['"]([^'"]+)['"]/.exec(dojo);
  if (m) return m[1];

  // Sometimes panel has a single anchor to the real content
  const a = $p.find('a[href]').first().attr('href');
  if (a && /\.(html?|php|aspx|jsp)(?:[?#].*)?$/i.test(a)) return a;

  return '';
}

/* ================== ADD-ONLY: Generic tab/accordion candidate collector ================== */
function collectTabCandidates($, baseUrl){
  const out = [];

  // 1) ARIA/role-based tabs
  $('[role="tablist"]').each((_, tl)=>{
    $(tl).find('[role="tab"]').each((__, tab)=>{
      const $tab = $(tab);
      const title = cleanup($tab.attr('aria-label') || $tab.attr('title') || $tab.text());
      const controls = $tab.attr('aria-controls') || '';
      let $panel = controls ? $(documentQueryById($, controls)) : $();
      if (!$panel || !$panel.length){
        // try labelledby reverse
        const id = $tab.attr('id');
        if (id) $panel = $(`[role="tabpanel"][aria-labelledby="${id}"]`).first();
      }
      if ($panel && $panel.length){
        out.push({
          title,
          type: 'aria',
          el: $panel[0],
          html: $panel.html() || '',
          text: cleanup($panel.text() || ''),
          href: paneRemoteHref($, $panel[0]) ? abs(baseUrl, paneRemoteHref($, $panel[0])) : ''
        });
      }
    });
  });

  // 2) Classic .tabs / .tab-pane / .accordion variants
  const paneSel = [
    '.tab-pane','.tabs-panel','[role="tabpanel"]','.accordion-content','.accordion-item .content',
    '.panel','.panel-body','.product-tabs .tab-content > *','.tabs-content > *','section[data-tab]'
  ].join(', ');
  $(paneSel).each((_, el)=>{
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
    const $el = $(el);
    // Heading inside panel or previous sibling heading acts as the title
    const title = firstNonEmpty(
      $el.attr('data-title'),
      $el.attr('aria-label'),
      $el.prev('h1,h2,h3,h4,h5,button,a').first().text(),
      $el.find('h1,h2,h3,h4,h5').first().text(),
      // some themes echo tab name in class (e.g., "tab-description")
      ($el.attr('class')||'').replace(/[-_]/g,' ').split(/\s+/).find(w => /desc|overview|spec|feature|download/i.test(w)) || ''
    );
    out.push({
      title,
      type: 'panel',
      el,
      html: $el.html() || '',
      text: cleanup($el.text() || ''),
      href: paneRemoteHref($, el) ? abs(baseUrl, paneRemoteHref($, el)) : ''
    });
  });

  // 3) Fallback: tab triggers (a/button) that point to #id panels
  $('a[data-target], button[data-target], a[data-tab], button[data-tab], a[href^="#tab"], a[href^="#panel"]').each((_, t)=>{
    const $t = $(t);
    const title = cleanup($t.text() || $t.attr('aria-label') || $t.attr('title') || '');
    const target = $t.attr('data-target') || $t.attr('data-tab') || $t.attr('href') || '';
    if (!target || !target.startsWith('#')) return;
    const $panel = $(target).first();
    if (!$panel.length) return;
    out.push({
      title,
      type: 'trigger',
      el: $panel[0],
      html: $panel.html() || '',
      text: cleanup($panel.text() || ''),
      href: paneRemoteHref($, $panel[0]) ? abs(baseUrl, paneRemoteHref($, $panel[0])) : ''
    });
  });

  // De-dupe by panel element id or index
  const seen = new Set();
  const uniq = [];
  out.forEach((p, i)=>{
    const id = (p.el && $(p.el).attr('id')) || `idx:${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    uniq.push(p);
  });
  return uniq;
}

/* ================== ADD-ONLY: Hydrate generic remote panes ================== */
async function hydrateRemotePanes(cands, renderApiUrl, headers = {}) {
  if (!cands || !cands.length) return cands;
  const base = (renderApiUrl || '').replace(/\/+$/, '');
  const out = [];
  for (const c of cands) {
    const copy = { ...c };
    if ((!copy.html || copy.html.length < 40) && copy.href) {
      try {
        const url = `${base}/render?url=${encodeURIComponent(copy.href)}&mode=full`;
        const { html } = await fetchWithRetry(url, { headers });
        copy.html = html || '';
        copy.text = cleanup(cheerio.load(html).root().text() || '');
      } catch {}
    } 
    out.push(copy);
  }
  return out;
}

/* ================== ADD-ONLY: Rank/merge tabs into buckets ================== */
function bucketizeTabs(cands){
  const buckets = { overview: [], specs: [], features: [], downloads: [] };
  for (const c of cands){
    const norm = normTabTitle(c.title);
    if (norm && buckets[norm]) buckets[norm].push(c);
    else {
      // Heuristic fallback by content
      const t = (c.text || '').toLowerCase();
      if (/dimension|width|height|depth|weight|spec/i.test(t)) buckets.specs.push(c);
      else if (/feature|benefit|highlight/i.test(t)) buckets.features.push(c);
      else if (/manual|ifu|instruction|datasheet|spec\s*sheet|brochure|pdf/i.test(t)) buckets.downloads.push(c);
      else buckets.overview.push(c);
    }
  }
  return buckets;
}

/* ================== ADD-ONLY: Extract from buckets using your existing parsers ================== */
function extractFromBuckets($, buckets, baseUrl){
  const add = { desc: '', specs: {}, features: [], manuals: new Set(), images: new Set() };

  const collectImgs = (html) => {
    if (!html) return;
    const _$ = cheerio.load(html);
    _$('.accordion-content, .tab-pane, [role="tabpanel"], section, div, article')
      .find('img, source').each((_, n)=>{
        const src = _$(n).attr('src') || _$(n).attr('data-src') || pickLargestFromSrcset(_$(n).attr('srcset')) || '';
        if (src) add.images.add(abs(baseUrl, src));
      });
  };

  // Overview/Description
  for (const pane of buckets.overview){
    const $p = cheerio.load(pane.html || '');
    const d = extractDescriptionFromContainer($p, $p.root());
    if (d && d.length > (add.desc || '').length) add.desc = d;
    collectImgs(pane.html);
  }

  // Specs
  for (const pane of buckets.specs){
    const $p = cheerio.load(pane.html || '');
    Object.assign(add.specs, extractSpecsFromContainer($p, $p.root()));
    try {
      const jsonExtras = extractSpecsFromScripts($p, $p.root());
      Object.assign(add.specs, mergeSpecsAdditive(jsonExtras, {}));
    } catch {}
    collectImgs(pane.html);
  }

  // Features
  for (const pane of buckets.features){
    const $p = cheerio.load(pane.html || '');
    add.features.push(...extractFeaturesFromContainer($p, $p.root()));
    collectImgs(pane.html);
  }

  // Manuals
  for (const pane of buckets.downloads){
    const $p = cheerio.load(pane.html || '');
    collectManualsFromContainer($p, $p.root(), baseUrl, add.manuals);
    $p('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
      const href = String($p(el).attr('href')||'');
      if (href) add.manuals.add(abs(baseUrl, href));
    });
    collectImgs(pane.html);
  }

  return add;
}

/* ================== ADD-ONLY: Images from panes → filtered list ================== */
function finalizePaneImages(paneImgSet, baseUrl, opts){
  const arr = Array.from(paneImgSet || []);
  const filtered = filterAndRankExtraPaneImages(arr, baseUrl, opts);
  return filtered;
}

/* ================== ADD-ONLY: Unified Tab Harvester (entry point) ================== */
async function unifiedTabHarvest($, baseUrl, renderApiUrl, headers, opts){
  const cands0 = collectTabCandidates($, baseUrl);
  const cands  = await hydrateRemotePanes(cands0, renderApiUrl, headers);
  const buckets= bucketizeTabs(cands);
  const add    = extractFromBuckets($, buckets, baseUrl);

  const images = finalizePaneImages(add.images, baseUrl, opts);
  return {
    desc: add.desc,
    specs: prunePartsLikeSpecs(add.specs || {}),
    features: dedupeList(add.features || []).slice(0, 20),
    manuals: dedupeManualUrls(Array.from(add.manuals || [])),
    images
  };
}

/* ================== Tab/Accordion Harvester ================== */
function extractSpecsFromContainer($, container){
  // ADD: avoid footer/nav/reco contamination
  if (isFooterOrNav($, container) || isRecoBlock($, container)) return {};
  const out = {};
  const $c = $(container);

  $c.find('table').each((_, tbl)=>{
    if (isPartsOrAccessoryTable($, tbl)) return; // ADD: skip parts/accessory tables inside containers
    $(tbl).find('tr').each((__, tr)=>{
      const cells=$(tr).find('th,td');
      if (cells.length>=2){
        const k=cleanup($(cells[0]).text()).toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        const v=cleanup($(cells[1]).text());
        if (k && v && k.length<80 && v.length<400) out[k]=v;
      }
    });
  });

  $c.find('dl').each((_, dl)=>{
    const dts=$(dl).find('dt'), dds=$(dl).find('dd');
    if (dts.length === dds.length && dts.length){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text()).toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        const v=cleanup($(dds[i]).text());
        if (k && v && k.length<80 && v.length<400) out[k]=v;
      }
    }
  });

  $c.find('li').each((_, li)=>{
    const t = cleanup($(li).text());
    if (!t || t.length < 3 || t.length > 250) return;
    const m = t.split(/[:\-–]\s+/);
    if (m.length >= 2){
      const k = m[0].toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
      const v = m.slice(1).join(': ').trim();
      if (k && v && !out[k]) out[k]=v;
    }
  });

  $c.find('.spec, .row, .grid, [class*="spec"]').each((_, r)=>{
    const a = cleanup($(r).find('.label, .name, .title, strong, b, th').first().text());
    const b = cleanup($(r).find('.value, .val, .data, .detail, td, span, p').last().text());
    if (a && b) out[a.toLowerCase().replace(/\s+/g,'_').replace(/:$/,'')] = b;
  });

  // As a last resort, parse any remaining div/span/p elements within the container for
  // colon- or hyphen-separated key/value pairs.  Some websites place technical
  // specifications in freeform grids or styled rows without using <table>, <dl> or <li>.
  // This aggressive pass helps capture those by splitting on ':' or '-' when present.
  $c.find('div, span, p').each((_, el) => {
    const t = cleanup($(el).text());
    if (!t || t.length < 3 || t.length > 250) return;
    // Skip if this element is already inside a table row, dl or li that we've processed
    if ($(el).closest('table,tr,dl,li').length) return;
    const m = t.split(/[:\-–]\s+/);
    if (m.length >= 2) {
      const k = m[0].toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
      const v = m.slice(1).join(': ').trim();
      if (k && v && !out[k]) out[k] = v;
    }
  });

  return out;
}

function collectManualsFromContainer($, container, baseUrl, sinkSet){
  const allowRe = /(manual|ifu|instruction|instructions|user[- ]?guide|owner[- ]?manual|assembly|install|installation|setup|quick[- ]?start|spec(?:sheet)?|datasheet|guide|brochure)/i;
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;
  $(container).find('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href = String($(el).attr('href') || "");
    const full = abs(baseUrl, href);
    if (!full) return;
    const L = full.toLowerCase();
    if (allowRe.test(L) && !blockRe.test(L)) sinkSet.add(full);
  });
}

function extractFeaturesFromContainer($, container){
  const items = [];
  const $c = $(container);

  const pushIfGood = (txt) => {
    const t = cleanup(txt);
    if (!t) return;
    if (t.length < 7 || t.length > 220) return;
    if (/>|›|»/.test(t)) return;
    if (/\b(privacy|terms|trademark|copyright|newsletter|subscribe)\b/i.test(t)) return;
    if (/(https?:\/\/|www\.)/i.test(t)) return;
    items.push(t);
  };

  $c.find('li').each((_, li)=> pushIfGood($(li).text()));
  $c.find('h3,h4,h5').each((_, h)=> pushIfGood($(h).text()));

  const seen = new Set();
  const out = [];
  for (const t of items){
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
        // allow up to 50 features to avoid truncating long bullet lists
        if (out.length >= 50) break;
  }
  return out;
}

/* — Overview extractor (paragraphs only) — */
function extractDescriptionFromContainer($, container){
  const $c = $(container);
  const parts = [];
  const push = (t) => {
    t = cleanup(t);
    if (!t) return;
    // Skip common non‑informational labels (legal, share, etc.)
    if (/^\s*(share|subscribe|privacy|terms|trademark|copyright)\b/i.test(t)) return;
    // Skip lines that include CSS or style code.  CSS often contains braces or semicolons
    // (e.g. ".urgent-banner { ... }"), @media rules, keyframes, data‑attributes or escaped
    // unicode sequences (e.g. "\u003C") which are not relevant to product descriptions.
    if (/[{};@]/.test(t) || /@keyframes|@media|data-sub-layout|\u003C/i.test(t)) return;
    // Skip lines that contain price or cart/sharing information.  We only want product
    // descriptions and specifications, not pricing, quantity, review prompts, or
    // social/share actions.
    if (/\$\d/.test(t) || /\b(MSRP|Now:|Was:|Add to Cart|Add to Wish|Quantity|Rating Required|Write a Review|Facebook|Linkedin|Pinterest|Twitter|X|Select Rating)\b/i.test(t)) return;
    // Skip PayPal/CSS message content and quantity controls (#zoid-paypal, increase/decrease qty)
    if (/^#/.test(t) || /zoid-paypal|increase\s+quantity|decrease\s+quantity/i.test(t)) return;
    // Skip shipping, returns, reviews, or section headings not related to product details
    if (/^\s*(shipping|returns|0\s*reviews?|review|reviews)\b/i.test(t)) return;
    // Skip site-wide taglines or slogans unrelated to a specific product
    if (/MedicalEx is an online store/i.test(t)) return;
    // Skip cookie banners or privacy consent text and other non-product notices
    if (/cookie(s)? policy|this website uses cookies|we use cookies|accept all cookies|cookie settings|cookie notice|analytics cookies|performance cookies|advertising cookies/i.test(t)) return;
    if (/newsletter|subscribe|sitemap|contact us|terms of use|privacy policy|\ball rights reserved\b/i.test(t)) return;
    parts.push(t);
  };

  // Traverse elements in DOM order and collect text from meaningful tags.  This preserves
  // the logical flow of titles and their associated content.  Capture headings, bold
  // labels, paragraphs, list items, and generic spans/divs.  Skip scripts/styles.
  $c.find('*').each((_, el) => {
    const $el = $(el);
    if ($el.is('script,style')) return;
    // Determine if this element is one we want to capture
    if ($el.is('li')) {
      const txt = $el.text();
      if (!txt) return;
      push(`• ${txt}`);
    } else if ($el.is('h1,h2,h3,h4,h5,strong,b,.lead,.intro,p,.copy,.text,.rte,.wysiwyg,.content-block,div,span')) {
      const txt = $el.text();
      if (!txt) return;
      push(txt);
    }
  });

  const lines = parts
    .map(s => s.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const s of lines) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out.join('\n');
}
/* ====== Markdown builders ====== */
function extractDescriptionMarkdown($){
  const candidates = [
    // Standard semantic description attribute
    '[itemprop="description"]',
    // Common classes used for product descriptions in various themes
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description, .overview, .product-overview, .intro, .summary',
    // BigCommerce/Stencil product view containers often host the hook and bullets
    '.productView, .productView-info, .productView-description, .productView-details, .product-view, .product-view-info, .product-view-description',
    // Tab content containers
    '.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-tabs'
  ].join(', ');

  let bestEl = null, bestLen = 0;
  $(candidates).each((_, el)=>{
    // ADD: skip footer/nav & legal-like text nodes
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
    const textCheck = cleanup($(el).text());
    if (LEGAL_MENU_RE.test(textCheck) || /^©\s?\d{4}/.test(textCheck)) return;

    const text = textCheck;
    if (text && text.length > bestLen) { bestLen = text.length; bestEl = el; }
  });
  if (!bestEl) return "";
  // Optional fallback: scan larger main/product containers if the initial candidate is too short or
  // misses key introductory paragraphs.  This helps capture descriptive hooks that sit
  // outside of the usual .product-description/.tab-content sections.
  {
    const otherCandidates = [
      'main', '#main', '.main', '.product', '.product-detail', '.product-details',
      '.product__info', '.product__info-wrapper', '.productView', '.productView-info', '.productView-description', '.productView-details',
      '.product-view', '.product-view-info', '.product-view-description', '.content', '#content'
    ].join(', ');
    let backupEl = null, backupLen = 0;
    $(otherCandidates).each((_, el) => {
      if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
      const textCheck = cleanup($(el).text());
      // Skip obviously irrelevant containers (shipping/returns etc.)
      if (/^\s*(shipping|returns|review|0\s*reviews?)\b/i.test(textCheck)) return;
      if (textCheck && textCheck.length > backupLen) {
        backupLen = textCheck.length;
        backupEl = el;
      }
    });
    if (backupEl && backupLen > bestLen) {
      bestEl = backupEl;
      bestLen = backupLen;
    }
  }

  // Always extract the markdown from the best container.  Additionally, attempt
  // to capture any introductory copy that may live outside of the usual
  // description/tab containers.  In BigCommerce themes, the product "hook"
  // often sits above the tabs (e.g. in a .productView-info or summary
  // container).  To ensure we don’t miss it, also extract from the
  // fallback container when it differs from bestEl and merge the results.
  const rawBest = extractDescriptionFromContainer($, bestEl);
  let rawExtra = "";
  if (backupEl && backupEl !== bestEl) {
    rawExtra = extractDescriptionFromContainer($, backupEl);
  }
  // Additionally, attempt to capture the first descriptive paragraph(s) that follow the
  // product name heading.  On many product pages, a hook paragraph lives
  // immediately after the <h1> title and before any bullet lists or tabs.
  function extractHookParagraphs() {
    const out = [];
    const firstNameEl = $('h1,h2').first();
    if (!firstNameEl.length) return '';
    let el = firstNameEl.next();
    const stopSelector = 'ul,ol,table,dl,script,style,[role="tablist"],h1,h2,h3,h4,h5';
    while (el && el.length) {
      if (el.is(stopSelector)) break;
      const txt = cleanup(el.text());
      if (txt && !/\$\d|Add to Cart|Quantity|Write a Review|rating required|shipping|returns|review|cookie(s)?|cookies|newsletter|subscribe|privacy policy|terms of use|analytics|performance|advertising/i.test(txt)) {
        out.push(txt);
      }
      el = el.next();
    }
    return out.join('\n');
  }
  const hookRaw = extractHookParagraphs();

  // Attempt to find a hook by scanning the entire body for a sentence that
  // contains the product name and is reasonably long.  This serves as a
  // last‑resort fallback when the hook paragraphs above fail.  We look for
  // the first element whose text includes the product name (before any dash
  // separator) and has at least 10 words.  Only consider visible elements
  // like p/span/div.
  function findHookByProductName() {
    // Determine the product name from the page.  Prefer the og:title meta
    // content, otherwise fall back to the first <h1> text.
    const metaTitle = $('meta[property="og:title"]').attr('content') || '';
    const h1Title = $('h1').first().text() || '';
    const title = metaTitle || h1Title;
    if (!title) return '';
    // Use the portion before an em dash or hyphen as the base name to match.
    const base = title.split(/[–-]/)[0].trim();
    if (!base) return '';
    let found = '';
    $('p,span,div').each((_, el) => {
      if (found) return;
      const txt = cleanup($(el).text());
      if (!txt) return;
      if (txt.includes(base)) {
        // Avoid capturing meta or tagline texts about the store itself
        if (/MedicalEx is an online store/i.test(txt)) return;
        // Capture the closest container's full text to get a complete paragraph
        const full = cleanup($(el).closest('p,div,span').text());
        const cand = full || txt;
        // Skip if candidate contains cookie/privacy/newsletter/unrelated text
        if (/cookie(s)?|cookies|newsletter|subscribe|privacy policy|terms of use|analytics|performance|advertising/i.test(cand)) return;
        found = cand;
      }
    });
    if (found) return found;
    // Fallback: scan the whole body text for the base name and extract the sentence it appears in.
    const bodyTxt = cleanup($('body').text());
    const idx = bodyTxt.indexOf(base);
    if (idx !== -1) {
      const prev = bodyTxt.lastIndexOf('.', idx);
      const next = bodyTxt.indexOf('.', idx + base.length);
      let start = prev === -1 ? 0 : prev + 1;
      let end = next === -1 ? Math.min(bodyTxt.length, idx + base.length + 250) : next + 1;
      const candidate = cleanup(bodyTxt.slice(start, end));
      if (candidate && !/MedicalEx is an online store/i.test(candidate) && !/cookie(s)?|cookies|newsletter|subscribe|privacy policy|terms of use|analytics|performance|advertising/i.test(candidate)) {
        return candidate;
      }
    }
    return '';
  }
  const hookByName = findHookByProductName();
  // Merge the two extractions while preserving order and removing
  // duplicates.  The fallback text (rawExtra) comes first so the hook
  // appears before the tab description.  We split on newlines to
  // deduplicate line by line.
  const mergeAndDedup = (a, b) => {
    const outLines = [];
    const seen = new Set();
    for (const line of [...String(a||"").split(/\n+/), ...String(b||"").split(/\n+/)]) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        outLines.push(trimmed);
      }
    }
    return outLines.join('\n');
  };
  let combinedRaw = mergeAndDedup(hookRaw, mergeAndDedup(rawExtra, rawBest));
  // If we found a hook by product name that isn't already included, prepend it.
  if (hookByName) {
    const lowerCombined = combinedRaw.toLowerCase();
    if (!lowerCombined.includes(hookByName.toLowerCase())) {
      combinedRaw = `${hookByName}\n${combinedRaw}`;
    }
  }
  // Remove any site-wide taglines that may have slipped through the earlier filters
  combinedRaw = combinedRaw
    .split('\n')
    .filter(l => !/MedicalEx is an online store/i.test(l))
    // Remove any remaining cookie/privacy/newsletter lines
    .filter(l => !/cookie(s)?|cookies|newsletter|subscribe|privacy policy|terms of use|analytics|performance|advertising/i.test(l))
    .join('\n');
  return containerTextToMarkdown(combinedRaw);
}

function containerTextToMarkdown(s){
  const lines = String(s || "").split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = [];
  let para = [];
  const flush = () => { if (para.length){ out.push(para.join(' ')); para = []; } };

  for (const line of lines){
    if (line.startsWith("• ")){ flush(); out.push(`- ${line.slice(2).trim()}`); }
    else if (/^[-*] /.test(line)){ flush(); out.push(line); }
    else { para.push(line); }
  }
  flush();
  return out.join("\n\n");
}

function textToMarkdown(t){
  const lines = String(t||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if (!lines.length) return "";
  const out = [];
  let para = [];
  const flush = () => { if (para.length){ out.push(para.join(' ')); para = []; } };

  for (const line of lines){
    if (/^[-*•] /.test(line)){ flush(); out.push(line.replace(/^• /, "- ")); }
    else { para.push(line); }
  }
  flush();
  return out.join("\n\n");
}

function objectToMarkdownTable(obj){
  const entries = Object.entries(obj || {});
  if (!entries.length) return "";
  const rows = entries.map(([k,v]) => `| ${toTitleCase(k.replace(/_/g,' '))} | ${String(v).replace(/\n+/g, ' ').trim()} |`);
  return ["| Spec | Value |","|---|---|",...rows].join("\n");
}

/* === Images-in-panes filter === */
function filterAndRankExtraPaneImages(urls, baseUrl, opts){
  const minPx     = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng= (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
  const badRe = /(logo|brandmark|favicon|sprite|placeholder|no-?image|missingimage|icon|social|facebook|twitter|instagram|linkedin|\/common\/images\/|\/icons\/|\/wp-content\/themes\/)/i;

  let arr = (urls||[])
    .filter(Boolean)
    .map(u => decodeHtml(abs(baseUrl, u)))
    .filter(u => allowWebExt.test(u))
    .filter(u => !badRe.test(u))
    .filter(u => {
      const { w,h } = inferSizeFromUrl(u);
      if (!w && !h) return true;
      return Math.max(w||0, h||0) >= minPx;
    });

  return Array.from(new Set(arr)).slice(0, 6);
}

/* ================== Utils ================== */

// ---- FIX: add brand inference helper used as fallback ----
function inferBrandFromName(name){
  const first = (String(name||"").trim().split(/\s+/)[0] || "");
  if (/^(the|a|an|with|and|for|of|by|pro|basic)$/i.test(first)) return "";
  if (/^[A-Z][A-Za-z0-9\-]+$/.test(first)) return first;
  return "";
}
// ----------------------------------------------------------

function collectCodesFromUrl(url){
  const out = [];
  try {
    const u = url.toLowerCase();
    const m1 = /\/item\/([^\/?#]+)/i.exec(u);
    const m2 = /\/p\/([a-z0-9._-]+)/i.exec(u);
    const m3 = /\/product\/([a-z0-9._-]+)/i.exec(u);
    [m1, m2, m3].forEach(m => { if (m && m[1]) out.push(m[1]); });
  } catch {}
  return out;
}

function deepFindImagesFromJson(obj, out = []){
  if (!obj) return out;
  if (typeof obj === 'string') {
    if (/\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(obj)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach(v => deepFindImagesFromJson(v, out)); return out; }
  if (typeof obj === 'object') {
    const keys = ['url','src','image','imageUrl','imageURL','contentUrl','thumbnail','full','large','zoom','original','href'];
    keys.forEach(k => {
      const v = obj[k];
      if (typeof v === 'string' && /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(v)) out.push(v);
      else if (v) deepFindImagesFromJson(v, out);
    });
    ['images','gallery','media','assets','pictures','variants','slides'].forEach(k=>{ if (obj[k]) deepFindImagesFromJson(obj[k], out); });
    Object.values(obj).forEach(v => deepFindImagesFromJson(v, out));
  }
  return out;
}

function deepFindPdfsFromJson(obj, out = []){
  if (!obj) return out;
  if (typeof obj === 'string') {
    if (/\.pdf(?:[?#].*)?$/i.test(obj)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach(v => deepFindPdfsFromJson(v, out)); return out; }
  if (typeof obj === 'object') {
    Object.values(obj).forEach(v => deepFindPdfsFromJson(v, out));
  }
  return out;
}

function firstGoodParagraph($){
  let best = "";
  $('main, #main, .main, .content, #content, body').first().find("p").each((_, p)=>{
    const t = cleanup($(p).text());
    if (t && t.length > best.length) best = t;
  });
  return best;
}

// ADD: footer/nav detection + legal/menu text guard
function isFooterOrNav($, el){
  return $(el).closest(
    'footer, #footer, .footer, .site-footer, .page-footer, .global-footer, #global-footer,' +
    ' nav, .nav, .navbar, [role="navigation"], [role="contentinfo"],' +
    ' [aria-label*="footer" i], [aria-label*="breadcrumb" i], .breadcrumbs,' +
    ' .legal, .legalese, .bottom-bar, .cookie, .consent, .newsletter, .subscribe, .sitemap'
  ).length > 0;
}

// ADD: recommendation/reco block detector (prevents spec leakage from “related/also viewed/etc.”)
function isRecoBlock($, el){
  if ($(el).closest(
    '.related, .related-products, #related-products, ' +
    '.upsell, .cross-sell, .crosssell, .you-may-also-like, ' +
    '.recommended, .recommendations, .product-recommendations, .product-recs, [data-recommendations], ' +
    '.frequently-bought, .frequently-bought-together, .fbt, ' +
    '.also-viewed, .people-also-viewed, .also-bought, .customers-also-bought, ' +
    '.similar-products, .more-like-this, [data-related-products], [data-upsell]'
  ).length > 0) return true;

  // Additional recommendation/related section identifiers
  if ($(el).closest(
    '.recommended-for-you, .recommendation, .recommended-items, .recommended-products, .related-items, .related-content, ' +
    '.you-may-also-be-interested, .you-may-be-interested, .customers-viewed, .customers-also-viewed, ' +
    '.product-suggestions, .suggested-products'
  ).length > 0) return true;

  // ADD: extra coverage for sites using singular `.recommendation`, "co-viewed", and explicit data flags
  if ($(el).closest('.recommendation, .co-viewed, [data-br-request-type="recommendation"]').length > 0) return true;

  return false;
}

const LEGAL_MENU_RE = /\b(privacy|terms|cookies?|trademark|copyright|©|™|®|newsletter|subscribe|sitemap|back\s*to\s*top|about|careers|press|blog|faq|support|returns?|shipping|track\s*order|store\s*locator|contact|account|login|sign\s*in)\b/i;

/* ===== ADD: Parts/accessory table detection & pruning (add-only) ===== */
const PARTS_HEADER_RE = /\b(no\.?|part(?:\s*no\.?)?|item(?:\s*description)?|qty(?:\s*req\.)?|quantity|price)\b/i;

function isPartsOrAccessoryTable($, tbl){
  try {
    // header scan
    const header = $(tbl).find('tr').first().find('th,td')
      .map((_,c)=>cleanup($(c).text())).get().join(' | ');
    if (PARTS_HEADER_RE.test(header)) return true;

    // row heuristics
    let numericFirstCol = 0, itemLinks = 0, rows = 0;
    $(tbl).find('tr').each((_, tr)=>{
      const cells = $(tr).find('td,th');
      if (cells.length < 2) return;
      rows++;
      const first = cleanup($(cells[0]).text());
      if (/^\d+$/.test(first)) numericFirstCol++;
      if ($(cells[1]).find('a[href*="/item/"], a[href*="/product/"]').length) itemLinks++;
    });
    return (rows >= 3 && numericFirstCol >= 2 && itemLinks >= 2);
  } catch { return false; }
}

function prunePartsLikeSpecs(specs = {}){
  const out = {};
  // Keys that clearly refer to parts lists, pricing, shipping or quantity controls rather than
  // product specifications.  These are removed from the specs object during pruning.
  const BAD_KEYS = /^(no\.?|item(?:_)?description|qty(?:_?req\.?)?|quantity|price|part(?:_)?no\.?|shipping|msrp|now|increase_quantity.*|decrease_quantity.*|zoid.*|returns|review|reviews)$/i;

  for (const [k, v] of Object.entries(specs || {})) {
    const key = String(k || "").trim();
    const val = String(v || "").trim();
    // drop empty
    if (!key || !val) continue;
    // drop numeric index keys (1, 2, 3…)
    if (/^\d+$/.test(key)) continue;
    // drop classic parts table headers masquerading as specs
    // drop banned keys and any keys starting with a hash (CSS selectors, PayPal iframe IDs, etc.)
    if (BAD_KEYS.test(key) || key.startsWith('#')) continue;
    out[key] = val;
  }
  return out;
}

/* ================== Tab harvest orchestrator ================== */
async function augmentFromTabs(norm, baseUrl, html, opts){
  const $ = cheerio.load(html);

  // === START: static tab harvest via tabHarvester.js ===
  try {
    const { tabs, includedItems, productsInclude } = await harvestTabsFromHtml(html, baseUrl);
    if (tabs && tabs.length) {
      norm.tabs = tabs;
    }
    if (includedItems && includedItems.length) {
      norm.includedItems = includedItems;
      // also output structured version
      norm["Included Items JSON"] = includedItems.map(item => ({ item }));
      // Promote included items into features_raw if not already present.  These
      // often describe what comes in the box and can be valuable features.
      const seen = new Set((norm.features_raw || []).map(v => String(v).toLowerCase()));
      for (const itm of includedItems) {
        const k = String(itm).toLowerCase();
        if (!seen.has(k)) {
          (norm.features_raw ||= []).push(itm);
          seen.add(k);
        }
        if ((norm.features_raw || []).length >= 40) break;
      }
    }
    if (productsInclude && productsInclude.length) {
      norm.productsInclude = productsInclude;
      norm["Key Features JSON"] = (norm["Key Features JSON"] || []).concat(
        productsInclude.map(feature => ({ feature }))
      );
      // Promote productsInclude list into features_raw as well.  These are
      // typically high‑value features and should be included.
      const seen = new Set((norm.features_raw || []).map(v => String(v).toLowerCase()));
      for (const itm of productsInclude) {
        const k = String(itm).toLowerCase();
        if (!seen.has(k)) {
          (norm.features_raw ||= []).push(itm);
          seen.add(k);
        }
        if ((norm.features_raw || []).length >= 40) break;
      }
    }

    // Harvest all tab content regardless of title.  For each tab, parse features,
    // specs, descriptions, and manuals.  This ensures that even tabs with
    // unfamiliar titles contribute data.  We process after promoting
    // included/product include items so that features from those lists are
    // already deduplicated.
    if (tabs && tabs.length) {
      for (const tab of tabs) {
        if (!tab || !(tab.html || tab.text)) continue;
        try {
          const $p = cheerio.load(tab.html || '');
          // Extract specs from this tab and merge
          const extraSpecs = extractSpecsFromContainer($p, $p.root());
          if (extraSpecs && Object.keys(extraSpecs).length) {
            norm.specs = { ...(norm.specs || {}), ...prunePartsLikeSpecs(extraSpecs) };
          }
          // Extract features from this tab and merge
          const tabFeatures = extractFeaturesFromContainer($p, $p.root());
          if (tabFeatures && tabFeatures.length) {
            const seen = new Set((norm.features_raw || []).map(v => String(v).toLowerCase()));
            for (const f of tabFeatures) {
              const k = String(f).toLowerCase();
              if (!seen.has(k)) {
                (norm.features_raw ||= []).push(f);
                seen.add(k);
              }
              if ((norm.features_raw || []).length >= 40) break;
            }
          }
          // Extract description paragraphs from this tab (longest)
          const descCandidate = extractDescriptionFromContainer($p, $p.root());
          if (descCandidate && descCandidate.length) {
            // Only merge if it adds more unique content
            norm.description_raw = mergeDescriptions(norm.description_raw || '', descCandidate);
          }
          // Extract manuals from this tab
          const manualSet = new Set();
          collectManualsFromContainer($p, $p.root(), baseUrl, manualSet);
          if (manualSet.size) {
            const have = new Set(norm.manuals || []);
            for (const u of manualSet) {
              if (!have.has(u)) {
                (norm.manuals ||= []).push(u);
                have.add(u);
              }
            }
          }
        } catch (err) {
          // ignore parse errors for individual tab
        }
      }
    }
  } catch (e) {
    // non-fatal; record error for debugging
    norm.tabHarvestError = String(e && e.message ? e.message : e);
  }
  // === END: static tab harvest ===

  // === ADD-ONLY: Unified tab/accordion harvester (runs before Dojo pre-pass) ===
  try {
    const headers = { "User-Agent": "MedicalExIngest/1.7" };
    if (RENDER_API_TOKEN) headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;
    const uni = await unifiedTabHarvest($, baseUrl, RENDER_API_URL, headers, opts);

    if (uni.desc && uni.desc.length > (norm.description_raw || '').length) {
      norm.description_raw = mergeDescriptions(norm.description_raw || "", uni.desc);
    }
    if (uni.specs && Object.keys(uni.specs).length) {
      norm.specs = { ...(norm.specs || {}), ...uni.specs };
    }
    if (uni.features && uni.features.length) {
      const seen = new Set((norm.features_raw || []).map(v => String(v).toLowerCase()));
      for (const f of uni.features) {
        const k = String(f).toLowerCase();
        if (!seen.has(k)) { (norm.features_raw ||= []).push(f); seen.add(k); }
        if (norm.features_raw.length >= 40) break;
      }
    }
    if (uni.manuals && uni.manuals.length) {
      const have = new Set(norm.manuals || []);
      for (const u of uni.manuals) {
        if (!have.has(u)) { (norm.manuals ||= []).push(u); have.add(u); }
      }
    }
    if (uni.images && uni.images.length) {
      const haveBase = new Set((norm.images || []).map(o => (o.url||'').split('/').pop().split('?')[0]));
      for (const u of uni.images) {
        const b = u.split('/').pop().split('?')[0];
        if (!haveBase.has(b)) { (norm.images ||= []).push({ url: u }); haveBase.add(b); }
        if (norm.images.length >= 12) break;
      }
    }
  } catch (e) {
    // non-fatal: continue with existing Dojo + resolveAllPanes logic
  }
  // === end Unified harvester ===

  // === Dojo/dijit TabContainer pre-pass ===
  try {
    const dojoTabs0 = parseDojoTabs($, baseUrl);
    if (dojoTabs0.length) {
      const headers = { "User-Agent": "MedicalExIngest/1.7" };
      if (RENDER_API_TOKEN) headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;
      const dojoTabs = await hydrateLazyTabs(dojoTabs0, RENDER_API_URL, headers);

      const specNames = ['specification','specifications','technical specifications','tech specs','details'];
      const featNames = ['features','features/benefits','benefits','key features','highlights'];
      const downNames = ['downloads','documents','technical resources','resources'];
      const descNames = ['overview','description','product details','details'];

      const addSpecs   = {};
      const addManuals = new Set();
      const addFeatures= [];
      let addDesc = "";

      for (const t of dojoTabs) {
        if (!t.html && !t.text) continue;
        const $p = cheerio.load(t.html || "");
        const title = String(t.title || '').toLowerCase();

        if (specNames.some(n => title.includes(n))) {
          Object.assign(addSpecs, extractSpecsFromContainer($p, $p.root()));
          /* ==== MEDX ADD-ONLY: specs-from-scripts in Dojo tab v1 ==== */
          try {
            const jsonExtras = extractSpecsFromScripts($p, $p.root());
            Object.assign(addSpecs, mergeSpecsAdditive(jsonExtras, {}));
          } catch {}
        }
        if (featNames.some(n => title.includes(n))) {
          addFeatures.push(...extractFeaturesFromContainer($p, $p.root()));
        }
        if (downNames.some(n => title.includes(n))) {
          collectManualsFromContainer($p, $p.root(), baseUrl, addManuals);
          ($p('a[href$=".pdf"], a[href*=".pdf"]') || []).each((_, el)=>{
            const href = String($p(el).attr("href")||"");
            if (href) addManuals.add(abs(baseUrl, href));
          });
        }
        if (descNames.some(n => title.includes(n))) {
          const d = extractDescriptionFromContainer($p, $p.root());
          if (d && d.length > (addDesc || "").length) addDesc = d;
        }
      }

      if (addDesc) norm.description_raw = mergeDescriptions(norm.description_raw || "", addDesc);
      if (Object.keys(addSpecs).length) norm.specs = { ...(norm.specs || {}), ...prunePartsLikeSpecs(addSpecs) };

      if (addFeatures.length) {
        const seen = new Set((norm.features_raw || []).map(v=>String(v).toLowerCase()));
        for (const f of addFeatures) {
          const k = String(f).toLowerCase();
          if (!seen.has(k)) { (norm.features_raw ||= []).push(f); seen.add(k); }
          if (norm.features_raw.length >= 40) break;
        }
      }

      if (addManuals.size) {
        const have = new Set((norm.manuals || []));
        for (const u of addManuals) {
          if (!have.has(u)) { (norm.manuals ||= []).push(u); have.add(u); }
        }
      }
    }
  } catch(e) {
    // non-fatal
  }
  // === end Dojo/dijit pre-pass ===

  const specPanes   = resolveAllPanes($, [
    'specification','specifications','technical specifications','tech specs',
    'size & weight','size and weight','dimensions','dimension','sizing',
    'details'
  ]);
  const manualPanes = resolveAllPanes($, [ 'downloads','documents','technical resources','parts diagram','resources','manuals','documentation' ]);
  const featurePanes= resolveAllPanes($, [ 'features','features/benefits','benefits','key features','highlights' ]);
  const descPanes   = resolveAllPanes($, [ 'overview','description','product details','details' ]);

  const addSpecs = {};
  for (const el of specPanes) {
    Object.assign(addSpecs, extractSpecsFromContainer($, el));
    /* ==== MEDX ADD-ONLY: specs-from-scripts inside spec panes v1 ==== */
    try {
      const jsonExtras = extractSpecsFromScripts($, el);
      Object.assign(addSpecs, mergeSpecsAdditive(jsonExtras, {}));
    } catch {}
  }

  const addManuals = new Set();
  for (const el of manualPanes) collectManualsFromContainer($, el, baseUrl, addManuals);

  const addFeatures = [];
  for (const el of featurePanes) addFeatures.push(...extractFeaturesFromContainer($, el));

  let addDesc = "";
  for (const el of descPanes) {
    const d = extractDescriptionFromContainer($, el);
    if (d && d.length > addDesc.length) addDesc = d;
  }

  if (addDesc) norm.description_raw = mergeDescriptions(norm.description_raw || "", addDesc);
  if (Object.keys(addSpecs).length) norm.specs = { ...(norm.specs || {}), ...prunePartsLikeSpecs(addSpecs) };

  if (addFeatures.length) {
    const seen = new Set((norm.features_raw || []).map(v=>String(v).toLowerCase()));
    for (const f of addFeatures) {
      const k = String(f).toLowerCase();
      if (!seen.has(k)) { (norm.features_raw ||= []).push(f); seen.add(k); }
      if (norm.features_raw.length >= 40) break;
    }
  }

  const paneImgs = new Set();
  const allPanes = [...specPanes, ...manualPanes, ...featurePanes, ...descPanes];
  for (const el of allPanes) {
    $(el).find('img, source').each((_, n)=>{
      const src = $(n).attr('src') || $(n).attr('data-src') || pickLargestFromSrcset($(n).attr('srcset')) || "";
      if (src) paneImgs.add(abs(baseUrl, src));
    });
  }
  if (paneImgs.size) {
    const filtered = filterAndRankExtraPaneImages(Array.from(paneImgs), baseUrl, opts);
    if (filtered.length) {
      const haveBase = new Set((norm.images || []).map(o => (o.url||'').split('/').pop().split('?')[0]));
      for (const u of filtered) {
        const b = u.split('/').pop().split('?')[0];
        if (!haveBase.has(b)) {
          (norm.images ||= []).push({ url: u });
          haveBase.add(b);
        }
        if (norm.images.length >= 12) break;
      }
    }
  }
  return norm;
}

/* ================== Optional post-processor (gated by &sanitize=true) ================== */
function sanitizeIngestPayload(p) {
  const out = { ...p };

  const legalRe = /\b(privacy|terms|cookies?|trademark|copyright|©|™|®|newsletter|subscribe|sitemap|back\s*to\s*top|about|careers|press|blog|faq|support|returns?|shipping|track\s*order|store\s*locator|contact|account|login|facebook|instagram|twitter|linkedin)\b/i;
  const urlish  = /(https?:\/\/|www\.|@[a-z0-9_.-]+)/i;
  const cleanFeature = (t) => t && t.length >= 7 && t.length <= 220 && !legalRe.test(t) && !urlish.test(t) && !/[›»>]/.test(t);

  let features = Array.isArray(out.features_raw) ? out.features_raw.filter(cleanFeature) : [];
  features = dedupeList(features);

  if (features.length < 3) {
    const specBullets = Object.entries(out.specs || {})
      .map(([k, v]) => `${toTitleCase(k.replace(/_/g, ' '))}: ${String(v).trim()}`)
      .filter((s) => s.length >= 7 && s.length <= 180)
      .slice(0, 12);
    features = dedupeList([...features, ...specBullets]).slice(0, 12);
  }
  out.features_raw = features.slice(0, 20);

  const allowManual = /(manual|ifu|instruction|instructions|user[- ]?guide|owner[- ]?manual|assembly|install|installation|setup|quick[- ]?start|datasheet|spec(?:sheet)?|guide|brochure)/i;
  const blockManual = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;
  out.manuals = (out.manuals || []).filter((u) => allowManual.test(u) && !blockManual.test(u));

  // EXPANDED bad image filter to exclude placeholders
  const badImg = new RegExp([
    // Common UI/placeholder buckets (bounded)
    '(?:^|[\\/_.-])(logo|brandmark|favicon|sprite)(?:[\\/_.-]|$)',
    '(?:^|[\\/_.-])(placeholder|no[-_]?image|missingimage|coming[-_]?soon|awaiting|spacer|blank|default|dummy|sample|temp)(?:[\\/_.-]|$)',
    '(?:^|[\\/_.-])swatch(?:[\\/_.-]|$)',
    // Safer icon(s) boundary to avoid "miconazole"
    '(?:^|[\\/_.-])icons?(?:[\\/_.-]|$)',
    // Social / theme paths
    '\\/common\\/images\\/',
    '\\/icons\\/',
    '\\/wp-content\\/themes\\/',
    '\\/rbslider\\/',
    '\\/theme_options\\/',
    '\\/wysiwyg\\/[^?#]*(?:banner|payment|footer)',
    // (Optional) thumbnails (safe forms only)
    '(?:[\\/_.-]thumb(?:nail)?s?(?:[\\/_.-]|$))',
    // Reported vendor-specific offenders
    'imgcdn\\.mckesson\\.com\\/CumulusWeb\\/Images\\/Item_Detail\\/\\d+_ppkg(?:left|right|back)\\d*\\.jpg',
    'compasshealthbrands\\.com\\/media\\/images\\/items\\/noimage'
  ].join('|'), 'i');
  out.images = (out.images || [])
    .filter((o) => o && o.url && !badImg.test(o.url))
    .slice(0, 12);

  const badSpecKey = /\b(privacy|terms|copyright|©|™|®)\b/i;
  if (out.specs && typeof out.specs === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(out.specs)) {
      if (!k || badSpecKey.test(k)) continue;
      const val = String(v || '').trim();
      if (!val) continue;
      cleaned[k] = val;
    }
    out.specs = Object.keys(cleaned).length ? cleaned : deriveSpecsFromText(out.description_raw || '');
  }

  if (!out.description_raw || out.description_raw.length < 30) {
    const alt = firstGoodParagraphText(out.description_raw || '');
    if (alt) out.description_raw = alt;
  }
  return out;
}

/* ===== Helpers for sanitizer ===== */
function splitBenefitSentencesText(text) {
  return String(text)
    .split(/[\.\n•·–;-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 180);
}

function deriveSpecsFromText(text) {
  const out = {};
  String(text)
    .split(/\n+/)
    .map((s) => s.trim())
    .forEach((line) => {
      const m = line.match(/^([^:]{2,60}):\s*(.{2,300})$/);
      if (m) {
        const k = m[1].toLowerCase().replace(/\s+/g, '_');
        const v = m[2].trim();
        if (k && v && !out[k]) out[k] = v;
      }
    });
  return out;
}

function firstGoodParagraphText(text) {
  const paras = String(text)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 50);
  return paras[0] || '';
}

function dedupeList(arr) {
  const seen = new Set();
  return arr.filter(x => {
    const k=String(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ================== Compass-only helpers (ADD-ONLY) ================== */
function isCompass(u){
  try { return /(^|\.)compasshealthbrands\.com$/i.test(new URL(u).hostname); }
  catch { return false; }
}

function harvestCompassOverview($){
  const candPanels = $('.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, #tabs, .product-details, .product-detail');
  let best = "";
  candPanels.each((_, panel)=>{
    const $p = $(panel);
    const hasOverviewHeading = /\boverview\b/i.test(($p.find('h1,h2,h3,h4,h5').first().text() || "")) ||
                               /\boverview\b/i.test(($p.prev('a,button,[role="tab"]').text() || ""));
    const looksLikeOverview = hasOverviewHeading || ($p.find('ul li').length >= 3 && $p.find('p').length >= 1);
    if (!looksLikeOverview) return;

    const parts = [];
    const push = (t) => { t = cleanup(t); if (t) parts.push(t); };

    $p.find('p').each((__, el)=> push($(el).text()));
    $p.find('ul li, ol li').each((__, el)=>{
      const t = cleanup($(el).text());
      if (t && t.length <= 220) parts.push(`• ${t}`);
    });

    const merged = parts
      .map(s => s.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g,' ').trim())
      .filter(Boolean)
      .join('\n');

    if (merged.length > best.length) best = merged;
  });
  return best;
}

function harvestCompassSpecs($) {
  // look for specs in various pane-like containers
  const panels = $('.tab-content, .tabs-content, [role="tabpanel"], .product-details, .product-detail, section');
  const out = {};

  panels.each((_, panel) => {
    const $p = $(panel);
    const heading  = cleanup($p.find('h1,h2,h3,h4,h5').first().text());
    // also inspect the label of the preceding tab/button
    const tabLabel = cleanup($p.prev('a,button,[role="tab"]').first().text());
    const combined = `${heading} ${tabLabel}`;

    // only process panels that appear to contain technical specs
    if (!/\b(technical\s+specifications?|tech\s*specs?|specifications?)\b/i.test(combined)) return;

    // tables (<tr> rows with th/td)
    $p.find('tr').each((__, tr) => {
      const cells = $(tr).find('th,td');
      if (cells.length >= 2) {
        const k = cleanup($(cells[0]).text()).replace(/:$/, '');
        const v = cleanup($(cells[1]).text());
        if (k && v) {
          const key = k.toLowerCase().replace(/\s+/g, '_');
          if (!out[key]) out[key] = v;
        }
      }
    });

    // definition lists (<dl><dt>Key<dd>Value)
    $p.find('dl').each((__, dl) => {
      const dts = $(dl).find('dt'), dds = $(dl).find('dd');
      if (dts.length === dds.length && dts.length) {
        for (let i = 0; i < dts.length; i++) {
          const k = cleanup($(dts[i]).text()).toLowerCase().replace(/\s+/g, '_').replace(/:$/, '');
          const v = cleanup($(dds[i]).text());
          if (k && v && !out[k]) out[k] = v;
        }
      }
    });

    // colon-delimited list items (<li>Key: Value)
    $p.find('li').each((__, li) => {
      const t = cleanup($(li).text());
      const m = /^([^:]{2,60}):\s*(.{2,300})$/.exec(t);
      if (m) {
        const key = m[1].toLowerCase().replace(/\s+/g, '_');
        const val = m[2];
        if (key && val && !out[key]) out[key] = val;
      }
    });
  });

  return out;
}

/* ================== Listen ================== */
const PORT = process.env.PORT || 8080;

// Health endpoints (keep these near your routes)
app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

// --- bind exactly once (Render sets PORT) ---
if (process.env.NODE_ENV !== "test" && !global.__INGEST_LISTENING__) {
  const PORT = parseInt(process.env.PORT, 10) || 8080; // Render provides PORT (e.g., 10000)
  app.listen(PORT, () => {
    global.__INGEST_LISTENING__ = true;
    console.log(`ingest-api listening on :${PORT}`);
  });
}

export default app;
