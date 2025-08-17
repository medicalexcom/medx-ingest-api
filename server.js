/* medx-ingest-api/server.js */
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { URL } from "node:url";
import net from "node:net";

import {
  RENDER_API_URL, RENDER_API_TOKEN, MIN_IMG_PX_ENV, EXCLUDE_PNG_ENV,
  DEFAULT_RENDER_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS, MAX_HTML_BYTES,
  CACHE_TTL_MS, CACHE_MAX_ITEMS, ENABLE_CACHE, ENABLE_BASIC_SSRF_GUARD
} from "./src/config.js";

import {
  cid, now, sleep, safeDecodeOnce, cleanup, decodeHtml, isHttpUrl, safeHostname,
  isLikelyDangerousHost
} from "./src/utils.js";

import { cacheGet, cacheSet } from "./src/cache.js";
import { fetchWithRetry, fetchDirectHtml } from "./src/fetchers.js";
import { extractNormalized } from "./src/extract.js";
import { augmentFromTabs } from "./src/tabs.js";
import { isCompass, harvestCompassOverview, harvestCompassSpecs } from "./src/compass.js";
import { enrichSpecsWithDerived } from "./src/specs.js";
import { extractDescriptionMarkdown, textToMarkdown, objectToMarkdownTable } from "./src/markdown.js";

/* ================== App setup ================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/",  (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/* ================== Ingest route ================== */
/**
 * GET /ingest?url=<https://...>&selector=.css&wait=ms&timeout=ms&mode=fast|full
 * &minpx=200&excludepng=true&aggressive=true
 * &harvest=true&sanitize=true
 * &markdown=true
 * &debug=true
 * &mainonly=true
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
    const mode     = req.query.mode ? `&mode=${encodeURIComponent(String(req.query.mode))}` : "&mode=fast";

    const minImgPx   = Number.isFinite(parseInt(String(req.query.minpx),10)) ? parseInt(String(req.query.minpx),10) : MIN_IMG_PX_ENV;
    const excludePng = typeof req.query.excludepng !== "undefined"
      ? String(req.query.excludepng).toLowerCase() === "true"
      : EXCLUDE_PNG_ENV;

    const aggressive = String(req.query.aggressive || "false").toLowerCase() === "true";
    const doSanitize = String(req.query.sanitize  || "false").toLowerCase() === "true";
    const doHarvest  = String(req.query.harvest   || "false").toLowerCase() === "true";
    const wantMd     = String(req.query.markdown  || "false").toLowerCase() === "true";
    const mainOnly   = String(req.query.mainonly  || "false").toLowerCase() === "true";

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
    let norm = extractNormalized(targetUrl, html, { minImgPx, excludePng, aggressive, diag, mainOnly });
    diag.timings.extractMs = now() - t1;

    if (!norm.name_raw && (!norm.description_raw || norm.description_raw.length < 10)) {
      return res.status(422).json({ error: "No extractable product data (JSON-LD/DOM empty)." });
    }

    if (doHarvest) {
      const t2 = now();
      norm = await augmentFromTabs(norm, targetUrl, html, { minImgPx, excludePng, mainOnly });
      diag.timings.harvestMs = now() - t2;
    }

    // Compass-only additive harvest
    if (isCompass(targetUrl)) {
      const $ = cheerio.load(html);
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

    try { norm.specs = enrichSpecsWithDerived(norm.specs || {}); } catch {}

    if (wantMd) {
      const $ = cheerio.load(html);
      try { norm.description_md = extractDescriptionMarkdown($) || textToMarkdown(norm.description_raw || ""); }
      catch(e){ diag.warnings.push(`desc-md: ${e.message||e}`); }

      try { norm.features_md = (norm.features_raw || []).map(t => `- ${t}`).join("\n"); } catch(e){}
      try { norm.specs_md    = objectToMarkdownTable(norm.specs || {}); } catch(e){}
    }

    if (doSanitize) {
      const { sanitizeIngestPayload } = await import("./src/extract.js"); // exported there unchanged
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

/* ================== Listen ================== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));

/* env + knobs (unchanged behavior) */
export {
  RENDER_API_URL, RENDER_API_TOKEN, MIN_IMG_PX_ENV, EXCLUDE_PNG_ENV,
  DEFAULT_RENDER_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS, MAX_HTML_BYTES,
  CACHE_TTL_MS, CACHE_MAX_ITEMS, ENABLE_CACHE, ENABLE_BASIC_SSRF_GUARD
};

import net from "node:net";
import { URL } from "node:url";

/* Core small utils */
export function cid() { return (await import("node:crypto")).randomBytes(6).toString("hex"); }
export function now() { return Date.now(); }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function safeDecodeOnce(s){
  try {
    const decoded = decodeURIComponent(s);
    if (!decoded || /%[0-9A-Fa-f]{2}/.test(decoded)) return s;
    return decoded;
  } catch { return s; }
}

export function cleanup(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
export function decodeHtml(s){
  return s
    ? s.replace(/&amp;/g,'&')
         .replace(/&quot;/g,'"')
         .replace(/&#39;/g,"'")
         .replace(/&lt;/g,'<')
         .replace(/&gt;/g,'>')
    : s;
}

export function isHttpUrl(u){
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch { return false; }
}

export function safeHostname(u){
  try { return new URL(u).hostname; } catch { return ""; }
}

export function isIp(host){ return net.isIP(host) !== 0; }

export function isPrivateIp(ip){
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

export function isLikelyDangerousHost(host){
  const lower = String(host || "").toLowerCase();
  if (!lower) return true;
  if (lower === "localhost") return true;
  if (lower.endsWith(".local") || lower.endsWith(".localhost")) return true;
  if (isPrivateIp(lower)) return true;
  return false;
}

export function abs(base, link){
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

/* Domain/CDN helpers */
export function getRegistrableDomain(host) {
  try {
    const parts = String(host||"").toLowerCase().split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const twoPartTLD = new Set(["co.uk","org.uk","gov.uk","ac.uk","com.au","net.au","co.jp"]);
    const last2 = parts.slice(-2).join(".");
    const last3 = parts.slice(-3).join(".");
    return twoPartTLD.has(last2) ? last3 : last2;
  } catch { return String(host||"").toLowerCase(); }
}
export function isSameSiteOrCdn(baseUrl, otherUrl) {
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

/* Context helpers */
export function isMainProductNode($, el) {
  const $el = $(el);
  if (!$el || !$el.length) return false;
  if ($el.closest('[itemscope][itemtype*="Product" i]').length) return true;
  if ($el.closest('.product, .product-page, .product-detail, .product-details, #product, [id*="product" i]').length) return true;
  if ($el.closest('.product-media, .product__media, .product-gallery, #product-gallery, [data-gallery]').length) return true;
  return $el.closest('main,#main,.main,#content,.content,article').length > 0;
}
export function findMainProductScope($) {
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
export function scoreByContext($, node, { mainOnly=false } = {}) {
  if (isRecoBlock($, node) || isFooterOrNav($, node)) return -999;
  const inMain = isMainProductNode($, node);
  if (mainOnly) return inMain ? 2 : -999;
  return inMain ? 2 : 0;
}

/* Text helpers, guards, etc. */
export function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function documentQueryById($, id){
  try { return id ? $(`#${CSS.escape(id)}`)[0] : null; }
  catch { return id ? $(`#${id}`)[0] : null; }
}

export function inferBrandFromName(name){
  const first = (String(name||"").trim().split(/\s+/)[0] || "");
  if (/^(the|a|an|with|and|for|of|by|pro|basic)$/i.test(first)) return "";
  if (/^[A-Z][A-Za-z0-9\-]+$/.test(first)) return first;
  return "";
}

export function collectCodesFromUrl(url){
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

export function deepFindImagesFromJson(obj, out = []){
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
export function deepFindPdfsFromJson(obj, out = []){
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

export function firstGoodParagraph($){
  let best = "";
  $('main, #main, .main, .content, #content, body').first().find("p").each((_, p)=>{
    const t = cleanup($(p).text());
    if (t && t.length > best.length) best = t;
  });
  return best;
}

export const LEGAL_MENU_RE = /\b(privacy|terms|cookies?|trademark|copyright|©|™|®|newsletter|subscribe|sitemap|back\s*to\s*top|about|careers|press|blog|faq|support|returns?|shipping|track\s*order|store\s*locator|contact|account|login|sign\s*in)\b/i;

export function isFooterOrNav($, el){
  return $(el).closest(
    'footer, #footer, .footer, .site-footer, .page-footer, .global-footer, #global-footer,' +
    ' nav, .nav, .navbar, [role="navigation"], [role="contentinfo"],' +
    ' [aria-label*="footer" i], [aria-label*="breadcrumb" i], .breadcrumbs,' +
    ' .legal, .legalese, .bottom-bar, .cookie, .consent, .newsletter, .subscribe, .sitemap'
  ).length > 0;
}
export function isRecoBlock($, el){
  if ($(el).closest(
    '.related, .related-products, #related-products, ' +
    '.upsell, .cross-sell, .crosssell, .you-may-also-like, ' +
    '.recommended, .recommendations, .product-recommendations, .product-recs, [data-recommendations], ' +
    '.frequently-bought, .frequently-bought-together, .fbt, ' +
    '.also-viewed, .people-also-viewed, .also-bought, .customers-also-bought, ' +
    '.similar-products, .more-like-this, [data-related-products], [data-upsell]'
  ).length > 0) return true;
  if ($(el).closest('.recommendation, .co-viewed, [data-br-request-type="recommendation"]').length > 0) return true;
  return false;
}

export function splitIntoSentences(text){
  return String(text)
    .replace(/\s*\n\s*/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(0-9])|[•·–\-]\s+|;\s+|·\s+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

export function mergeDescriptions(a, b){
  const seen = new Set();
  const lines = (String(a||"") + "\n" + String(b||""))
    .split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const out = [];
  for (const l of lines){
    const k=l.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  return out.join("\n");
}

export function toTitleCase(s) { return String(s).replace(/\b([a-z])/g, (m, c) => c.toUpperCase()); }
export function dedupeList(arr) {
  const seen = new Set();
  return arr.filter(x => {
    const k=String(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

import { ENABLE_CACHE, CACHE_MAX_ITEMS, CACHE_TTL_MS } from "./config.js";
import { now } from "./utils.js";

/* HTML cache (TTL + naive LRU), behavior unchanged */
const htmlCache = new Map(); // key -> { html, expires, last }

export function cacheGet(key){
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

export function cacheSet(key, html){
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

import { DEFAULT_RENDER_TIMEOUT_MS, MAX_HTML_BYTES } from "./config.js";

export async function fetchWithRetry(endpoint, { headers, attempts=3, timeoutMs=DEFAULT_RENDER_TIMEOUT_MS, initialBackoff=600 }) {
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
      await new Promise(r => setTimeout(r, delay + jitter));
    }
  }
  const err = new Error(`Render API failed: status=${lastStatus} body=${String(lastBody).slice(0,280)}`);
  err.status = lastStatus;
  throw err;
}

export async function fetchDirectHtml(url, { headers={}, timeoutMs=DEFAULT_RENDER_TIMEOUT_MS } = {}) {
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

import { cleanup } from "./utils.js";

export function schemaPropsToSpecs(props){
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

export function extractJsonLd($){
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

  const specs = schemaPropsToSpecs(
    p.additionalProperty || p.additionalProperties || (p.additionalType === "PropertyValue" ? [p] : [])
  );

  const features = Array.isArray(p.featureList) ? p.featureList : [];

  const addKV = {};
  ["sku","mpn","gtin13","gtin14","gtin12","gtin8","productID","color","size","material","model","category"]
    .forEach(k => { if (p[k]) addKV[k] = String(p[k]); });

  const offer = Array.isArray(p.offers) ? p.offers[0] : (p.offers || {});
  if (offer && (offer.price || offer.priceCurrency)) {
    if (offer.priceCurrency) addKV["price_currency"] = String(offer.priceCurrency);
    if (offer.price)         addKV["price"] = String(offer.price);
    if (offer.availability)  addKV["availability"] = String(offer.availability).split('/').pop();
  }

  return {
    name: p.name || '',
    description: p.description || '',
    brand: (p.brand && (p.brand.name || p.brand)) || '',
    specs: { ...specs, ...addKV },
    features,
    images
  };
}

export function extractMicrodataProduct($){
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
    const price = offers.find('[itemprop="price"]').attr("content") || offers.find('[itemprop="price"]').text();
    const cur   = offers.find('[itemprop="priceCurrency"]').attr("content") || offers.find('[itemprop="priceCurrency"]').text();
    if (price) out.specs["price"] = cleanup(price);
    if (cur)   out.specs["price_currency"] = cleanup(cur);
    const avail= offers.find('[itemprop="availability"]').attr("href") || offers.find('[itemprop="availability"]').text();
    if (avail) out.specs["availability"] = cleanup(String(avail).split('/').pop());
  }

  $prod.find('[itemprop="image"]').each((_, el)=>{
    const $el = $(el);
    const src = $el.is("meta") ? $el.attr("content") : ($el.attr("src") || $el.attr("data-src"));
    if (src) out.images.push(src);
  });

  return out;
}

export function extractRdfaProduct($){
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

  const price = getProp("price");
  const cur   = getProp("priceCurrency");
  if (price) out.specs["price"] = price;
  if (cur)   out.specs["price_currency"] = cur;

  $prod.find('[property="image"]').each((_, el)=>{
    const $el = $(el);
    const src = $el.is("meta") ? $el.attr("content") : ($el.attr("src") || $el.attr("data-src"));
    if (src) out.images.push(src);
  });

  return out;
}

export function extractOgProductMeta($){
  const out = {};
  $('meta[property^="product:"]').each((_, el)=>{
    const p = String($(el).attr("property") || "");
    const v = String($(el).attr("content")  || "");
    if (!p || !v) return;
    const key = p.replace(/^product:/,'').replace(/:/g,'_');
    out[key] = v;
  });
  return out;
}

export function mergeProductSD(a={}, b={}, c={}){
  const pick = (x,y)=> x && String(x).trim() ? x : y;
  const name        = pick(a.name,        pick(b.name,        c.name));
  const description = pick(a.description, pick(b.description, c.description));
  const brand       = pick(a.brand,       pick(b.brand,       c.brand));
  const images = [...new Set([...(a.images||[]), ...(b.images||[]), ...(c.images||[])])];
  const specs  = { ...(c.specs || {}), ...(b.specs || {}), ...(a.specs || {}) };

  const feats  = [];
  const seen   = new Set();
  [ ...(a.features||[]), ...(b.features||[]), ...(c.features||[]) ].forEach(t=>{
    const k = String(t||"").toLowerCase();
    if (k && !seen.has(k)){ seen.add(k); feats.push(t); }
  });

  return { name, description, brand, images, specs, features: feats };
}

import * as cheerio from "cheerio";
import {
  MIN_IMG_PX_ENV, EXCLUDE_PNG_ENV
} from "./config.js";
import {
  abs, decodeHtml, isFooterOrNav, isRecoBlock, isMainProductNode, findMainProductScope,
  scoreByContext, collectCodesFromUrl, deepFindImagesFromJson, getRegistrableDomain, isSameSiteOrCdn
} from "./utils.js";

/* helpers used within images */
export function pickLargestFromSrcset(srcset) {
  if (!srcset) return "";
  try {
    const parts = String(srcset)
      .split(",").map(s => s.trim()).filter(Boolean)
      .map(s => {
        const [u, d] = s.split(/\s+/);
        const n = d && /\d+/.test(d) ? parseInt(d, 10) : 0;
        return { u, n };
      });
    if (!parts.length) return "";
    parts.sort((a, b) => b.n - a.n);
    return parts[0].u || parts[0];
  } catch {
    return String(srcset).split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean)[0] || "";
  }
}
export function inferSizeFromUrl(u) {
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

function keyForImageDedup(url) {
  const u = String(url||"");
  const base = u.split("/").pop().split("?")[0];
  const size = (u.match(/(\d{2,5})x(\d{2,5})/) || []).slice(1).join("x");
  return size ? `${base}#${size}` : base;
}
export function dedupeImageObjs(cands, limit = 12) {
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

/* primary image extractor (unchanged behavior) */
export function extractImages($, structured, og, baseUrl, name, rawHtml, opts){
  const minPx     = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng= (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const aggressive= !!(opts && opts.aggressive);

  const set = new Set();
  const imgWeights = new Map();

  const imgContext = new Map(); // url -> { inReco: bool, inMain: bool }
  const markCtx = (absu, ctx) => {
    const prev = imgContext.get(absu) || { inReco:false, inMain:false };
    imgContext.set(absu, { inReco: prev.inReco || !!ctx.inReco, inMain: prev.inMain || !!ctx.inMain });
  };

  const push = (u, weight = 0, ctx = null) => {
    if (!u) return;
    const absu = abs(baseUrl, u);
    if (!absu) return;
    if (!imgWeights.has(absu)) imgWeights.set(absu, 0);
    imgWeights.set(absu, Math.max(imgWeights.get(absu), weight));
    if (ctx) markCtx(absu, ctx);
    set.add(absu);
  };

  (structured.images || []).forEach(u => push(u, 8, { inMain: true }));

  const gallerySelectors = [
    '.product-media','.product__media','.product-gallery','.gallery','.media-gallery','#product-gallery','#gallery','[data-gallery]',
    '.product-images','.product-image-gallery','.pdp-gallery','.slick-slider','.slick','.swiper','.swiper-container','.carousel',
    '.owl-carousel','.fotorama','.MagicZoom','.cloudzoom-zoom','.zoomWindow','.zoomContainer','.lightbox','.thumbnails'
  ].join(', ');
  $(gallerySelectors).find('img, source').each((_, el) => {
    if (isRecoBlock($, el)) return;
    const $el = $(el);
    const cands = [
      $el.attr('src'), $el.attr('data-src'), $el.attr('data-srcset'),
      $el.attr('data-original'), $el.attr('data-large_image'), $el.attr('data-image'),
      $el.attr('data-zoom'), pickLargestFromSrcset($el.attr('srcset')),
    ];
    cands.forEach(u => push(u, 6, { inReco:false, inMain: isMainProductNode($, el) }));
  });

  if (og.image) push(og.image, 3, { inMain: true });

  $("img").each((_, el) => {
    if (isRecoBlock($, el)) return;
    const $el = $(el);
    const cands = [
      $el.attr("src"), $el.attr("data-src"), $el.attr("data-srcset"),
      $el.attr("data-original"), $el.attr("data-lazy"), $el.attr("data-zoom-image"),
      $el.attr("data-large_image"), $el.attr("data-image"),
      pickLargestFromSrcset($el.attr("srcset")),
    ];
    cands.forEach(u => push(u, 2, { inReco:false, inMain: isMainProductNode($, el) }));
  });

  $("noscript").each((_, n)=>{
    if (isRecoBlock($, n)) return;
    const inner = $(n).html() || "";
    const _$ = cheerio.load(inner);
    _$("img").each((__, el)=>{
      const src = _$(el).attr("src") || _$(el).attr("data-src") || pickLargestFromSrcset(_$(el).attr("srcset"));
      if (src) push(src, 3, { inReco:false, inMain: isMainProductNode($, n) });
    });
  });

  $("picture source[srcset]").each((_, el) => {
    if (isRecoBlock($, el)) return;
    push(pickLargestFromSrcset($(el).attr("srcset")), 2, { inReco:false, inMain: isMainProductNode($, el) });
  });

  $('[style*="background"]').each((_, el) => {
    if (isRecoBlock($, el)) return;
    const style = String($(el).attr("style") || "");
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(m[2], 2, { inReco:false, inMain: isMainProductNode($, el) });
  });

  $('link[rel="image_src"]').each((_, el) => push($(el).attr("href"), 1, { inMain: true }));

  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!txt || !/\.(?:jpe?g|png|webp)\b/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      deepFindImagesFromJson(obj).forEach(u => push(u, 2, { inMain: true }));
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) push(m[1], 1, { inMain: true });
    }
  });

  if (rawHtml) {
    const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m; while ((m = re.exec(rawHtml))) push(m[1], 0);
  }

  let arr = Array.from(set).filter(Boolean).map(u => decodeHtml(u));

  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
  const host = (new URL(baseUrl)).hostname;
  const allowHostRe = new RegExp([
    host.includes("drivemedical")        ? "/medias|/products|/pdp|/images/products|/product-images|/commerce/products|/uploads" : "",
    host.includes("mckesson")            ? "/product|/images|/product-images|/assets/product" : "",
    host.includes("compasshealthbrands") ? "/media/images/items|/product|/images" : "",
    host.includes("motifmedical")        ? "/wp-content/uploads|/product|/images" : ""
  ].filter(Boolean).join("|"), "i");

  const badReBase = [
    'logo','brandmark','favicon','sprite','placeholder','no-?image','missingimage','loader',
    'coming[-_]?soon','image[-_]?coming[-_]?soon','awaiting','spacer','blank','default','dummy','sample','temp',
    'spinner','icon','badge','flag','cart','arrow','pdf','facebook','twitter','instagram','linkedin',
    '\\/wcm\\/connect','/common/images/','/icons/','/social/','/share/','/static/','/cms/','/ui/','/theme/','/wp-content/themes/'
  ];
  if (!aggressive) badReBase.push('/search/','/category/','/collections/','/filters?');
  const badRe = new RegExp(badReBase.join('|'), 'i');

  arr = arr
    .filter(u => allowWebExt.test(u))
    .filter(u => !badRe.test(u))
    .filter(u => !allowHostRe.source.length || allowHostRe.test(u) || aggressive)
    .filter(u => {
      const { w, h } = inferSizeFromUrl(u);
      if (!w && !h) return true;
      return Math.max(w || 0, h || 0) >= minPx;
    });

  const titleTokens   = (name || "").toLowerCase().split(/\s+/).filter(Boolean);
  const codeCandidates= collectCodesFromUrl(baseUrl);
  const preferRe = /(\/media\/images\/items\/|\/images\/(products?|catalog)\/|\/uploads\/|\/products?\/|\/product\/|\/pdp\/|\/assets\/product|\/product-images?\/|\/commerce\/products?\/|\/zoom\/|\/large\/|\/hi-res?\/|\/wp-content\/uploads\/)/i;

  const scored = arr.map(u => {
    const L = u.toLowerCase();
    let score = imgWeights.get(u) || 0;
    if (preferRe.test(L)) score += 3;
    if (allowHostRe.source.length && allowHostRe.test(L)) score += 2;
    if (codeCandidates.some(c => c && L.includes(c))) score += 3;
    if (titleTokens.some(t => t.length > 2 && L.includes(t))) score += 1;
    if (/thumb|thumbnail|small|tiny|badge|mini|icon|swatch/.test(L)) score -= 3;
    if (/(_\d{3,}x\d{3,}|-?\d{3,}x\d{3,}|(\?|&)(w|width|h|height|size)=\d{3,})/.test(L)) score += 1;

    const ctx = imgContext.get(u) || {};
    if (ctx.inReco) score -= 5;
    if (ctx.inMain) score += 3;

    return { url: u, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const out  = [];
  for (const s of scored) {
    const base = s.url.split("/").pop().split("?")[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url: s.url });
    if (out.length >= 12) break;
  }
  return out;
}

/* Enhanced image harvester */
export function extractImagesPlus($, structured, og, baseUrl, name, rawHtml, opts) {
  const minPx     = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng= (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const mainOnly  = !!(opts && (opts.mainOnly || opts.mainonly));
  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;

  const scope = findMainProductScope($);
  const set = new Map(); // url -> score

  const push = (node, url, baseScore = 0) => {
    if (!url) return;
    const u = decodeHtml(abs(baseUrl, url));
    if (!u || !allowWebExt.test(u)) return;
    if (!isSameSiteOrCdn(baseUrl, u)) return;
    const ctx = scoreByContext($, node, { mainOnly });
    if (ctx <= -999) return;
    const cur = set.get(u) || 0;
    set.set(u, Math.max(cur, baseScore + ctx));
  };

  scope.find('.product-media, .product__media, .product-gallery, #product-gallery, [data-gallery], .slick, .swiper, .carousel, .fotorama')
    .find('img, source').each((_, el) => {
      const $el = $(el);
      const cands = [
        $el.attr('src'), $el.attr('data-src'), $el.attr('data-original'), $el.attr('data-zoom'),
        $el.attr('data-zoom-image'), $el.attr('data-image'), $el.attr('data-large_image'),
        pickLargestFromSrcset($el.attr('srcset'))
      ];
      cands.forEach(u => push(el, u, 6));
    });

  $('link[rel="preload"][as="image"]').each((_, el) => push(el, $(el).attr('href'), 3));
  const tw = $('meta[name="twitter:image"]').attr('content'); if (tw) push($.root(), tw, 2);

  scope.find('img, source, picture source').each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr('src'), $el.attr('data-src'), $el.attr('data-lazy'),
      $el.attr('data-original'), $el.attr('data-image'),
      $el.attr('data-zoom-image'), pickLargestFromSrcset($el.attr('srcset'))
    ];
    cands.forEach(u => push(el, u, 3));
  });

  scope.find('[style*="background"]').each((_, el) => {
    const style = String($(el).attr('style') || '');
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(el, m[2], 2);
  });

  const titleTokens = (name||"").toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const codes = collectCodesFromUrl(baseUrl);
  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!/\.(?:jpe?g|png|webp)\b/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      const arr = deepFindImagesFromJson(obj, []);
      for (const u of arr) {
        const L = String(u||'').toLowerCase();
        const hit = (codes.some(c => L.includes(c)) ? 2 : 0) + (titleTokens.some(t => L.includes(t)) ? 1 : 0);
        push(el, u, hit ? 3 + hit : 1);
      }
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) push(el, m[1], 1);
    }
  });

  const scored = Array.from(set.entries())
    .filter(([u]) => {
      const { w, h } = inferSizeFromUrl(u);
      if (!w && !h) return true;
      return Math.max(w||0, h||0) >= minPx;
    })
    .map(([url, score]) => ({ url, score }))
    .sort((a, b) => b.score - a.score);

  return dedupeImageObjs(scored, 12);
}

export function fallbackImagesFromMain($, baseUrl, og, opts){
  const minPx     = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng= (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
  const badRe = /(logo|favicon|sprite|placeholder|no-?image|missingimage|icon|social|facebook|twitter|instagram|linkedin|\/common\/images\/|\/icons\/|\/wp-content\/themes\/)/i;

  const set = new Set();
  const push = u => { if (u) set.add(abs(baseUrl, u)); };

  $('main, #main, .main, article, .product, .product-detail, .product-details').first().find('img').each((_, el)=>{
    push($(el).attr('src'));
    push($(el).attr('data-src'));
    push(pickLargestFromSrcset($(el).attr('srcset')));
  });

  $('main, #main, .main, article').first().find('noscript').each((_, n)=>{
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

/* images-in-panes filter used by tabs */
export function filterAndRankExtraPaneImages(urls, baseUrl, opts){
  const { inferSizeFromUrl } = await import("./images.js"); // circular-safe
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

import {
  abs, cleanup, deepFindPdfsFromJson, collectCodesFromUrl
} from "./utils.js";

export function dedupeManualUrls(urls) {
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

export function extractManuals($, baseUrl, name, rawHtml, opts){
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

export function extractManualsPlus($, baseUrl, name, rawHtml, opts) {
  const mainOnly = !!(opts && (opts.mainOnly || opts.mainonly));
  const urls = new Map(); // url -> score
  const allowRe = /(manual|ifu|instruction|instructions|user[- ]?guide|owner[- ]?manual|assembly|install|installation|setup|quick[- ]?start|spec(?:sheet)?|datasheet|guide|brochure)/i;
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;

  const { scoreByContext } = await import("./utils.js");

  const push = (node, url, baseScore = 0) => {
    if (!url) return;
    const u = abs(baseUrl, url);
    if (!u) return;
    const L = u.toLowerCase();
    const ctx = scoreByContext($, node, { mainOnly });
    if (ctx <= -999) return;
    if (!/\.pdf(?:[?#].*)?$/i.test(u) && !/document|view|download|asset|file/i.test(L)) return;
    if (blockRe.test(L)) return;
    const cur = urls.get(u) || 0;
    urls.set(u, Math.max(cur, baseScore + ctx));
  };

  const scope = (await import("./utils.js")).findMainProductScope($);

  scope.find('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || $el.attr('data-href') || $el.attr('data-url') || $el.attr('data-file');
    const t = ($el.text() || $el.attr('aria-label') || '').toLowerCase();
    if (href && (allowRe.test(t) || /\.pdf(?:[?#].*)?$/i.test(href))) push(el, href, 4);
  });

  $('a[onclick], button[onclick]').each((_, el) => {
    const s = String($(el).attr('onclick') || '');
    const m = s.match(/https?:\/\/[^\s"'<>]+?\.pdf(?:\?[^"'<>]*)?/i);
    if (m) push(el, m[0], 3);
  });

  $('object[type="application/pdf"], embed[type="application/pdf"], iframe[src*=".pdf"]').each((_, el) => {
    const $el = $(el);
    push(el, $el.attr('data') || $el.attr('src') || '', 5);
  });

  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!/\.(pdf)\b/i.test(txt) && !/documents?|downloads?|resources?/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      const arr = (await import("./utils.js")).deepFindPdfsFromJson(obj, []);
      for (const u of arr) {
        const L = String(u||'').toLowerCase();
        if (allowRe.test(L) && !blockRe.test(L)) push(el, u, 3);
      }
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.pdf)(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) push(el, m[1], 2);
    }
  });

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

export function fallbackManualsFromPaths($, baseUrl, name, rawHtml){
  const out = new Set();
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;
  const pathHint= /(manual|ifu|document|documents|download|downloads|resources|instructions?|user[- ]?guide|datasheet|spec|sheet|brochure)/i;
  const host = (new URL(baseUrl)).hostname;

  $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href=String($(el).attr("href")||"");
    const full=abs(baseUrl, href);
    if (!full) return;
    if ((new URL(full)).hostname !== host) return;
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

import { cleanup, LEGAL_MENU_RE, isFooterOrNav, isRecoBlock } from "./utils.js";

/* Canonicalization & enrichment */
export const SPEC_SYNONYMS = new Map([
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

  ["weight capacity", "weight_capacity"],
  ["max weight", "weight_capacity"],
  ["maximum weight", "weight_capacity"],
  ["capacity", "weight_capacity"],
  ["user weight capacity", "weight_capacity"],
  ["product weight", "product_weight"],
  ["unit weight", "product_weight"],
  ["shipping weight", "shipping_weight"],
  ["packaged weight", "shipping_weight"],

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

export function canonicalizeSpecKey(k = "") {
  const base = String(k).trim().replace(/\s+/g, " ");
  const lower = base.toLowerCase();
  if (SPEC_SYNONYMS.has(lower)) return SPEC_SYNONYMS.get(lower);
  return lower
    .replace(/[^\p{L}\p{N}\s/.-]+/gu, "")
    .replace(/\//g, "_")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeUnitsInText(v = "") {
  return String(v)
    .replace(/(\d)\s*["”]/g, "$1 in")
    .replace(/(\d)\s*[\'’]/g, "$1 ft")
    .replace(/\b(pounds?|lbs?)\b/gi, "lb")
    .replace(/\b(ounces?)\b/gi, "oz")
    .replace(/\b(millimet(er|re)s?)\b/gi, "mm")
    .replace(/\b(centimet(er|re)s?)\b/gi, "cm")
    .replace(/\b(kilograms?)\b/gi, "kg")
    .replace(/\b(grams?)\b/gi, "g")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseDimensionsBlock(v = "") {
  const t = normalizeUnitsInText(v).toLowerCase();
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

export function enrichSpecsWithDerived(specs = {}) {
  const out = { ...specs };
  const candidates = [ "overall_dimensions", "dimensions", "overall_size" ];
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

export function mergeSpecsAdditive(primary = {}, secondary = {}) {
  const merged = { ...secondary, ...primary };
  return enrichSpecsWithDerived(merged);
}

/* ----- embedded JSON plucking ----- */
export function pluckJsonObjectsFromJs(txt, maxBlocks = 3) {
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
    return start;
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

/* scripts → specs */
export function extractSpecsFromScripts($, container /* optional */) {
  const scope = container ? $(container) : $;
  if (container && (isFooterOrNav($, container) || isRecoBlock($, container))) return {};

  const out = {};
  const RECO_PATH_RE = /(related|recommend|upsell|cross|also(view|bought)|similar|fbt|suggest)/i;

  const pushKV = (name, value) => {
    const k = canonicalizeSpecKey(name);
    const v = cleanup(String(value || ""));
    if (!k || !v) return;
    if (!out[k]) out[k] = v;
  };

  const visit = (node, path = "") => {
    if (node == null) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], `${path}[${i}]`);
      return;
    }
    if (typeof node === "object") {
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

      if (node.product && (node.product.attributes || node.product.custom_fields)) {
        visit(node.product.attributes || [], `${path}.product.attributes`);
        visit(node.product.custom_fields || [], `${path}.product.custom_fields`);
      }

      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
    }
  };

  scope.find('script[type="application/json"], script[type="application/ld+json"]').each((_, el) => {
    if (isRecoBlock($, el)) return;
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    try { visit(JSON.parse(raw.trim()), "$"); } catch {}
  });

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

/* JSON-LD all product specs (filtered to page) */
export function extractJsonLdAllProductSpecs($){
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

/* global K:V sweep */
export function extractAllSpecPairs($){
  const out = {};

  $('table').each((_, tbl)=>{
    if (isFooterOrNav($, tbl) || isRecoBlock($, tbl) || isPartsOrAccessoryTable($, tbl)) return;
    let hits = 0;
    const local = {};
    $(tbl).find('tr').each((__, tr)=>{
      const cells = $(tr).find('th,td');
      if (cells.length >= 2) {
        const k = cleanup($(cells[0]).text());
        const v = cleanup($(cells[1]).text()));
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) return;
        if (k.length <= 80 && v.length <= 400) {
          local[canonicalizeSpecKey(k)] = v;
          hits++;
        }
      }
    });
    if (hits >= 3) Object.assign(out, local);
  });

  $('dl').each((_, dl)=>{
    if (isFooterOrNav($, dl) || isRecoBlock($, dl)) return;
    const dts=$(dl).find('dt'), dds=$(dl).find('dd');
    if (dts.length === dds.length && dts.length >= 3){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text());
        const v=cleanup($(dds[i]).text());
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) continue;
        out[canonicalizeSpecKey(k)] = v;
      }
    }
  });

  $('main, #main, .main, .content, #content, .product, .product-details, .product-detail').find('li,p').each((_, el)=>{
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
    const t = cleanup($(el).text());
    if (!t || LEGAL_MENU_RE.test(t)) return;
    const m = t.match(/^([^:–—-]{2,60})[:–—-]\s*(.{2,300})$/);
    if (m) out[canonicalizeSpecKey(m[1])] ||= m[2];
  });

  const norm = {};
  for (const [k,v] of Object.entries(out)) norm[k] = normalizeUnitsInText(v);
  return enrichSpecsWithDerived(norm);
}

/* smart specs (scoped → dense → global) */
export function extractSpecsSmart($){
  let specPane = (await import("./tabs.js")).resolveTabPane($, [
    'technical specifications','technical specification',
    'tech specs','specifications','specification','details'
  ]);
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
  $('table').each((_, tbl)=>{
    if (isFooterOrNav($, tbl) || isRecoBlock($, tbl) || isPartsOrAccessoryTable($, tbl)) return;
    $(tbl).find('tr').each((__, tr)=>{
      const cells=$(tr).find('th,td');
      if (cells.length>=2){
        const k=cleanup($(cells[0]).text());
        const v=cleanup($(cells[1]).text());
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) return;
        const kk = k.toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        if (kk && v && kk.length<80 && v.length<400) out[kk]=v;
      }
    });
  });

  $('dl').each((_, dl)=>{
    if (isFooterOrNav($, dl) || isRecoBlock($, dl)) return;
    const dts=$(dl).find('dt'), dds=$(dl).find('dd');
    if (dts.length === dds.length && dts.length){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text());
        const v=cleanup($(dds[i]).text());
        if (!k || !v || LEGAL_MENU_RE.test(k) || LEGAL_MENU_RE.test(v)) continue;
        const kk = k.toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        if (kk && v && kk.length<80 && v.length<400) out[kk]=v;
      }
    }
  });

  $('li').each((_, li)=>{
    if (isFooterOrNav($, li) || isRecoBlock($, li)) return;
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

export function extractSpecsFromDensestBlock($){
  const candidates = [
    '[role="tabpanel"]','.tab-pane','.tabs-content > *','.accordion-content','.product-tabs *',
    '.tab-content *','section','.panel','.panel-body','.content'
  ].join(', ');
  let bestEl = null, bestScore = 0;

  $(candidates).each((_, el)=>{
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
    const $el = $(el);
    let score = 0;

    $el.find('tr').each((__, tr)=>{
      const cells=$(tr).find('th,td');
      if (cells.length>=2){
        const k = cleanup($(cells[0]).text());
        const v = cleanup($(cells[1]).text()));
        if (k && v && /:|back|warranty|weight|capacity|handles|depth|height/i.test(k)) score++;
      }
    });

    const dts = $el.find('dt').length;
    const dds = $el.find('dd').length;
    if (dts && dds && dts === dds) score += Math.min(dts, 12);

    $el.find('li').each((__, li)=>{
      const t = cleanup($(li).text()));
      if (/^[^:]{2,60}:\s+.{2,300}$/.test(t)) score++;
    });

    if (score > bestScore) { bestScore = score; bestEl = el; }
  });

  return bestEl ? extractSpecsFromContainer($, bestEl) : {};
}

export function deriveSpecsFromParagraphs($){
  const out = {};
  $('main, #main, .main, .product, .product-detail, .product-details, .product__info, .content, #content')
    .find('p, li').each((_, el)=>{
      if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
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

/* container parsers shared with tabs */
export function extractSpecsFromContainer($, container){
  if (isFooterOrNav($, container) || isRecoBlock($, container)) return {};
  const out = {};
  const $c = $(container);

  $c.find('table').each((_, tbl)=>{
    if (isPartsOrAccessoryTable($, tbl)) return;
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
    const b = cleanup($(r).find('.value, .val, .data, td, span, p').last().text());
    if (a && b) out[a.toLowerCase().replace(/\s+/g,'_').replace(/:$/,'')] = b;
  });

  return out;
}

/* parts/accessories detection + pruning */
export const PARTS_HEADER_RE = /\b(no\.?|part(?:\s*no\.?)?|item(?:\s*description)?|qty(?:\s*req\.)?|quantity|price)\b/i;

export function isPartsOrAccessoryTable($, tbl){
  try {
    const header = $(tbl).find('tr').first().find('th,td')
      .map((_,c)=>cleanup($(c).text())).get().join(' | ');
    if (PARTS_HEADER_RE.test(header)) return true;

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

export function prunePartsLikeSpecs(specs = {}){
  const out = {};
  const BAD_KEYS = /^(no\.?|item(?:_)?description|qty(?:_?req\.?)?|quantity|price|part(?:_)?no\.?)$/i;
  for (const [k, v] of Object.entries(specs || {})) {
    const key = String(k || "").trim();
    const val = String(v || "").trim();
    if (!key || !val) continue;
    if (/^\d+$/.test(key)) continue;
    if (BAD_KEYS.test(key)) continue;
    out[key] = val;
  }
  return out;
}

import { cleanup, LEGAL_MENU_RE, isFooterOrNav, isRecoBlock, splitIntoSentences } from "./utils.js";

export function extractFeaturesSmart($){
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

  const { resolveTabPane } = await import("./tabs.js");
  const featPane = resolveTabPane($, ['feature','features','features/benefits','benefits','key features','highlights']);
  if (featPane){
    const $c = $(featPane);
    $c.find('li').each((_, li)=> pushIfGood($(li).text()));
    $c.find('h3,h4,h5').each((_, h)=> pushIfGood($(h).text()));
  }

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

export function deriveFeaturesFromParagraphs($){
  const out = [];
  const pushIfGood = (txt) => {
    const t = cleanup(txt);
    if (!t) return;
    if (t.length < 7 || t.length > 220) return;
    if (/>|›|»/.test(t)) return;
    if (/\b(privacy|terms|trademark|copyright|newsletter|subscribe)\b/i.test(t)) return;
    if (/(https?:\/\/|www\.)/i.test(t)) return;
    out.push(t);
  };

  $('main, #main, .main, .product, .product-detail, .product-details, .product__info, .content, #content')
    .find('p').each((_, p)=>{
      if (isFooterOrNav($, p) || isRecoBlock($, p)) return;
      const raw = cleanup($(p).text());
      if (!raw) return;
      splitIntoSentences(raw).forEach(pushIfGood);
    });

  const seen=new Set();
  const uniq=[];
  for (const t of out){
    const k=t.toLowerCase();
    if (!seen.has(k)){
      seen.add(k);
      uniq.push(t);
      if (uniq.length>=12) break;
    }
  }
  return uniq;
}

import { cleanup, LEGAL_MENU_RE, isFooterOrNav, isRecoBlock, toTitleCase } from "./utils.js";

/* container → text */
export function extractDescriptionFromContainer($, container){
  const $c = $(container);
  const parts = [];
  const push = (t) => {
    t = cleanup(t);
    if (!t) return;
    if (/^\s*(share|subscribe|privacy|terms|trademark|copyright)\b/i.test(t)) return;
    parts.push(t);
  };

  $c.find('h1,h2,h3,h4,h5,strong,b,.lead,.intro').each((_, n)=> push($(n).text()));
  $c.find('p, .copy, .text, .rte, .wysiwyg, .content-block').each((_, p)=> push($(p).text()));

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

export function extractDescriptionMarkdown($){
  const candidates = [
    '[itemprop="description"]',
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description, .overview, .product-overview, .intro, .summary',
    '.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-tabs'
  ].join(', ');

  let bestEl = null, bestLen = 0;
  $(candidates).each((_, el)=>{
    if (isFooterOrNav($, el) || isRecoBlock($, el)) return;
    const textCheck = cleanup($(el).text());
    if (LEGAL_MENU_RE.test(textCheck) || /^©\s?\d{4}/.test(textCheck)) return;

    const text = textCheck;
    if (text && text.length > bestLen) { bestLen = text.length; bestEl = el; }
  });
  if (!bestEl) return "";

  const raw = extractDescriptionFromContainer($, bestEl);
  return containerTextToMarkdown(raw);
}

export function containerTextToMarkdown(s){
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

export function textToMarkdown(t){
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

export function objectToMarkdownTable(obj){
  const entries = Object.entries(obj || {});
  if (!entries.length) return "";
  const rows = entries.map(([k,v]) => `| ${toTitleCase(k.replace(/_/g,' '))} | ${String(v).replace(/\n+/g, ' ').trim()} |`);
  return ["| Spec | Value |","|---|---|",...rows].join("\n");
}

import { cleanup } from "./utils.js";

export function isCompass(u){
  try { return /(^|\.)compasshealthbrands\.com$/i.test(new URL(u).hostname); }
  catch { return false; }
}

export function harvestCompassOverview($){
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

export function harvestCompassSpecs($){
  const panels = $('.tab-content, .tabs-content, [role="tabpanel"], .product-details, .product-detail, section');
  const out = {};
  panels.each((_, panel)=>{
    const $p = $(panel);
    const heading = cleanup($p.find('h1,h2,h3,h4,h5').first().text());
    if (!/technical\s+specifications?/i.test(heading)) return;

    $p.find('tr').each((__, tr)=>{
      const cells = $(tr).find('th,td');
      if (cells.length >= 2){
        const k = cleanup($(cells[0]).text()).replace(/:$/, '');
        const v = cleanup($(cells[1]).text());
        if (k && v) out[k.toLowerCase().replace(/\s+/g,'_')] ||= v;
      }
    });

    $p.find('li').each((__, li)=>{
      const t = cleanup($(li).text()));
      const m = /^([^:]{2,60}):\s*(.{2,300})$/.exec(t);
      if (m){
        const k = m[1].toLowerCase().replace(/\s+/g,'_');
        const v = m[2];
        if (k && v) out[k] ||= v;
      }
    });
  });
  return out;
}

import * as cheerio from "cheerio";
import { RENDER_API_URL, RENDER_API_TOKEN } from "./config.js";
import {
  cleanup, escapeRe, documentQueryById, abs, isFooterOrNav, isRecoBlock
} from "./utils.js";
import { extractSpecsFromContainer } from "./specs.js";
import { filterAndRankExtraPaneImages } from "./images.js";
import { collectManualsFromContainer } from "./tabs_support.js"; // defined below in this file via export

/* resolve single pane by names */
export function resolveTabPane($, names){
  const nameRe = new RegExp(`^(?:${names.map(n=>escapeRe(n)).join('|')})$`, 'i');
  let pane = null;

  $('a,button,[role="tab"]').each((_, el)=>{
    const label = cleanup($(el).text());
    if (!label || !nameRe.test(label)) return;

    const href = $(el).attr('href') || '';
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

/* Dojo/dijit */
export function parseDojoTabs($, baseUrl, tablistRoot) {
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
    try { $panel = $(`#${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(paneId) : paneId}`); }
    catch { $panel = $(`#${paneId}`); }
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

export async function hydrateLazyTabs(tabs, renderApiUrl, headers = {}) {
  if (!tabs || !tabs.length || !renderApiUrl) return tabs || [];
  const base = renderApiUrl.replace(/\/+$/,'');
  const out = [];

  for (const t of tabs) {
    const tt = { ...t };
    if (!tt.html && tt.href) {
      try {
        const url = `${base}/render?url=${encodeURIComponent(tt.href)}&mode=fast`;
        const { fetchWithRetry } = await import("./fetchers.js");
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

export function mergeTabTexts(tabs, order = ['Overview','Technical Specifications','Features','Downloads']) {
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

export function resolveAllPanes($, names){
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

/* container helpers exposed for reuse */
export function collectManualsFromContainer($, container, baseUrl, sinkSet){
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

export function extractFeaturesFromContainer($, container){
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
    if (out.length >= 20) break;
  }
  return out;
}

/* Orchestrator: augmentFromTabs */
export async function augmentFromTabs(norm, baseUrl, html, opts){
  const $ = cheerio.load(html);

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
          try {
            const { extractSpecsFromScripts, mergeSpecsAdditive } = await import("./specs.js");
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
          const { extractDescriptionFromContainer } = await import("./markdown.js");
          const d = extractDescriptionFromContainer($p, $p.root());
          if (d && d.length > (addDesc || "").length) addDesc = d;
        }
      }

      if (addDesc) {
        const { mergeDescriptions } = await import("./utils.js");
        norm.description_raw = mergeDescriptions(norm.description_raw || "", addDesc);
      }
      if (Object.keys(addSpecs).length) {
        const { prunePartsLikeSpecs } = await import("./specs.js");
        norm.specs = { ...(norm.specs || {}), ...prunePartsLikeSpecs(addSpecs) };
      }

      if (addFeatures.length) {
        const seen = new Set((norm.features_raw || []).map(v=>String(v).toLowerCase()));
        for (const f of addFeatures) {
          const k = String(f).toLowerCase();
          if (!seen.has(k)) { (norm.features_raw ||= []).push(f); seen.add(k); }
          if (norm.features_raw.length >= 20) break;
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

  const specPanes   = resolveAllPanes($, [ 'specification','specifications','technical specifications','tech specs','details' ]);
  const manualPanes = resolveAllPanes($, [ 'downloads','documents','technical resources','parts diagram','resources','manuals','documentation' ]);
  const featurePanes= resolveAllPanes($, [ 'features','features/benefits','benefits','key features','highlights' ]);
  const descPanes   = resolveAllPanes($, [ 'overview','description','product details','details' ]);

  const addSpecs = {};
  for (const el of specPanes) {
    Object.assign(addSpecs, extractSpecsFromContainer($, el));
    try {
      const { extractSpecsFromScripts, mergeSpecsAdditive } = await import("./specs.js");
      const jsonExtras = extractSpecsFromScripts($, el);
      Object.assign(addSpecs, mergeSpecsAdditive(jsonExtras, {}));
    } catch {}
  }

  const addManuals = new Set();
  for (const el of manualPanes) collectManualsFromContainer($, el, baseUrl, addManuals);

  const addFeatures = [];
  for (const el of featurePanes) {
    addFeatures.push(...extractFeaturesFromContainer($, el));
  }

  let addDesc = "";
  for (const el of descPanes) {
    const { extractDescriptionFromContainer } = await import("./markdown.js");
    const d = extractDescriptionFromContainer($, el);
    if (d && d.length > addDesc.length) addDesc = d;
  }

  if (addDesc) {
    const { mergeDescriptions } = await import("./utils.js");
    norm.description_raw = mergeDescriptions(norm.description_raw || "", addDesc);
  }
  if (Object.keys(addSpecs).length) {
    const { prunePartsLikeSpecs } = await import("./specs.js");
    norm.specs = { ...(norm.specs || {}), ...prunePartsLikeSpecs(addSpecs) };
  }

  if (addFeatures.length) {
    const seen = new Set((norm.features_raw || []).map(v=>String(v).toLowerCase()));
    for (const f of addFeatures) {
      const k = String(f).toLowerCase();
      if (!seen.has(k)) { (norm.features_raw ||= []).push(f); seen.add(k); }
      if (norm.features_raw.length >= 20) break;
    }
  }

  const paneImgs = new Set();
  const allPanes = [...specPanes, ...manualPanes, ...featurePanes, ...descPanes];
  for (const el of allPanes) {
    $(el).find('img, source').each((_, n)=>{
      const src = $(n).attr('src') || $(n).attr('data-src') || (await import("./images.js")).pickLargestFromSrcset($(n).attr('srcset')) || "";
      if (src) paneImgs.add(abs(baseUrl, src));
    });
  }
  if (paneImgs.size) {
    const filtered = await filterAndRankExtraPaneImages(Array.from(paneImgs), baseUrl, opts);
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

import * as cheerio from "cheerio";
import { cleanup, LEGAL_MENU_RE } from "./utils.js";
import { extractJsonLd, extractMicrodataProduct, extractRdfaProduct, extractOgProductMeta, mergeProductSD } from "./sd.js";
import { inferBrandFromName, firstGoodParagraph } from "./utils.js";
import { extractImages, extractImagesPlus, fallbackImagesFromMain } from "./images.js";
import { extractManuals, extractManualsPlus, fallbackManualsFromPaths } from "./manuals.js";
import {
  extractSpecsSmart, extractSpecsFromScripts, extractJsonLdAllProductSpecs, extractAllSpecPairs,
  prunePartsLikeSpecs, enrichSpecsWithDerived, mergeSpecsAdditive, deriveSpecsFromParagraphs
} from "./specs.js";
import { extractFeaturesSmart, deriveFeaturesFromParagraphs } from "./features.js";
import { extractDescriptionMarkdown, textToMarkdown, objectToMarkdownTable } from "./markdown.js";

export function extractNormalized(baseUrl, html, opts) {
  const { diag } = opts || {};
  const $ = cheerio.load(html);

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

  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content") || $('meta[property="og:image:secure_url"]').attr("content") || "",
    product: extractOgProductMeta($)
  };

  const name = cleanup(mergedSD.name || og.title || $("h1").first().text());
  let brand = cleanup(mergedSD.brand || "");
  if (!brand && name) brand = inferBrandFromName(name);

  let description_raw = cleanup(
    mergedSD.description || (() => {
      const selectors = [
        '[itemprop="description"]',
        '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description, .overview, .product-overview, .intro, .summary',
        '.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-tabs',
        '[id*="description" i], [class*="description" i], [id*="details" i], [class*="details" i], [id*="overview" i], [class*="overview" i], [id*="copy" i], [class*="copy" i]'
      ].join(', ');

      let best = "";
      $(selectors).each((_, el) => {
        if (isFooterOrNav($, el)) return;
        const elText = cleanup($(el).text() || "");
        if (!elText) return;
        if (LEGAL_MENU_RE.test(elText) || /^©\s?\d{4}/.test(elText)) return;

        const $el = $(el);
        const text = [
          $el.find('h1,h2,h3,h4,h5,strong,b,.lead,.intro').map((i, n) => $(n).text()).get().join(' '),
          $el.find('p').map((i, n) => $(n).text()).get().join(' ')
        ].join(' ');
        const cleaned = cleanup(text);
        if (cleaned && cleaned.length > cleanup(best).length) best = cleaned;
      });

      if (!best) {
        const scope = $('main,#main,.main,#content,.content').first();
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

  try {
    const extraImgs = extractImagesPlus($, mergedSD, og, baseUrl, name, html, opts);
    if (extraImgs && extraImgs.length) {
      const combined = [...(images||[]).map(i => ({ url: i.url })), ...extraImgs];
      const ranked = combined
        .map(x => ({ url: x.url, score: /cdn|cloudfront|akamai|uploads|product|gallery/i.test(x.url) ? 2 : 0 }))
        .sort((a,b)=> b.score - a.score);
      const { dedupeImageObjs } = await import("./images.js");
      const deduped = dedupeImageObjs(ranked, 12);
      images.length = 0; deduped.forEach(x => images.push(x));
    }
  } catch {}

  try {
    const extraMans = extractManualsPlus($, baseUrl, name, html, opts);
    if (extraMans && extraMans.length) {
      const { dedupeManualUrls } = await import("./manuals.js");
      const combined = dedupeManualUrls([ ...(manuals||[]), ...extraMans ]);
      manuals.length = 0; combined.forEach(x => manuals.push(x));
    }
  } catch {}

  let specs = Object.keys(mergedSD.specs || {}).length ? mergedSD.specs : extractSpecsSmart($);

  try {
    const extraJsonSpecs = extractSpecsFromScripts($);
    if (extraJsonSpecs && Object.keys(extraJsonSpecs).length) {
      specs = mergeSpecsAdditive(specs, extraJsonSpecs);
    }
  } catch {}

  try {
    const jsonldAll = extractJsonLdAllProductSpecs($);
    if (jsonldAll && Object.keys(jsonldAll).length) {
      specs = mergeSpecsAdditive(specs, jsonldAll);
    }
  } catch {}

  try {
    const globalPairs = extractAllSpecPairs($);
    if (globalPairs && Object.keys(globalPairs).length) {
      specs = mergeSpecsAdditive(specs, globalPairs);
    }
  } catch {}

  try { specs = prunePartsLikeSpecs(specs); } catch {}

  let features = (mergedSD.features && mergedSD.features.length) ? mergedSD.features : extractFeaturesSmart($);

  const imgs = images.length ? images : fallbackImagesFromMain($, baseUrl, og, opts);
  const mans = manuals.length ? manuals : fallbackManualsFromPaths($, baseUrl, name, html);

  if (!features.length) features = deriveFeaturesFromParagraphs($);
  if (!Object.keys(specs).length) specs = deriveSpecsFromParagraphs($);
  if (!description_raw) description_raw = firstGoodParagraph($);

  return {
    source: baseUrl,
    name_raw: name,
    description_raw,
    specs,
    features_raw: features,
    images: imgs,
    manuals: mans,
    brand
  };
}

/* ----- Optional post-processor (exported intact) ----- */
export function sanitizeIngestPayload(p) {
  const { toTitleCase, dedupeList } = await import("./utils.js");
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

  const badImg = /(logo|brandmark|favicon|sprite|placeholder|no-?image|missingimage|coming[-_]?soon|image[-_]?coming[-_]?soon|awaiting|spacer|blank|default|dummy|sample|temp|swatch|icon|social|facebook|twitter|instagram|linkedin|\/common\/images\/|\/icons\/|\/wp-content\/themes\/)/i;
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

/* helpers used by sanitizeIngestPayload (unchanged) */
export function splitBenefitSentencesText(text) {
  return String(text)
    .split(/[\.\n•·–;-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 180);
}

export function deriveSpecsFromText(text) {
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

export function firstGoodParagraphText(text) {
  const paras = String(text)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 50);
  return paras[0] || '';
}

