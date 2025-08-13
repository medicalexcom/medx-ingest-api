// medx-ingest-api/server.js
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

/* ================== Config via env ================== */
const RENDER_API_URL = (process.env.RENDER_API_URL || "").trim(); // e.g. https://medx-render-api.onrender.com
const RENDER_API_TOKEN = (process.env.RENDER_API_TOKEN || "").trim(); // optional if renderer enforces auth

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
  const manuals = extractManuals($, baseUrl);
  const specs = Object.keys(jsonld.specs || {}).length ? jsonld.specs : extractSpecTable($);
  const features = jsonld.features && jsonld.features.length ? jsonld.features : extractFeatureList($);

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

function pickBestDescriptionBlock($){
  // Common product description containers + tab panes
  const candidates = [
    '[itemprop="description"]',
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy, .product__description',
    '.tab-content, .tabs-content, .panel, [role="tabpanel"], #tabs'
  ].join(', ');

  let text = "";
  $(candidates).each((_, el) => {
    // concatenate paragraphs within a candidate for richer text
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

function inferBrandFromName(name){
  const first = (name || "").split(/\s+/)[0] || "";
  if (/^(the|a|an|pro|basic|probasic|shower|chair|with|and|for)$/i.test(first)) return "";
  if (/^[A-Z][A-Za-z0-9\-]+$/.test(first)) return first;
  return "";
}

/* === IMAGE EXTRACTION & SCORING (handles lazy + regex sweep + filters junk) === */
function extractImages($, jsonld, og, baseUrl, name, rawHtml){
  const set = new Set();
  const push = (u)=> { if (u) set.add(abs(baseUrl,u)); };

  // JSON-LD & OG
  (jsonld.images||[]).forEach(push);
  push(og.image);

  // <img> attrs (src, data-src, data-zoom-image, srcset)
  $("img").each((_, el)=>{
    const $el = $(el);
    const cands = [
      $el.attr("src"),
      $el.attr("data-src"),
      $el.attr("data-zoom-image"),
      pickFirstFromSrcset($el.attr("srcset")),
    ];
    cands.forEach(push);
  });

  // <picture><source srcset>
  $("picture source[srcset]").each((_, el)=>{
    push(pickFirstFromSrcset($(el).attr("srcset")));
  });

  // background-image in inline styles
  $('[style*="background"]').each((_, el)=>{
    const style = String($(el).attr("style") || "");
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (m && m[2]) push(m[2]);
  });

  // link rel=image_src (old pattern)
  $('link[rel="image_src"]').each((_, el)=> push($(el).attr("href")));

  // Regex sweep for compass-style asset paths in raw HTML
  if (rawHtml && /\/media\/images\/items\//i.test(rawHtml)) {
    const re = /(https?:\/\/[^\s"'<>]+\/media\/images\/items\/[^\s"'<>]+?\.(?:jpe?g|png|webp))(?:\?[^"'<>]*)?/ig;
    let m;
    while ((m = re.exec(rawHtml))) push(m[1]);
  }

  // Decode, filter junk
  let arr = Array.from(set)
    .filter(Boolean)
    .map(u => decodeHtml(u));

  const badRe = /(logo|badge|sprite|placeholder|loader|ajax-loader|spinner|icon|data:image|\/wcm\/connect|noimage)/i;
  const okExt = /\.(jpe?g|png|webp)(\?|#|$)/i;

  arr = arr
    .filter(u => !badRe.test(u))
    .filter(u => okExt.test(u));

  // Scoring: prefer product-like paths and matching tokens/codes
  const titleTokens = (name||"").toLowerCase().split(/\s+/).filter(Boolean);
  const codeGuess = guessProductCodeFromUrl(baseUrl); // e.g., BSCWB

  const preferRe = /(\/media\/images\/items\/|\/products?\/|\/product\/|\/images\/products?\/)/i;

  const scored = arr.map(u => {
    const L = u.toLowerCase();
    let score = 0;
    if (preferRe.test(L)) score += 3;
    if (codeGuess && L.includes(codeGuess.toLowerCase())) score += 3;
    if (titleTokens.some(t => L.includes(t))) score += 1;
    if (/thumb|small|tiny|icon|badge/.test(L)) score -= 1;
    if (/(_\d{3,}x\d{3,}|-?1200x|\/large\/|\/hi(res)?\/)/.test(L)) score += 1;
    return { url: u, score };
  });

  scored.sort((a,b)=> b.score - a.score);

  // Dedup by filename
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const base = s.url.split('/').pop().split('?')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url: s.url });
    if (out.length >= 8) break;
  }
  return out;
}

function pickFirstFromSrcset(srcset){
  if (!srcset) return "";
  const parts = String(srcset).split(",").map(s=>s.trim().split(/\s+/)[0]).filter(Boolean);
  return parts[0] || "";
}

function guessProductCodeFromUrl(url){
  try {
    const m = /\/item\/([^\/?#]+)/i.exec(url);
    return m ? m[1] : "";
  } catch { return ""; }
}

function extractManuals($, baseUrl){
  const urls=new Set();
  $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href=String($(el).attr("href")||"");
    const text=(($(el).text())||"").toLowerCase();
    if (/manual|ifu|instruction|spec|datasheet|guide|user|owner|warranty/i.test(text) || href.toLowerCase().includes(".pdf")) {
      urls.add(abs(baseUrl, href));
    }
  });
  return Array.from(urls);
}

function extractSpecTable($){
  const out={};
  $("table").each((_, tbl)=>{
    $(tbl).find("tr").each((__, tr)=>{
      const cells=$(tr).find("th,td");
      if (cells.length>=2){
        const k=cleanup($(cells[0]).text()).toLowerCase().replace(/\s+/g,'_');
        const v=cleanup($(cells[1]).text());
        if (k && v && k.length<60 && v.length<300) out[k]=v;
      }
    });
  });
  $("dl").each((_, dl)=>{
    const dts=$(dl).find("dt"), dds=$(dl).find("dd");
    if (dts.length === dds.length && dts.length){
      for (let i=0;i<dts.length;i++){
        const k=cleanup($(dts[i]).text()).toLowerCase().replace(/\s+/g,'_');
        const v=cleanup($(dds[i]).text());
        if (k && v && k.length<60 && v.length<300) out[k]=v;
      }
    }
  });
  return out;
}

function extractFeatureList($){
  const items=[];
  const areas = ['.features, .feature-list, ul.features, .bullet, .bullets', 'ul, ol', '.tab-content, .tabs-content'].join(', ');
  $(areas).each((_, el)=>{
    $(el).find('li').each((__, li)=>{
      const txt=cleanup($(li).text());
      if (txt && txt.length>6 && txt.length<200) items.push(txt);
    });
  });
  const seen = new Set(); const out=[];
  for (const t of items){
    const key=t.toLowerCase();
    if (!seen.has(key)){ seen.add(key); out.push(t); }
    if (out.length>=12) break;
  }
  return out;
}

/* ================== Utils ================== */
function safeDecodeOnce(s){
  try {
    // If it's already raw, decodeURIComponent will return the same string (no %)
    // If it's encoded, this will properly decode it (once).
    const decoded = decodeURIComponent(s);
    // Guard: if decoding introduced illegal chars, fall back
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
