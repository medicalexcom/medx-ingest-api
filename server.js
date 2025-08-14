// medx-ingest-api/server.js
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

/* ================== Config via env ================== */
const RENDER_API_URL = (process.env.RENDER_API_URL || "").trim(); // e.g. https://medx-render-api.onrender.com
const RENDER_API_TOKEN = (process.env.RENDER_API_TOKEN || "").trim(); // optional if renderer enforces auth
const MIN_IMG_PX = parseInt(process.env.MIN_IMG_PX || "200", 10); // min width/height inferred from URL hints

/* ================== App setup ================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/* ================== Ingest route ================== */
/**
 * GET /ingest?url=<https://...>&selector=.css&wait=ms&timeout=ms&mode=fast|full
 */
app.get("/ingest", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "");
    if (!rawUrl) return res.status(400).json({ error: "Missing url param" });

    // Accept BOTH raw and pre-encoded URLs without double-encoding
    const targetUrl = safeDecodeOnce(rawUrl);
    if (!/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ error: "Invalid url param" });
    }
    if (!RENDER_API_URL) return res.status(500).json({ error: "RENDER_API_URL not set" });

    const selector = req.query.selector ? `&selector=${encodeURIComponent(String(req.query.selector))}` : "";
    const wait = req.query.wait != null ? `&wait=${encodeURIComponent(String(req.query.wait))}` : "";
    const timeout = req.query.timeout != null ? `&timeout=${encodeURIComponent(String(req.query.timeout))}` : "";
    const mode = req.query.mode ? `&mode=${encodeURIComponent(String(req.query.mode))}` : "&mode=fast";

    const endpoint = `${RENDER_API_URL.replace(/\/+$/,"")}/render?url=${encodeURIComponent(targetUrl)}${selector}${wait}${timeout}${mode}`;
    const headers = { "User-Agent": "MedicalExIngest/1.2" };
    if (RENDER_API_TOKEN) headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;

    // Retry renderer 3x (handles cold starts & flaky nav)
    let html = null, lastStatus = 0, lastBody = "";
    for (let i = 1, delay = 700; i <= 3; i++, delay = Math.floor(delay * 1.8)) {
      try {
        const r = await fetch(endpoint, { headers });
        lastStatus = r.status;
        if (r.ok) { html = await r.text(); break; }
        lastBody = (await r.text().catch(()=> "")) || "";
        console.warn(`RENDER_API_ERROR attempt ${i}`, r.status, lastBody.slice(0,180));
      } catch (e) {
        lastBody = String(e);
        console.warn(`RENDER_API_FETCH_ERR attempt ${i}`, lastBody.slice(0,180));
      }
      if (i < 3) await new Promise(s=>setTimeout(s, delay));
    }
    if (!html) return res.status(502).json({ error: "Render API failed", body: `status=${lastStatus} body=${lastBody.slice(0,280)}` });

    const norm = extractNormalized(targetUrl, html);
    if (!norm.name_raw && (!norm.description_raw || norm.description_raw.length < 10)) {
      return res.status(422).json({ error: "No extractable product data (JSON-LD/DOM empty)." });
    }
    return res.json(norm);
  } catch (e) {
    console.error("INGEST ERROR:", e);
    return res.status(500).json({ error: String(e) });
  }
});

/* ================== Normalization ================== */
function extractNormalized(baseUrl, html) {
  const $ = cheerio.load(html);

  const jsonld = extractJsonLd($);
  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content") || ""
  };

  // Name
  const name = cleanup(jsonld.name || og.title || $("h1").first().text());

  // Brand
  let brand = cleanup(jsonld.brand || "");
  if (!brand) brand = inferBrandFromName(name);

  // Description (also mine tab panes)
  const description_raw = cleanup(
    jsonld.description ||
    pickBestDescriptionBlock($) ||
    og.description ||
    $('meta[name="description"]').attr("content") ||
    ""
  );

  const images = extractImages($, jsonld, og, baseUrl, name, html);
  const manuals = extractManuals($, baseUrl, name);
  const specs = Object.keys(jsonld.specs || {}).length ? jsonld.specs : extractSpecsSmart($);
  const features = (jsonld.features && jsonld.features.length) ? jsonld.features : extractFeaturesSmart($);

  return {
    source: baseUrl,
    name_raw: name,
    description_raw,
    specs,
    features_raw: features,
    images,
    manuals,
    brand
  };
}

/* ================== Extractors ================== */
function extractJsonLd($){
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      if (!raw || !raw.trim()) return;
      const obj = JSON.parse(raw.trim());
      const arr = Array.isArray(obj) ? obj : [obj];
      arr.forEach(n=>{
        const t = String(n['@type'] || '').toLowerCase();
        if (t.includes('product') || n.name || n.offers) nodes.push(n);
      });
    } catch {}
  });
  const p = nodes[0] || {};
  return {
    name: p.name || '',
    description: p.description || '',
    brand: (p.brand && (p.brand.name || p.brand)) || '',
    specs: schemaPropsToSpecs(p.additionalProperty || p.additionalProperties || []),
    features: Array.isArray(p.featureList) ? p.featureList : [],
    images: p.image ? (Array.isArray(p.image) ? p.image : [p.image]) : []
  };
}

function schemaPropsToSpecs(props){
  const out = {};
  try{
    props.forEach(p=>{
      const k=(p.name||p.property||'').toString().trim().toLowerCase().replace(/\s+/g,'_');
      const v=(p.value||p['@value']||p.description||'').toString().trim();
      if (k && v) out[k]=v;
    });
  }catch{}
  return out;
}

/* === Description block === */
function pickBestDescriptionBlock($){
  const candidates = [
    '[itemprop="description"]',
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description',
    '.tab-content, .tabs-content, .panel, [role="tabpanel"], #tabs'
  ].join(', ');

  let text = "";
  $(candidates).each((_, el) => {
    let t = $(el).find('p, li').map((__, n)=>$(n).text()).get().join(' ');
    t = cleanup(t || $(el).text());
    if (t && t.length > text.length) text = t;
  });

  if (!text) {
    let best = "";
    $("main, #main, .main, .content, #content, body").first().find("p").each((_, p)=>{
      const t = cleanup($(p).text());
      if (t && t.length > best.length) best = t;
    });
    text = best;
  }
  return text || "";
}

/* === Brand heuristic === */
function inferBrandFromName(name){
  const first = (name || "").split(/\s+/)[0] || "";
  if (/^(the|a|an|pro|basic|probasic|shower|chair|with|and|for)$/i.test(first)) return "";
  if (/^[A-Z][A-Za-z0-9\-]+$/.test(first)) return first;
  return "";
}

/* === IMAGE EXTRACTION & SCORING (gallery-first, filters junk, min-px, cap 12) === */
function extractImages($, jsonld, og, baseUrl, name, rawHtml){
  const set = new Set();
  const push = (u, weight = 0) => {
    if (!u) return;
    const absu = abs(baseUrl, u);
    if (!absu) return;
    if (!imgWeights.has(absu)) imgWeights.set(absu, 0);
    imgWeights.set(absu, Math.max(imgWeights.get(absu), weight));
    set.add(absu);
  };
  const imgWeights = new Map();

  // Prefer images INSIDE obvious gallery/media containers
  const gallerySelectors = [
    '.product-media', '.product__media', '.product-gallery', '.gallery', '.media-gallery',
    '#product-gallery', '#gallery', '[data-gallery]', '.product-images', '.product-image-gallery',
    '.pdp-gallery', '.slick-slider', '.swiper', '.carousel'
  ].join(', ');

  $(gallerySelectors).find('img, source').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || $el.attr('data-src') || $el.attr('data-original') || '';
    const ss  = $el.attr('srcset') || '';
    if (src) push(src, 3);
    const best = pickLargestFromSrcset(ss);
    if (best) push(best, 3);
  });

  // JSON-LD & OG
  (jsonld.images || []).forEach(u => push(u, 2));
  push(og.image, 2);

  // <img> (src + lazy attrs + srcset)
  $("img").each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr("src"),
      $el.attr("data-src"),
      $el.attr("data-original"),
      $el.attr("data-lazy"),
      $el.attr("data-zoom-image"),
      pickLargestFromSrcset($el.attr("srcset")),
    ];
    cands.forEach(u => push(u, 1));
  });

  // <picture><source srcset>
  $("picture source[srcset]").each((_, el) => {
    push(pickLargestFromSrcset($(el).attr("srcset")), 1);
  });

  // Inline background-image
  $('[style*="background"]').each((_, el) => {
    const style = String($(el).attr("style") || "");
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(m[2], 1);
  });

  // link rel=image_src
  $('link[rel="image_src"]').each((_, el) => push($(el).attr("href"), 1));

  // Regex sweep for asset paths in raw HTML (handles Compass & others)
  if (rawHtml) {
    const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m;
    while ((m = re.exec(rawHtml))) push(m[1], 0);
  }

  // Normalize + filter
  let arr = Array.from(set).filter(Boolean).map(u => decodeHtml(u));

  const okExt = /\.(jpe?g|png|webp)(?:[?#].*)?$/i;

  // Block obvious non-product assets (social/icons/sprites/placeholders)
  const badRe = new RegExp([
    'logo','brandmark','favicon','sprite','placeholder','no-?image','missingimage','loader','ajax-loader',
    'spinner','icon','badge','flag','cart','arrow','pdf','facebook','twitter','instagram','linkedin',
    '\\/wcm\\/connect','/common/images/','/icons/','/social/','/share/'
  ].join('|'), 'i');

  // Min-pixel filter (based on URL hints only; we don't fetch image bytes)
  arr = arr
    .filter(u => okExt.test(u))
    .filter(u => !badRe.test(u))
    .filter(u => {
      const { w, h } = inferSizeFromUrl(u);
      if (!w && !h) return true; // keep if unknown
      const maxDim = Math.max(w || 0, h || 0);
      return maxDim >= MIN_IMG_PX;
    });

  // Scoring (gallery weight + path pref + code/title hits; de-weight thumbs)
  const titleTokens = (name || "").toLowerCase().split(/\s+/).filter(Boolean);
  const codeCandidates = [];
  const m1 = /\/item\/([^\/?#]+)/i.exec(baseUrl);
  const m2 = /\/p\/([A-Za-z0-9._-]+)/i.exec(baseUrl);
  const m3 = /\/product\/([A-Za-z0-9._-]+)/i.exec(baseUrl);
  if (m1) codeCandidates.push(m1[1]);
  if (m2) codeCandidates.push(m2[1]);
  if (m3) codeCandidates.push(m3[1]);

  const preferRe = /(\/media\/images\/items\/|\/images\/(products?|catalog)\/|\/products?\/|\/product\/|\/pdp\/|\/assets\/product|\/product-images?\/)/i;

  const scored = arr.map(u => {
    const L = u.toLowerCase();
    let score = imgWeights.get(u) || 0;
    if (preferRe.test(L)) score += 3;
    if (codeCandidates.some(c => c && L.includes(String(c).toLowerCase()))) score += 3;
    if (titleTokens.some(t => L.includes(t))) score += 1;
    if (/thumb|thumbnail|small|tiny|badge|mini/.test(L)) score -= 1;
    if (/(_\d{3,}x\d{3,}|-?\d{3,}x\d{3,}|\/large\/|\/hi(res)?\/|(\?|&)(w|width|h|height|size)=\d{3,})/.test(L)) score += 1;
    return { url: u, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Dedup by filename; CAP = 12
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const base = s.url.split("/").pop().split("?")[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url: s.url });
    if (out.length >= 12) break;
  }

  return out;
}

function pickLargestFromSrcset(srcset) {
  if (!srcset) return "";
  try {
    const parts = String(srcset)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const [u, d] = s.split(/\s+/);
        const n = d && /\d+/.test(d) ? parseInt(d, 10) : 0; // treat "2x" or "800w" as numeric
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
  // Parses hints like ..._800x800..., -800x, 800x600, ?w=800&h=800, &width=1200, etc.
  try {
    const out = { w: 0, h: 0 };
    const lower = u.toLowerCase();

    // Filename patterns
    const fn = lower.split("/").pop() || "";
    let m = fn.match(/(?:_|-)(\d{2,5})x(\d{2,5})/); // _800x800 or -1200x628
    if (m) { out.w = parseInt(m[1], 10); out.h = parseInt(m[2], 10); return out; }

    m = fn.match(/(?:_|-)(\d{2,5})x/); // -800x (width only)
    if (m) { out.w = parseInt(m[1], 10); return out; }

    m = fn.match(/(\d{2,5})x(\d{2,5})/); // 800x600 (bare)
    if (m) { out.w = parseInt(m[1], 10); out.h = parseInt(m[2], 10); return out; }

    // Query params
    const q = u.split("?")[1] || "";
    if (q) {
      const params = new URLSearchParams(q);
      const widthKeys = ["w", "width", "maxwidth", "mw", "size"];
      const heightKeys = ["h", "height", "maxheight", "mh"];
      for (const k of widthKeys) {
        const v = params.get(k);
        if (v && /^\d{2,5}$/.test(v)) out.w = Math.max(out.w, parseInt(v, 10));
      }
      for (const k of heightKeys) {
        const v = params.get(k);
        if (v && /^\d{2,5}$/.test(v)) out.h = Math.max(out.h, parseInt(v, 10));
      }
    }
    return out;
  } catch {
    return { w: 0, h: 0 };
  }
}

/* === Manuals (IFU) — allowlist real manuals, block certifications === */
function extractManuals($, baseUrl, name){
  const urls = new Set();

  const allowRe = /(manual|ifu|instructions?|user[- ]?guide|assembly|owner|quick[- ]?start|install|setup|spec(sheet)?)/i;
  const blockRe = /(iso|mdsap|ce(-|\\s)?cert|certificate|quality\\s+management|annex)/i; // certifications & quality docs

  // Prefer links around PDP content/tabs only
  const scope = $([
    '.product-details','.product-detail','.product-description','.product__info',
    '.tab-content','.tabs-content','[role="tabpanel"]','#tabs','main','#main','.main','#content','.content'
  ].join(', '));

  scope.find('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href = String($(el).attr("href")||"");
    const txt  = cleanup($(el).text()).toLowerCase();
    const full = abs(baseUrl, href);
    if (!full) return;

    const looksManual = allowRe.test(txt) || allowRe.test(full);
    const looksBlocked = blockRe.test(txt) || blockRe.test(full);

    if (looksManual && !looksBlocked) {
      urls.add(full);
    }
  });

  // If none found in scope, do a second-chance pass but still enforce allow/block
  if (!urls.size) {
    $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
      const href=String($(el).attr("href")||"");
      const txt=cleanup($(el).text()).toLowerCase();
      const full=abs(baseUrl, href);
      if (!full) return;
      if ((allowRe.test(txt) || allowRe.test(full)) && !(blockRe.test(txt) || blockRe.test(full))) {
        urls.add(full);
      }
    });
  }

  return Array.from(urls);
}

/* === Specs — tables + dl + key:value inside "Specifications" tab === */
function extractSpecsSmart($){
  const out = {};

  // 1) Tables (global)
  $("table").each((_, tbl)=>{
    $(tbl).find("tr").each((__, tr)=>{
      const cells=$(tr).find("th,td");
      if (cells.length>=2){
        const k=cleanup($(cells[0]).text()).toLowerCase().replace(/\s+/g,'_');
        const v=cleanup($(cells[1]).text());
        if (k && v && k.length<80 && v.length<400) out[k]=v;
      }
    });
  });

  // 2) dl pairs (global)
  $("dl").each((_, dl)=>{
    const dts=$(dl).find("dt"), dds=$(dl).find("dd");
    if (dts.length === dds.length && dts.length){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text()).toLowerCase().replace(/\s+/g,'_');
        const v=cleanup($(dds[i]).text());
        if (k && v && k.length<80 && v.length<400) out[k]=v;
      }
    }
  });

  // 3) Named pane: Specifications
  const specPane = resolveTabPane($, ['specification','specifications','tech specs','technical specifications','details']);
  if (specPane && Object.keys(out).length === 0){
    // key:value lists
    $(specPane).find('li').each((_, li)=>{
      const t = cleanup($(li).text());
      if (!t || t.length < 3 || t.length > 200) return;
      const m = t.split(/[:\-–]\s+/);
      if (m.length >= 2){
        const k = m[0].toLowerCase().replace(/\s+/g,'_');
        const v = m.slice(1).join(': ').trim();
        if (k && v) out[k]=v;
      }
    });
  }

  return out;
}

/* === Features — from feature containers/tabs only; exclude nav/breadcrumbs/etc. === */
function extractFeaturesSmart($){
  const items = [];
  const scopeSel = [
    '.features','.feature-list','.product-features','[data-features]',
    '.tab-content','.tabs-content','[role="tabpanel"]','#tabs'
  ].join(', ');
  const excludeSel = [
    'nav','.breadcrumb','.breadcrumbs','[aria-label="breadcrumb"]',
    '.related','.upsell','.cross-sell','.menu','.footer','.header','.sidebar'
  ].join(', ');

  $(scopeSel).each((_, el)=>{
    const $el = $(el);
    if ($el.closest(excludeSel).length) return;
    $el.find('li').each((__, li)=>{
      const txt = cleanup($(li).text());
      if (txt && txt.length>6 && txt.length<220) items.push(txt);
    });
  });

  // Also check a named "Features" pane
  const featPane = resolveTabPane($, ['feature','features','key features','highlights','benefits']);
  if (featPane){
    $(featPane).find('li').each((_, li)=>{
      const txt = cleanup($(li).text());
      if (txt && txt.length>6 && txt.length<220) items.push(txt);
    });
  }

  // de-dup & cap
  const seen = new Set(); const out=[];
  for (const t of items){
    const key=t.toLowerCase();
    if (!seen.has(key)){ seen.add(key); out.push(t); }
    if (out.length>=12) break;
  }
  return out;
}

/* === Resolve a tab button to its pane by text (e.g., "Specifications", "Features") === */
function resolveTabPane($, names){
  const nameRe = new RegExp(`^(?:${names.map(n=>escapeRe(n)).join('|')})$`, 'i');

  // Look for tab buttons/links whose text matches
  let pane = null;
  $('a,button').each((_, el)=>{
    const label = cleanup($(el).text());
    if (!label || !nameRe.test(label)) return;
    const href = $(el).attr('href') || '';
    const controls = $(el).attr('aria-controls') || '';
    let target = null;

    if (href && href.startsWith('#')) target = $(href)[0];
    if (!target && controls) target = documentQueryById($, controls);

    if (target) { pane = target; return false; } // break
  });

  // Fallback: look for panels with heading matching
  if (!pane){
    $('[role="tabpanel"], .tab-pane, .panel, .tabs-content').each((_, el)=>{
      const heading = cleanup($(el).find('h2,h3,h4').first().text());
      if (heading && nameRe.test(heading)) { pane = el; return false; }
    });
  }
  return pane;
}

/* ================== Utils ================== */
function documentQueryById($, id){
  try { return id ? $(`#${CSS.escape(id)}`)[0] : null; } catch { return id ? $(`#${id}`)[0] : null; }
}
function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function safeDecodeOnce(s){
  try {
    const decoded = decodeURIComponent(s);
    if (!decoded || /%[0-9A-Fa-f]{2}/.test(decoded)) return s;
    return decoded;
  } catch { return s; }
}

function decodeHtml(s){ return s ? s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>') : s; }
function cleanup(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function abs(base, link){
  try {
    if (!link) return link;
    if (/^https?:\/\//i.test(link)) return link;
    const u = new URL(base);
    if (link.startsWith('//')) return u.protocol + link;
    if (link.startsWith('/')) return u.origin + link;
    const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^\/]*$/,'/');
    return u.origin + basePath + link;
  } catch(e){ return link; }
}

/* ================== Listen ================== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));
