// medx-ingest-api/server.js
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

/* ================== Config via env ================== */
const RENDER_API_URL   = (process.env.RENDER_API_URL || "").trim(); // e.g. https://medx-render-api.onrender.com
const RENDER_API_TOKEN = (process.env.RENDER_API_TOKEN || "").trim(); // optional if renderer enforces auth
const MIN_IMG_PX_ENV   = parseInt(process.env.MIN_IMG_PX || "200", 10); // width/height inferred from URL hints
const EXCLUDE_PNG_ENV  = String(process.env.EXCLUDE_PNG || "false").toLowerCase() === "true"; // drop pngs (often logos)

/* ================== App setup ================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/* ================== Ingest route ================== */
/**
 * GET /ingest?url=<https://...>&selector=.css&wait=ms&timeout=ms&mode=fast|full&minpx=200&excludepng=true
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

    const selector   = req.query.selector ? `&selector=${encodeURIComponent(String(req.query.selector))}` : "";
    const wait       = req.query.wait != null ? `&wait=${encodeURIComponent(String(req.query.wait))}` : "";
    const timeout    = req.query.timeout != null ? `&timeout=${encodeURIComponent(String(req.query.timeout))}` : "";
    const mode       = req.query.mode ? `&mode=${encodeURIComponent(String(req.query.mode))}` : "&mode=fast";

    // Per-request knobs
    const minImgPx   = Number.isFinite(parseInt(String(req.query.minpx),10)) ? parseInt(String(req.query.minpx),10) : MIN_IMG_PX_ENV;
    const excludePng = typeof req.query.excludepng !== "undefined"
      ? String(req.query.excludepng).toLowerCase() === "true"
      : EXCLUDE_PNG_ENV;

    const endpoint = `${RENDER_API_URL.replace(/\/+$/,"")}/render?url=${encodeURIComponent(targetUrl)}${selector}${wait}${timeout}${mode}`;
    const headers = { "User-Agent": "MedicalExIngest/1.4" };
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

    const norm = extractNormalized(targetUrl, html, { minImgPx, excludePng });
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
function extractNormalized(baseUrl, html, opts) {
  const $ = cheerio.load(html);

  const jsonld = extractJsonLd($);
  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content")
        || $('meta[property="og:image:secure_url"]').attr("content")
        || ""
  };

  // Name
  const name = cleanup(jsonld.name || og.title || $("h1").first().text());

  // Brand
  let brand = cleanup(jsonld.brand || "");
  if (!brand) brand = inferBrandFromName(name);

  // Description (mine tab panes too)
  const description_raw = cleanup(
    jsonld.description ||
    pickBestDescriptionBlock($) ||
    og.description ||
    $('meta[name="description"]').attr("content") ||
    ""
  );

  const images   = extractImages($, jsonld, og, baseUrl, name, html, opts);
  const manuals  = extractManuals($, baseUrl, name, html);
  const specs    = Object.keys(jsonld.specs || {}).length ? jsonld.specs : extractSpecsSmart($);
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
  // Images may be string, array of strings, or array of ImageObject
  const images = (() => {
    const img = p.image;
    if (!img) return [];
    if (Array.isArray(img)) {
      return img.map(v => (typeof v === 'string' ? v : (v.url || v.contentUrl || v['@id'] || ''))).filter(Boolean);
    }
    if (typeof img === 'object') return [img.url || img.contentUrl || img['@id']].filter(Boolean);
    if (typeof img === 'string') return [img];
    return [];
  })();

  return {
    name: p.name || '',
    description: p.description || '',
    brand: (p.brand && (p.brand.name || p.brand)) || '',
    specs: schemaPropsToSpecs(p.additionalProperty || p.additionalProperties || []),
    features: Array.isArray(p.featureList) ? p.featureList : [],
    images
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

/* === Description block (also reads tab panes / accordions) === */
function pickBestDescriptionBlock($){
  const candidates = [
    '[itemprop="description"]',
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description',
    '.tab-content, .tabs-content, [role="tabpanel"], .accordion-content, .product-tabs'
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

/* === IMAGE EXTRACTION & SCORING (gallery-first, scripts JSON, min-px, cap 12) === */
function extractImages($, jsonld, og, baseUrl, name, rawHtml, opts){
  const minPx = (opts && opts.minImgPx) || MIN_IMG_PX_ENV;
  const excludePng = (opts && typeof opts.excludePng === 'boolean') ? opts.excludePng : EXCLUDE_PNG_ENV;

  const set = new Set();
  const imgWeights = new Map(); // boost gallery/media finds
  const push = (u, weight = 0) => {
    if (!u) return;
    const absu = abs(baseUrl, u);
    if (!absu) return;
    if (!imgWeights.has(absu)) imgWeights.set(absu, 0);
    imgWeights.set(absu, Math.max(imgWeights.get(absu), weight));
    set.add(absu);
  };

  // 1) Gallery/media containers get priority
  const gallerySelectors = [
    '.product-media', '.product__media', '.product-gallery', '.gallery', '.media-gallery',
    '#product-gallery', '#gallery', '[data-gallery]', '.product-images', '.product-image-gallery',
    '.pdp-gallery', '.slick-slider', '.slick', '.swiper', '.swiper-container', '.carousel', '.owl-carousel',
    '.fotorama', '.MagicZoom', '.cloudzoom-zoom', '.zoomWindow', '.zoomContainer', '.lightbox', '.thumbnails'
  ].join(', ');
  $(gallerySelectors).find('img, source').each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr('src'),
      $el.attr('data-src'),
      $el.attr('data-srcset'),
      $el.attr('data-original'),
      $el.attr('data-large_image'),
      $el.attr('data-image'),
      $el.attr('data-zoom'),
      pickLargestFromSrcset($el.attr('srcset')),
    ];
    cands.forEach(u => push(u, 3));
  });

  // 2) JSON-LD & OG
  (jsonld.images || []).forEach(u => push(u, 2));
  if (og.image) push(og.image, 2);

  // 3) <img> + lazy attrs + srcset everywhere
  $("img").each((_, el) => {
    const $el = $(el);
    const cands = [
      $el.attr("src"),
      $el.attr("data-src"),
      $el.attr("data-srcset"),
      $el.attr("data-original"),
      $el.attr("data-lazy"),
      $el.attr("data-zoom-image"),
      $el.attr("data-large_image"),
      $el.attr("data-image"),
      pickLargestFromSrcset($el.attr("srcset")),
    ];
    cands.forEach(u => push(u, 1));
  });

  // 4) <picture><source srcset>
  $("picture source[srcset]").each((_, el) => {
    push(pickLargestFromSrcset($(el).attr("srcset")), 1);
  });

  // 5) Inline background-image
  $('[style*="background"]').each((_, el) => {
    const style = String($(el).attr("style") || "");
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(m[2], 1);
  });

  // 6) link rel=image_src
  $('link[rel="image_src"]').each((_, el) => push($(el).attr("href"), 1));

  // 7) JSON buried in <script> (non-JSON-LD): mine gallery/media/image fields
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

  // 8) Regex sweep in full HTML as last resort
  if (rawHtml) {
    const re = /(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m; while ((m = re.exec(rawHtml))) push(m[1], 0);
  }

  // Normalize + filter
  let arr = Array.from(set).filter(Boolean).map(u => decodeHtml(u));

  // extension rules
  const allowWebExt = excludePng
    ? /\.(?:jpe?g|webp)(?:[?#].*)?$/i
    : /\.(?:jpe?g|png|webp)(?:[?#].*)?$/i;

  // drop non-product assets (social/icons/sprites/placeholders)
  const badRe = new RegExp([
    'logo','brandmark','favicon','sprite','placeholder','no-?image','missingimage','loader','ajax-loader',
    'spinner','icon','badge','flag','cart','arrow','pdf','facebook','twitter','instagram','linkedin',
    '\\/wcm\\/connect','/common/images/','/icons/','/social/','/share/','/static/','/cms/','/ui/'
  ].join('|'), 'i');

  // Minimum pixel hint (inferred from filename or query params)
  arr = arr
    .filter(u => allowWebExt.test(u))
    .filter(u => !badRe.test(u))
    .filter(u => {
      const { w, h } = inferSizeFromUrl(u);
      if (!w && !h) return true; // keep if unknown
      const maxDim = Math.max(w || 0, h || 0);
      return maxDim >= minPx;
    });

  // Scoring: gallery weight + producty paths + code/title hits; downweight thumbs
  const titleTokens = (name || "").toLowerCase().split(/\s+/).filter(Boolean);
  const codeCandidates = collectCodesFromUrl(baseUrl);

  const preferRe = /(\/media\/images\/items\/|\/images\/(products?|catalog)\/|\/products?\/|\/product\/|\/pdp\/|\/assets\/product|\/product-images?\/|\/commerce\/products?\/|\/zoom\/|\/large\/|\/hi-res?\/)/i;

  const scored = arr.map(u => {
    const L = u.toLowerCase();
    let score = imgWeights.get(u) || 0;
    if (preferRe.test(L)) score += 3;
    if (codeCandidates.some(c => c && L.includes(c))) score += 3;
    if (titleTokens.some(t => t.length > 2 && L.includes(t))) score += 1;
    if (/thumb|thumbnail|small|tiny|badge|mini|icon/.test(L)) score -= 2;
    if (/(_\d{3,}x\d{3,}|-?\d{3,}x\d{3,}|(\?|&)(w|width|h|height|size)=\d{3,})/.test(L)) score += 1;
    return { url: u, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Dedup by filename (queryless); CAP = 12
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
    ['images','gallery','media','assets','pictures','variants','slides'].forEach(k=>{
      if (obj[k]) deepFindImagesFromJson(obj[k], out);
    });
    Object.values(obj).forEach(v => deepFindImagesFromJson(v, out));
  }
  return out;
}

/* === Manuals (IFU) — allowlist real manuals, block certifications; includes scripts === */
function extractManuals($, baseUrl, name, rawHtml){
  const urls = new Set();

  // Allow actual use docs; Block certifications & quality docs
  const allowRe = /(manual|ifu|instruction|instructions|user[- ]?guide|owner[- ]?manual|assembly|install|installation|setup|quick[- ]?start|spec(?:sheet)?|datasheet|guide)/i;
  const blockRe = /(iso|mdsap|ce(?:[-\s])?cert|certificate|quality\s+management|annex|audit|policy|regulatory|warranty)/i;

  const scopeSel = [
    '.product-details','.product-detail','.product-description','.product__info',
    '.tab-content','.tabs-content','[role="tabpanel"]','#tabs','main','#main','.main','#content','.content',
    '.downloads','.documents','.resources','.manuals','.product-resources','.product-documents'
  ].join(', ');
  const scope = $(scopeSel);

  // Anchors in PDP scope
  scope.find('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href = String($(el).attr("href")||"");
    const txt  = cleanup($(el).text()).toLowerCase();
    const full = abs(baseUrl, href);
    if (!full) return;
    const L = (txt + " " + full).toLowerCase();
    if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
  });

  // Second pass (global) if none in scope
  if (!urls.size) {
    $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
      const href=String($(el).attr("href")||"");
      const txt=cleanup($(el).text()).toLowerCase();
      const full=abs(baseUrl, href);
      if (!full) return;
      const L = (txt + " " + full).toLowerCase();
      if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
    });
  }

  // PDFs inside scripts/JSON blobs
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
      let m; while ((m = re.exec(txt))) {
        const full = abs(baseUrl, m[1]);
        if (!full) continue;
        const L = full.toLowerCase();
        if (allowRe.test(L) && !blockRe.test(L)) urls.add(full);
      }
    }
  });

  // Prefer product-specific: boost those with codes/title tokens (we'll keep all matches but this helps clients rank)
  const titleTokens = (name||"").toLowerCase().split(/\s+/).filter(Boolean);
  const codes = collectCodesFromUrl(baseUrl);
  const arr = Array.from(urls);

  // Soft sort: product-specific first
  arr.sort((a,b)=>{
    const A = a.toLowerCase(), B = b.toLowerCase();
    const as = (codes.some(c=>A.includes(c)) ? 2 : 0) + (titleTokens.some(t=>t.length>2 && A.includes(t)) ? 1 : 0);
    const bs = (codes.some(c=>B.includes(c)) ? 2 : 0) + (titleTokens.some(t=>t.length>2 && B.includes(t)) ? 1 : 0);
    return bs - as;
  });

  return arr;
}

function deepFindPdfsFromJson(obj, out = []){
  if (!obj) return out;
  if (typeof obj === 'string') {
    if (/\.pdf(?:[?#].*)?$/i.test(obj)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach(v => deepFindPdfsFromJson(v, out)); return out; }
  if (typeof obj === 'object') { Object.values(obj).forEach(v => deepFindPdfsFromJson(v, out)); }
  return out;
}

/* === Specs — tables + dl + key:value inside "Specifications/Details" tab === */
function extractSpecsSmart($){
  const out = {};

  // 1) Tables (favor th/td, but also td/td)
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

  // 2) dl pairs
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

  // 3) Named panes: Specifications / Details
  const specPane = resolveTabPane($, ['specification','specifications','tech specs','technical specifications','details']);
  if (specPane){
    const $p = $(specPane);

    // key:value lists
    $p.find('li').each((_, li)=>{
      const t = cleanup($(li).text());
      if (!t || t.length < 3 || t.length > 250) return;
      const m = t.split(/[:\-–]\s+/);
      if (m.length >= 2){
        const k = m[0].toLowerCase().replace(/\s+/g,'_');
        const v = m.slice(1).join(': ').trim();
        if (k && v && !out[k]) out[k]=v;
      }
    });

    // two-column styled divs/spans
    $p.find('.spec, .row, .grid, [class*="spec"]').each((_, r)=>{
      const a = cleanup($(r).find('.label, .name, .title, strong, b, th').first().text());
      const b = cleanup($(r).find('.value, .val, .data, td, span, p').last().text());
      if (a && b) out[a.toLowerCase().replace(/\s+/g,'_')] = b;
    });
  }

  return out;
}

/* === Features — from features containers/tabs; also split bullet paragraphs === */
function extractFeaturesSmart($){
  const items = [];
  const scopeSel = [
    '.features','.feature-list','.product-features','[data-features]',
    '.tab-content','.tabs-content','[role="tabpanel"]','#tabs','.accordion-content'
  ].join(', ');
  const excludeSel = [
    'nav','.breadcrumb','.breadcrumbs','[aria-label="breadcrumb"]',
    '.related','.upsell','.cross-sell','.menu','.footer','.header','.sidebar'
  ].join(', ');

  // Lists
  $(scopeSel).each((_, el)=>{
    const $el = $(el);
    if ($el.closest(excludeSel).length) return;
    $el.find('li').each((__, li)=>{
      const txt = cleanup($(li).text());
      if (txt && txt.length>6 && txt.length<220) items.push(txt);
    });
  });

  // Bullet-like paragraphs (•, ·, –)
  $(scopeSel).find('p').each((_, p)=>{
    const t = cleanup($(p).text());
    if (!t) return;
    if (/[•·–-]\s+/.test(t)) {
      t.split(/[•·–-]\s+/).map(s=>cleanup(s)).forEach(s=>{
        if (s && s.length>6 && s.length<220) items.push(s);
      });
    }
  });

  // Named "Features" pane
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
    if (out.length>=20) break; // allow a bit more if genuine features
  }
  return out;
}

/* === Resolve a tab button to its pane by text (Specifications, Features, Documents, etc.) === */
function resolveTabPane($, names){
  const nameRe = new RegExp(`^(?:${names.map(n=>escapeRe(n)).join('|')})$`, 'i');
  let pane = null;

  // 1) Buttons/links with href="#id" or aria-controls
  $('a,button').each((_, el)=>{
    const label = cleanup($(el).text());
    if (!label || !nameRe.test(label)) return;
    const href = $(el).attr('href') || '';
    const controls = $(el).attr('aria-controls') || '';
    let target = null;
    if (href && href.startsWith('#')) target = $(href)[0];
    if (!target && controls) target = documentQueryById($, controls);
    if (target) { pane = target; return false; }
  });

  // 2) Panels whose heading matches
  if (!pane){
    $('[role="tabpanel"], .tab-pane, .panel, .tabs-content, .accordion-content').each((_, el)=>{
      const heading = cleanup($(el).find('h2,h3,h4').first().text());
      if (heading && nameRe.test(heading)) { pane = el; return false; }
    });
  }

  // 3) Sections with class names containing target words
  if (!pane){
    const classRe = new RegExp(names.map(n=>escapeRe(n)).join('|'), 'i');
    $('[class]').each((_, el)=>{
      if (classRe.test($(el).attr('class')||'')) { pane = el; return false; }
    });
  }
  return pane;
}

/* ================== Utils ================== */
function collectCodesFromUrl(url){
  const out = [];
  const u = url.toLowerCase();
  const m1 = /\/item\/([^\/?#]+)/i.exec(u);
  const m2 = /\/p\/([a-z0-9._-]+)/i.exec(u);
  const m3 = /\/product\/([a-z0-9._-]+)/i.exec(u);
  [m1, m2, m3].forEach(m => { if (m && m[1]) out.push(m[1]); });
  return out;
}

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
    if (link.startsWith('/'))  return u.origin + link;
    const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^\/]*$/,'/');
    return u.origin + basePath + link;
  } catch(e){ return link; }
}

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

    let m = fn.match(/(?:_|-)(\d{2,5})x(\d{2,5})/); if (m) { out.w = +m[1]; out.h = +m[2]; return out; }
    m = fn.match(/(?:_|-)(\d{2,5})x/);             if (m) { out.w = +m[1]; return out; }
    m = fn.match(/(\d{2,5})x(\d{2,5})/);           if (m) { out.w = +m[1]; out.h = +m[2]; return out; }

    const q = u.split("?")[1] || "";
    if (q) {
      const params = new URLSearchParams(q);
      const widthKeys  = ["w","width","maxwidth","mw","size"];
      const heightKeys = ["h","height","maxheight","mh"];
      widthKeys.forEach(k => { const v = params.get(k);  if (v && /^\d{2,5}$/.test(v)) out.w = Math.max(out.w, parseInt(v,10)); });
      heightKeys.forEach(k=> { const v = params.get(k);  if (v && /^\d{2,5}$/.test(v)) out.h = Math.max(out.h, parseInt(v,10)); });
    }
    return out;
  } catch { return { w: 0, h: 0 }; }
}

/* ================== Listen ================== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));
