// medx-ingest-api/server.js
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import { URL } from "node:url";
import net from "node:net";

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

/* ================== Ingest route ================== */
/**
 * GET /ingest?url=<https://...>&selector=.css&wait=ms&timeout=ms&mode=fast|full
 * &minpx=200&excludepng=true&aggressive=true
 * &harvest=true&sanitize=true
 * &markdown=true
 * &debug=true
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
      // Soft fallback only for transient upstream errors
      if (status === 502 || status === 503 || status === 504) {
        diag.warnings.push(`render-upstream-${status}; falling back to direct fetch`);
        try {
          // Direct fetch of the target URL (no JS). Still better than failing the request.
          rendered = await fetchDirectHtml(targetUrl, { headers });
        } catch (e2) {
          // If fallback also fails, rethrow original error so behavior is unchanged for other cases
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
    let norm = extractNormalized(targetUrl, html, { minImgPx, excludePng, aggressive, diag });
    diag.timings.extractMs = now() - t1;

    if (!norm.name_raw && (!norm.description_raw || norm.description_raw.length < 10)) {
      return res.status(422).json({ error: "No extractable product data (JSON-LD/DOM empty)." });
    }

    if (doHarvest) {
      const t2 = now();
      norm = await augmentFromTabs(norm, targetUrl, html, { minImgPx, excludePng });
      diag.timings.harvestMs = now() - t2;
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
        diag.warnings.push(`compass-overview: ${e.message||e}`);
      }

      // (2) Technical Specifications (union-merge; existing keys win)
      try {
        const compassSpecs = harvestCompassSpecs($);
        if (Object.keys(compassSpecs).length) {
          norm.specs = { ...(norm.specs || {}), ...compassSpecs };
        }
      } catch(e){
        diag.warnings.push(`compass-specs: ${e.message||e}`);
      }
    }
    // === end Compass-only additions ===

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
        const $el = $(el);
        // headings + lead + paragraphs feel like a true description
        const text = [
          $el.find('h1,h2,h3,h4,h5,strong,b,.lead,.intro').map((i, n) => $(n).text()).get().join(' '),
          $el.find('p').map((i, n) => $(n).text()).get().join(' ')
        ].join(' ');
        const cleaned = cleanup(text);
        if (cleaned && cleaned.length > cleanup(best).length) best = cleaned;
      });

      // 2) Fallback: longest paragraph anywhere in main content
      if (!best) {
        const scope = $('main,#main,.main,#content,.content,body').first();
        const paras = scope.find('p').map((i, el) => cleanup($(el).text())).get();
        best = paras.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), "");
      }
      return best || "";
    })() || og.description || $('meta[name="description"]').attr('content') || ""
  );

  const images  = extractImages($, mergedSD, og, baseUrl, name, html, opts);
  const manuals = extractManuals($, baseUrl, name, html, opts);

  let specs    = Object.keys(mergedSD.specs || {}).length ? mergedSD.specs : extractSpecsSmart($);
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

function extractOgProductMeta($){
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

function mergeProductSD(a={}, b={}, c={}){
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

function extractImages($, structured, og, baseUrl, name, rawHtml, opts){
  const minPx     = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng= (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;
  const aggressive= !!(opts && opts.aggressive);

  const set = new Set();
  const imgWeights = new Map();
  const push = (u, weight = 0) => {
    if (!u) return;
    const absu = abs(baseUrl, u);
    if (!absu) return;
    if (!imgWeights.has(absu)) imgWeights.set(absu, 0);
    imgWeights.set(absu, Math.max(imgWeights.get(absu), weight));
    set.add(absu);
  };

  // structured data images
  (structured.images || []).forEach(u => push(u, 3));

  // gallery containers
  const gallerySelectors = [
    '.product-media','.product__media','.product-gallery','.gallery','.media-gallery','#product-gallery','#gallery','[data-gallery]',
    '.product-images','.product-image-gallery','.pdp-gallery','.slick-slider','.slick','.swiper','.swiper-container','.carousel',
    '.owl-carousel','.fotorama','.MagicZoom','.cloudzoom-zoom','.zoomWindow','.zoomContainer','.lightbox','.thumbnails'
  ].join(', ');
  $(gallerySelectors).find('img, source').each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr('src'), $el.attr('data-src'), $el.attr('data-srcset'),
      $el.attr('data-original'), $el.attr('data-large_image'), $el.attr('data-image'),
      $el.attr('data-zoom'), pickLargestFromSrcset($el.attr('srcset')),
    ];
    cands.forEach(u => push(u, 3));
  });

  if (og.image) push(og.image, 2);

  $("img").each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr("src"), $el.attr("data-src"), $el.attr("data-srcset"),
      $el.attr("data-original"), $el.attr("data-lazy"), $el.attr("data-zoom-image"),
      $el.attr("data-large_image"), $el.attr("data-image"),
      pickLargestFromSrcset($el.attr("srcset")),
    ];
    cands.forEach(u => push(u, 1));
  });

  // noscript fallbacks
  $("noscript").each((_, n)=>{
    const inner = $(n).html() || "";
    const _$ = cheerio.load(inner);
    _$("img").each((__, el)=>{
      const src = _$(el).attr("src") || _$(el).attr("data-src") || pickLargestFromSrcset(_$(el).attr("srcset"));
      if (src) push(src, 2);
    });
  });

  $("picture source[srcset]").each((_, el) => { push(pickLargestFromSrcset($(el).attr("srcset")), 1); });

  $('[style*="background"]').each((_, el) => {
    const style = String($(el).attr("style") || "");
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(m[2], 1);
  });

  $('link[rel="image_src"]').each((_, el) => push($(el).attr("href"), 1));

  $('script').each((_, el) => {
    const txt = String($(el).contents().text() || '');
    if (!txt || !/\.(?:jpe?g|png|webp)\b/i.test(txt)) return;
    try {
      const obj = JSON.parse(txt);
      deepFindImagesFromJson(obj).forEach(u => push(u, 2));
    } catch {
      const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
      let m; while ((m = re.exec(txt))) push(m[1], 1);
    }
  });

  if (rawHtml) {
    const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m; while ((m = re.exec(rawHtml))) push(m[1], 0);
  }

  let arr = Array.from(set).filter(Boolean).map(u => decodeHtml(u));

  const allowWebExt = excludePng ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;
  const host = safeHostname(baseUrl);
  const allowHostRe = new RegExp([
    host.includes("drivemedical")        ? "/medias|/products|/pdp|/images/products|/product-images|/commerce/products|/uploads" : "",
    host.includes("mckesson")            ? "/product|/images|/product-images|/assets/product" : "",
    host.includes("compasshealthbrands") ? "/media/images/items|/product|/images" : "",
    host.includes("motifmedical")        ? "/wp-content/uploads|/product|/images" : ""
  ].filter(Boolean).join("|"), "i");

  const badReBase = [
    'logo','brandmark','favicon','sprite','placeholder','no-?image','missingimage','loader',
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
    if (/thumb|thumbnail|small|tiny|badge|mini|icon/.test(L)) score -= 2;
    if (/(_\d{3,}x\d{3,}|-?\d{3,}x\d{3,}|(\?|&)(w|width|h|height|size)=\d{3,})/.test(L)) score += 1;
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

function fallbackImagesFromMain($, baseUrl, og, opts){
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

  // noscript fallbacks in main area
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
    'tech specs','specifications','specification','details'
  ]);
  if (specPane) {
    const scoped = extractSpecsFromContainer($, specPane);
    if (Object.keys(scoped).length) return scoped;
  }

  const dense = extractSpecsFromDensestBlock($);
  if (Object.keys(dense).length) return dense;

  const out = {};
  $('table').each((_, tbl)=>{
    $(tbl).find('tr').each((__, tr)=>{
      const cells=$(tr).find('th,td');
      if (cells.length>=2){
        const k=cleanup($(cells[0]).text()).toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        const v=cleanup($(cells[1]).text());
        if (k && v && k.length<80 && v.length<400) out[k]=v;
      }
    });
  });

  $('dl').each((_, dl)=>{
    const dts=$(dl).find('dt'), dds=$(dl).find('dd');
    if (dts.length === dds.length && dts.length){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text()).toLowerCase().replace(/\s+/g,'_').replace(/:$/,'');
        const v=cleanup($(dds[i]).text());
        if (k && v && k.length<80 && v.length<400) out[k]=v;
      }
    }
  });

  $('li').each((_, li)=>{
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
    '.category','.collections','.filters'
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

function deriveFeaturesFromParagraphs($){
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

/* === Resolve tabs === */
function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function documentQueryById($, id){
  try { return id ? $(`#${CSS.escape(id)}`)[0] : null; }
  catch { return id ? $(`#${id}`)[0] : null; }
}

function resolveTabPane($, names){
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

/* ===== Dojo/dijit TabContainer helpers (for role=tab + dojo ids) ===== */

// ===== Dojo/dijit TabContainer helpers (improved) =====

// Parse Dojo/ARIA tabs and map each tab -> {title, html/text, href}.
// Scans multiple tablist patterns and falls back by tab index when needed.
function parseDojoTabs($, baseUrl, tablistRoot) {
  const out = [];

  // Candidate tablist roots (covers Dojo 1.x variations and ARIA)
  const $roots = tablistRoot
    ? $(tablistRoot)
    : $(
        [
          '[role="tablist"]',
          '.dijitTabContainer',
          '[data-dojo-type*="TabContainer"]',
          '[dojoType*="TabContainer"]',
        ].join(', ')
      );

  if (!$roots.length) return out;

  $roots.each((_, rootEl) => {
    const $root = $(rootEl);

    // Collect tabs: real ARIA tabs + common Dojo tab nodes
    const tabs = $root
      .find('[role="tab"], .dijitTab, .dijitTabChecked, .dijitTabContainer .dijitTabListWrapper .dijitTab')
      .toArray();

    // Find all panels near this tablist (helps when linkage attrs are missing)
    const $container = $root.closest('.dijitTabContainer').length ? $root.closest('.dijitTabContainer') : $root.parent();
    const panelCandidates = $container
      .find('[role="tabpanel"], .dijitTabPane, .dijitTabContainer .dijitTabPaneWrapper > *')
      .toArray();

    tabs.forEach((tabEl, i) => {
      const $label = $(tabEl);
      // If the visible text sits on a child (e.g., .tabLabel), prefer the longest text we can find
      const $tabNode = $label.is('[role="tab"]') ? $label : $label.closest('[role="tab"]');
      const rawTitle = [
        String($label.attr('title') || '').trim(),
        String($label.text() || '').trim(),
        $tabNode.length ? String($tabNode.attr('title') || '').trim() : '',
        $tabNode.length ? String($tabNode.text() || '').trim() : '',
      ]
        .map(s => s || '')
        .sort((a, b) => b.length - a.length)[0] || '';

      const tabId = ($tabNode.attr('id') || $label.attr('id') || '').trim();

      // prefer aria-controls; fallback: extract after "tablist_" from Dojo ids
      let paneId = ($tabNode.attr('aria-controls') || '').trim();
      if (!paneId && tabId && tabId.includes('tablist_')) {
        paneId = tabId.slice(tabId.indexOf('tablist_') + 'tablist_'.length);
      }

      // Locate the panel by id or aria-labelledby; otherwise by index
      let $panel = null;
      if (paneId) {
        try {
          $panel = $(`#${(typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(paneId) : paneId}`);
        } catch {
          $panel = $(`#${paneId}`);
        }
      }
      if (!$panel || !$panel.length) {
        if (tabId) $panel = $(`[role="tabpanel"][aria-labelledby="${tabId}"]`);
      }
      if (!$panel || !$panel.length) {
        // Last resort: map i-th tab to i-th panel within the same container
        const p = panelCandidates[i];
        if (p) $panel = $(p);
      }
      if (!$panel || !$panel.length) return; // give up on this tab

      const html = $panel.html() || '';
      const text = (String($panel.text() || '')).replace(/\s+/g, ' ').trim();

      // Support Dojo ContentPane lazy loading (href / data-href / data-dojo-props), on panel *or* tab
      let href =
        $panel.attr('href') ||
        $panel.attr('data-href') ||
        $tabNode.attr('href') ||
        $tabNode.attr('data-href') ||
        '';
      if (!href) {
        const props =
          $panel.attr('data-dojo-props') ||
          $tabNode.attr('data-dojo-props') ||
          '';
        const m = /href\s*:\s*['"]([^'"]+)['"]/.exec(props);
        if (m) href = m[1];
      }

      out.push({
        tab_id: tabId,
        panel_id: paneId || '',
        title: rawTitle || '',
        html,
        text,
        href: href ? abs(baseUrl, href) : '',
      });
    });
  });

  return out;
}


// If a tab was lazy (no html but has href), render/fetch it once and fill html/text.
// Uses your existing Render API + token.
async function hydrateLazyTabs(tabs, renderApiUrl, headers = {}) {
  if (!tabs || !tabs.length || !renderApiUrl) return tabs || [];
  const base = renderApiUrl.replace(/\/+$/,'');
  const out = [];

  for (const t of tabs) {
    const tt = { ...t };
    if (!tt.html && tt.href) {
      try {
        const url = `${base}/render?url=${encodeURIComponent(tt.href)}&mode=fast`;
        const { html } = await fetchWithRetry(url, { headers });
        const $p = cheerio.load(html);
        tt.html = $p.root().html() || '';
        tt.text = $p.root().text().replace(/\s+/g,' ').trim();
      } catch (e) {
        // Soft fallback: fetch raw HTML directly if renderer 5xx’s
        const status = e && e.status ? Number(e.status) : 0;
        if (typeof fetchDirectHtml === 'function' && (status === 502 || status === 503 || status === 504)) {
          try {
            const html = await fetchDirectHtml(tt.href, { headers });
            const $p = cheerio.load(html);
            tt.html = $p.root().html() || '';
            tt.text = $p.root().text().replace(/\s+/g,' ').trim();
          } catch {}
        }
      }
    }
    out.push(tt);
  }
  return out;
}

// Convenience: merge texts from a preferred tab order into one block (optional)
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

/* ================== Tab/Accordion Harvester ================== */
function extractSpecsFromContainer($, container){
  const out = {};
  const $c = $(container);

  $c.find('table').each((_, tbl)=>{
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
    if (out.length >= 20) break;
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
    if (/^\s*(share|subscribe|privacy|terms)\b/i.test(t)) return;
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
/* ====== Markdown builders ====== */
function extractDescriptionMarkdown($){
  const candidates = [
    '[itemprop="description"]',
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description, .overview, .product-overview, .intro, .summary',
    '.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-tabs'
  ].join(', ');

  let bestEl = null, bestLen = 0;
  $(candidates).each((_, el)=>{
    const text = cleanup($(el).text());
    if (text && text.length > bestLen) { bestLen = text.length; bestEl = el; }
  });
  if (!bestEl) return "";

  const raw = extractDescriptionFromContainer($, bestEl);
  return containerTextToMarkdown(raw);
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
      return Math.max(w||0,h||0) >= minPx;
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

/* ================== Tab harvest orchestrator ================== */
async function augmentFromTabs(norm, baseUrl, html, opts){
  const $ = cheerio.load(html);

  // === Dojo/dijit TabContainer pre-pass (handles <span class="tabLabel" role="tab"> etc.) ===
  try {
    const dojoTabs0 = parseDojoTabs($, baseUrl);
    if (dojoTabs0.length) {
      // hydrate any lazy tabs (ContentPane with href)
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
        // route by tab title
        const title = String(t.title || '').toLowerCase();

        if (specNames.some(n => title.includes(n))) {
          Object.assign(addSpecs, extractSpecsFromContainer($p, $p.root()));
        }
        if (featNames.some(n => title.includes(n))) {
          addFeatures.push(...extractFeaturesFromContainer($p, $p.root()));
        }
        if (downNames.some(n => title.includes(n))) {
          collectManualsFromContainer($p, $p.root(), baseUrl, addManuals);
          // also scan for PDFs in raw html as a bonus
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
      if (Object.keys(addSpecs).length) norm.specs = { ...(norm.specs || {}), ...addSpecs };

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
  // === end Dojo/dijit pre-pass ===

  const specPanes   = resolveAllPanes($, [ 'specification','specifications','technical specifications','tech specs','details' ]);
  const manualPanes = resolveAllPanes($, [ 'downloads','documents','technical resources','parts diagram','resources','manuals','documentation' ]);
  const featurePanes= resolveAllPanes($, [ 'features','features/benefits','benefits','key features','highlights' ]);
  const descPanes   = resolveAllPanes($, [ 'overview','description','product details','details' ]);

  const addSpecs = {};
  for (const el of specPanes) Object.assign(addSpecs, extractSpecsFromContainer($, el));

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
  if (Object.keys(addSpecs).length) norm.specs = { ...(norm.specs || {}), ...addSpecs };

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

  const badImg = /(logo|brandmark|favicon|sprite|placeholder|no-?image|missingimage|icon|social|facebook|twitter|instagram|linkedin|\/common\/images\/|\/icons\/|\/wp-content\/themes\/)/i;
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

function toTitleCase(s) { return String(s).replace(/\b([a-z])/g, (m, c) => c.toUpperCase()); }

function dedupeList(arr) {
  const seen = new Set();
  return arr.filter(x => {
    const k=String(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ======= Shared helpers ======= */
function splitIntoSentences(text){
  return String(text)
    .replace(/\s*\n\s*/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(0-9])|[•·–\-]\s+|;\s+|·\s+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function mergeDescriptions(a, b){
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

function harvestCompassSpecs($){
  const panels = $('.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-details, .product-detail, section');
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
      const t = cleanup($(li).text());
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

/* ================== Listen ================== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));
