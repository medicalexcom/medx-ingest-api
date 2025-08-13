// medx-ingest-api: calls medx-render-api, extracts normalized product JSON
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Set these in Render env for this service:
const RENDER_API_URL = process.env.RENDER_API_URL || "";     // e.g. https://your-render-api.onrender.com
const RENDER_API_TOKEN = process.env.RENDER_API_TOKEN || ""; // must match AUTH_TOKEN if set on render-api

app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/**
 * GET /ingest?url=<https://...>
 * Returns: { name_raw, description_raw, specs, features_raw, images[], manuals[], brand, source }
 */
app.get("/ingest", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!url) return res.status(400).json({ error: "Missing url param" });
    if (!RENDER_API_URL) return res.status(500).json({ error: "RENDER_API_URL not set" });

    const endpoint = `${RENDER_API_URL.replace(/\/+$/,"")}/render?url=${encodeURIComponent(url)}`;
    const headers = { "User-Agent": "MedicalExIngest/1.0" };
    if (RENDER_API_TOKEN) headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;

    const r = await fetch(endpoint, { headers, timeout: 60000 });
    if (!r.ok) {
      const txt = await r.text().catch(()=> "");
      return res.status(502).json({ error: `Render API ${r.status}`, body: txt.slice(0,300) });
    }
    const html = await r.text();
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

/* ------------------ extractors ------------------ */
function extractNormalized(baseUrl, html) {
  const $ = cheerio.load(html);
  const jsonld = extractJsonLd($);
  const og = {
    title: $('meta[property="og:title"]').attr("content") || "",
    description: $('meta[property="og:description"]').attr("content") || "",
    image: $('meta[property="og:image"]').attr("content") || ""
  };
  const name = jsonld.name || og.title || $("h1").first().text().trim() || "";
  const desc = jsonld.description || og.description || $('meta[name="description"]').attr("content") || "";
  const images = extractImages($, jsonld, og, baseUrl);
  const manuals = extractManuals($, baseUrl);
  const specs = jsonld.specs || extractSpecTable($);
  const features = jsonld.features || extractFeatureList($);
  const brand = jsonld.brand || "";
  return { source: baseUrl, name_raw: cleanup(name), description_raw: cleanup(desc), specs, features_raw: features, images, manuals, brand };
}

function extractJsonLd($){
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).contents().text());
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
function schemaPropsToSpecs(props){ const out={}; try{ props.forEach(p=>{ const k=(p.name||p.property||'').toString().trim().toLowerCase().replace(/\s+/g,'_'); const v=(p.value||p['@value']||p.description||'').toString().trim(); if(k&&v) out[k]=v; }); }catch{} return out; }
function extractImages($, jsonld, og, baseUrl){
  const set = new Set();
  (jsonld.images||[]).forEach(u=> set.add(abs(baseUrl,u)));
  if (og.image) set.add(abs(baseUrl, og.image));
  $("img[src]").each((_, el)=> set.add(abs(baseUrl, $(el).attr("src")||"")));
  return Array.from(set).map(u=>({url:u}));
}
function extractManuals($, baseUrl){
  const urls=new Set();
  $('a[href$=".pdf"], a[href*=".pdf"]').each((_, el)=>{
    const href=String($(el).attr("href")||"");
    const text=(($(el).text())||"").toLowerCase();
    if (/manual|ifu|instruction|spec|datasheet|guide/.test(text) || href.toLowerCase().includes(".pdf")) urls.add(abs(baseUrl, href));
  });
  return Array.from(urls);
}
function extractSpecTable($){
  const out={};
  $("tr").each((_, tr)=>{
    const tds=$(tr).find("th,td");
    if (tds.length>=2){
      const k=cleanup($(tds[0]).text()).toLowerCase().replace(/\s+/g,'_');
      const v=cleanup($(tds[1]).text());
      if (k && v && k.length<60 && v.length<200) out[k]=v;
    }
  });
  return out;
}
function extractFeatureList($){
  const items=[];
  $("li").each((_, li)=>{
    const txt=cleanup($(li).text());
    if (txt && txt.length>6 && txt.length<200) items.push(txt);
  });
  return items.slice(0,12);
}

/* ------------------ utils ------------------ */
function cleanup(s){ return String(s||"").replace(/\s+/g," ").trim(); }
function abs(base, link){
  try{
    if (!link) return link;
    if (/^https?:\/\//i.test(link)) return link;
    const u=new URL(base);
    if (link.startsWith("//")) return u.protocol + link;
    if (link.startsWith("/")) return u.origin + link;
    const basePath = u.pathname.endsWith("/") ? u.pathname : u.pathname.replace(/\/[^\/]*$/,"/");
    return u.origin + basePath + link;
  }catch{ return link; }
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));
