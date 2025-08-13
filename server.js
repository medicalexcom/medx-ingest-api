// medx-ingest-api/server.js
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

// ---- Config via env ----
const RENDER_API_URL = (process.env.RENDER_API_URL || "").trim(); // e.g. https://medx-render-api.onrender.com
const RENDER_API_TOKEN = (process.env.RENDER_API_TOKEN || "").trim(); // optional, only if renderer requires AUTH

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health
app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/**
 * GET /ingest?url=<https://...>&selector=.css&wait=ms&timeout=ms&mode=fast|full
 * - Calls medx-render-api to fetch rendered HTML, then normalizes product data
 */
app.get("/ingest", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Missing or invalid url param" });
    if (!RENDER_API_URL) return res.status(500).json({ error: "RENDER_API_URL not set" });

    // Optional passthroughs for renderer
    const selector = req.query.selector ? `&selector=${encodeURIComponent(String(req.query.selector))}` : "";
    const wait = req.query.wait != null ? `&wait=${encodeURIComponent(String(req.query.wait))}` : "";
    const timeout = req.query.timeout != null ? `&timeout=${encodeURIComponent(String(req.query.timeout))}` : "";
    const mode = req.query.mode ? `&mode=${encodeURIComponent(String(req.query.mode))}` : "&mode=fast";

    const endpoint = `${RENDER_API_URL.replace(/\/+$/,"")}/render?url=${encodeURIComponent(url)}${selector}${wait}${timeout}${mode}`;
    const headers = { "User-Agent": "MedicalExIngest/1.0" };
    if (RENDER_API_TOKEN) headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;

    // Retry renderer 3x (handles cold starts & flaky nav)
    let html = null, lastStatus = 0, lastBody = "";
    for (let i = 1, delay = 800; i <= 3; i++, delay = Math.floor(delay * 1.7)) {
      try {
        const r = await fetch(endpoint, { headers, // Node 18+/20+ global fetch
          // Abort after 120s on the network layer (renderer also has its own internal timeouts)
          // Render ignores signal without AbortController here; timeout mostly informational.
        });
        lastStatus = r.status;
        if (r.ok) {
          html = await r.text();
          break;
        } else {
          lastBody = (await r.text().catch(() => "")) || "";
          console.warn(`RENDER_API_ERROR attempt ${i}`, r.status, lastBody.slice(0, 200));
        }
      } catch (e) {
        lastBody = String(e);
        console.warn(`RENDER_API_FETCH_ERR attempt ${i}`, lastBody.slice(0, 200));
      }
      if (i < 3) await new Promise(s => setTimeout(s, delay));
    }

    if (!html) {
      return res.status(502).json({ error: "Render API failed", body: `status=${lastStatus} body=${lastBody.slice(0,300)}` });
    }

    const norm = extractNormalized(url, html);
    if (!norm.name_raw && (!norm.description_raw || norm.description_raw.length < 10)) {
      return res.status(422).json({ error: "No extractable product data (JSON-LD/DOM empty)." });
    }
    return res.json(norm);
  } catch (e) {
    console.error("INGEST ERROR:", e);
    return res.status(500).json({ error: String(e) });
  }
});

/* ------------------ Improved extractors ------------------ */
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

  // Description: prefer body content blocks
  const description_raw = cleanup(
    jsonld.description ||
    pickBestDescriptionBlock($) ||
    og.description ||
    $('meta[name="description"]').attr("content") ||
    ""
  );

  const images = extractImages($, jsonld, og, baseUrl, name);
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

/* Prefer content blocks near product detail */
function pickBestDescriptionBlock($){
  // Common product description containers
  const candidates = [
    '[itemprop="description"]',
    '.product-description, .long-description, .product-details, .product-detail, .description, .details, .copy'
  ].join(', ');

  let text = "";
  $(candidates).each((_, el) => {
    const t = cleanup($(el).text());
    if (t && t.length > text.length) text = t;
  });

  // Fallback: largest paragraph under main/content
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

/* Heuristic brand: first token if it looks like a brand */
function inferBrandFromName(name){
  const first = (name || "").split(/\s+/)[0] || "";
  if (/^(the|a|an|pro|basic|probasic|shower|chair|with|and|for)$/i.test(first)) return "";
  if (/^[A-Z][A-Za-z0-9\-]+$/.test(first)) return first; // TitleCase/CamelCase-ish
  return "";
}

/* Filter images: prefer product shots, drop logos/loaders/base64/gifs */
function extractImages($, jsonld, og, baseUrl, name){
  const set = new Set();
  const push = (u)=> { if (u) set.add(abs(baseUrl,u)); };

  (jsonld.images||[]).forEach(push);
  push(og.image);
  $("img[src]").each((_, el)=> push($(el).attr("src")));

  const titleTokens = (name||"").toLowerCase().split(/\s+/).filter(Boolean);

  const badRe = /(logo|badge|sprite|placeholder|loader|ajax-loader|spinner|icon|data:image|\/wcm\/connect)/i;
  const okExt = /\.(jpe?g|png|webp)(\?|#|$)/i;
  const preferRe = /(\/media\/images\/items\/|\/products?\/|\/product\/)/i;

  let arr = Array.from(set)
    .filter(Boolean)
    .map(u => decodeHtml(u))
    .filter(u => !badRe.test(u))
    .filter(u => okExt.test(u));

  // Prefer product-like paths + name tokens
  arr.sort((a,b)=>{
    const aw = (preferRe.test(a)?2:0) + (titleTokens.some(t=>a.toLowerCase().includes(t))?1:0);
    const bw = (preferRe.test(b)?2:0) + (titleTokens.some(t=>b.toLowerCase().includes(t))?1:0);
    return bw - aw;
  });

  // Dedup by basename
  const seen = new Set();
  const out = [];
  for (const u of arr) {
    const base = u.split('/').pop().split('?')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ url: u });
    if (out.length >= 8) break;
  }
  return out;
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
  // Table-based K/V
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
  // DL-based K/V
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
  const areas = ['.features, .feature-list, ul.features, .bullet, .bullets', 'ul, ol'].join(', ');
  $(areas).each((_, el)=>{
    $(el).find('li').each((__, li)=>{
      const txt=cleanup($(li).text());
      if (txt && txt.length>6 && txt.length<200) items.push(txt);
    });
  });
  // de-dup & cap
  const seen = new Set(); const out=[];
  for (const t of items){
    const key=t.toLowerCase();
    if (!seen.has(key)){ seen.add(key); out.push(t); }
    if (out.length>=12) break;
  }
  return out;
}

/* -------------------------- Utils --------------------------- */
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

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));
