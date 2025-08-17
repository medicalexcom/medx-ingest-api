/* medx-ingest-api/server.js */

import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

import {
  RENDER_API_URL,
  RENDER_API_TOKEN,
  MIN_IMG_PX_ENV,
  EXCLUDE_PNG_ENV,
  DEFAULT_RENDER_TIMEOUT_MS,
  MAX_TOTAL_TIMEOUT_MS,
  MAX_HTML_BYTES,
  CACHE_TTL_MS,
  CACHE_MAX_ITEMS,
  ENABLE_CACHE,
  ENABLE_BASIC_SSRF_GUARD,
} from "./src/config.js";

import {
  cid,
  now,
  sleep,
  safeDecodeOnce,
  cleanup,
  decodeHtml,
  isHttpUrl,
  safeHostname,
  isLikelyDangerousHost,
} from "./src/utils.js";

import { cacheGet, cacheSet } from "./src/cache.js";
import { fetchWithRetry, fetchDirectHtml } from "./src/fetchers.js";
import { extractNormalized } from "./src/extract.js";
import { augmentFromTabs } from "./src/tabs.js";
import {
  isCompass,
  harvestCompassOverview,
  harvestCompassSpecs,
} from "./src/compass.js";
import { enrichSpecsWithDerived } from "./src/specs.js";
import {
  extractDescriptionMarkdown,
  textToMarkdown,
  objectToMarkdownTable,
} from "./src/markdown.js";

/* ================== App setup ================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.type("text").send("ingest-api OK"));
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
    if (!isHttpUrl(targetUrl))
      return res.status(400).json({ error: "Invalid url param" });

    const host = safeHostname(targetUrl);
    if (ENABLE_BASIC_SSRF_GUARD && isLikelyDangerousHost(host)) {
      return res.status(400).json({ error: "Blocked host" });
    }

    if (!RENDER_API_URL)
      return res.status(500).json({ error: "RENDER_API_URL not set" });

    const selector =
      req.query.selector
        ? `&selector=${encodeURIComponent(String(req.query.selector))}`
        : "";
    const wait =
      req.query.wait != null
        ? `&wait=${encodeURIComponent(String(req.query.wait))}`
        : "";
    const timeout =
      req.query.timeout != null
        ? `&timeout=${encodeURIComponent(String(req.query.timeout))}`
        : "";
    const mode = req.query.mode
      ? `&mode=${encodeURIComponent(String(req.query.mode))}`
      : "&mode=fast";

    const minImgPx = Number.isFinite(parseInt(String(req.query.minpx), 10))
      ? parseInt(String(req.query.minpx), 10)
      : MIN_IMG_PX_ENV;
    const excludePng =
      typeof req.query.excludepng !== "undefined"
        ? String(req.query.excludepng).toLowerCase() === "true"
        : EXCLUDE_PNG_ENV;

    const aggressive =
      String(req.query.aggressive || "false").toLowerCase() === "true";
    const doSanitize =
      String(req.query.sanitize || "false").toLowerCase() === "true";
    const doHarvest =
      String(req.query.harvest || "false").toLowerCase() === "true";
    const wantMd =
      String(req.query.markdown || "false").toLowerCase() === "true";
    const mainOnly =
      String(req.query.mainonly || "false").toLowerCase() === "true";

    const endpoint = `${RENDER_API_URL.replace(
      /\/+$/,
      ""
    )}/render?url=${encodeURIComponent(targetUrl)}${selector}${wait}${timeout}${mode}`;

    const headers = { "User-Agent": "MedicalExIngest/1.7" };
    if (RENDER_API_TOKEN)
      headers["Authorization"] = `Bearer ${RENDER_API_TOKEN}`;

    const cacheKey = `render:${endpoint}`;
    let html = cacheGet(cacheKey);
    let fetched = false;

    if (!html) {
      const t0 = now();
      let rendered = "";
      try {
        const r = await fetchWithRetry(endpoint, {
          headers,
          timeoutMs: DEFAULT_RENDER_TIMEOUT_MS,
        });
        rendered = r.html;
      } catch (e) {
        const status = e && e.status ? Number(e.status) : 0;
        if (status === 502 || status === 503 || status === 504) {
          diag.warnings.push(
            `render-upstream-${status}; falling back to direct fetch`
          );
          try {
            rendered = await fetchDirectHtml(targetUrl, {
              headers,
              timeoutMs: DEFAULT_RENDER_TIMEOUT_MS,
            });
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
    let norm = extractNormalized(targetUrl, html, {
      minImgPx,
      excludePng,
      aggressive,
      diag,
      mainOnly,
    });
    diag.timings.extractMs = now() - t1;

    if (!norm.name_raw && (!norm.description_raw || norm.description_raw.length < 10)) {
      return res
        .status(422)
        .json({ error: "No extractable product data (JSON-LD/DOM empty)." });
    }

    if (doHarvest) {
      const t2 = now();
      norm = await augmentFromTabs(norm, targetUrl, html, {
        minImgPx,
        excludePng,
        mainOnly,
      });
      diag.timings.harvestMs = now() - t2;
    }

    // Compass-only additive harvest
    if (isCompass(targetUrl)) {
      const $ = cheerio.load(html);
      try {
        const compassOverview = harvestCompassOverview($);
        if (compassOverview) {
          const seen = new Set(
            String(norm.description_raw || "")
              .split(/\n+/)
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
          );

          const merged = [];
          for (const l of String(norm.description_raw || "")
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean))
            merged.push(l);
          for (const l of String(compassOverview)
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean)) {
            const k = l.toLowerCase();
            if (!seen.has(k)) {
              merged.push(l);
              seen.add(k);
            }
          }
          norm.description_raw = merged.join("\n");
        }
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        diag.warnings.push(`compass-overview: ${msg}`);
      }

      try {
        const compassSpecs = harvestCompassSpecs($);
        if (Object.keys(compassSpecs).length) {
          norm.specs = { ...(norm.specs || {}), ...compassSpecs };
        }
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        diag.warnings.push(`compass-specs: ${msg}`);
      }
    }

    try {
      norm.specs = enrichSpecsWithDerived(norm.specs || {});
    } catch {}

    if (wantMd) {
      const $ = cheerio.load(html);
      try {
        norm.description_md =
          extractDescriptionMarkdown($) ||
          textToMarkdown(norm.description_raw || "");
      } catch (e) {
        diag.warnings.push(`desc-md: ${e.message || e}`);
      }

      try {
        norm.features_md = (norm.features_raw || [])
          .map((t) => `- ${t}`)
          .join("\n");
      } catch (e) {}
      try {
        norm.specs_md = objectToMarkdownTable(norm.specs || {});
      } catch (e) {}
    }

    if (doSanitize) {
      const { sanitizeIngestPayload } = await import("./src/extract.js"); // exported there unchanged
      norm = sanitizeIngestPayload(norm);
      if (wantMd) {
        norm.features_md = (norm.features_raw || [])
          .map((t) => `- ${t}`)
          .join("\n");
        norm.specs_md = objectToMarkdownTable(norm.specs || {});
        if (!norm.description_md)
          norm.description_md = textToMarkdown(norm.description_raw || "");
      }
    }

    const totalMs = now() - started;
    if (totalMs > MAX_TOTAL_TIMEOUT_MS) {
      diag.warnings.push(`total-timeout ${totalMs}ms`);
    }

    if (debug) return res.json({ ...norm, _debug: { ...diag, fetched } });
    return res.json(norm);
  } catch (e) {
    console.error("INGEST ERROR:", e);
    const status =
      e && e.status && Number.isFinite(+e.status) ? Number(e.status) : 500;
    return res
      .status(status >= 400 && status <= 599 ? status : 500)
      .json({ error: String((e && e.message) || e) });
  }
});

/* ================== Listen ================== */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`ingest-api listening on :${port}`));
