// tools/render-engine/gptInstructionsEnforcer-3.mjs
// Lightweight augmentation of the original gptInstructionsEnforcer.mjs
// - Keeps original behavior intact but adds additional structural checks:
//   * Hook bullets count (3-6)
//   * Features: 2-4 H3 groups and 3-6 bullets total
//   * Why-Choose: lead paragraph + 3-6 bullets
//   * FAQs: 5-7 Q&As
//   * short_name_60 exact verbatim appearances <= 2
//   * duplicate H2/H3 title detection (e.g., duplicated "Product Specifications")
// - Designed as a minimal, resilient augmentation of the working baseline to avoid runtime crashes.

import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs";
import { validateStructuredResponse } from "./validators/structuredValidator.mjs";

const DEFAULTS = {
  TARGET_AUDIT_SCORE: 9.8,
  MAX_ATTEMPTS: 3,
  MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
  TEMPERATURE: 0.0,
  MAX_TOKENS: 3200
};

/* -------------------------- Utilities (unchanged base) -------------------------- */

function stripFences(s = "") {
  return (s || "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "");
}
function extractJsonCandidate(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  let t = rawText.trim();
  t = stripFences(t);
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const cand = t.slice(first, last + 1);
    try { return JSON.parse(cand); } catch (_) {}
  }
  try { return JSON.parse(t); } catch (_) {}
  return null;
}
function enforceEnDashAndFixEm(text = "") {
  return (text || "").replace(/\u2014/g, "–").replace(/---+/g, "–");
}
function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function pickShortNameFromH1(h1) {
  if (!h1) return "";
  const parts = String(h1).split("–").map(p => p.trim());
  if (parts.length > 0 && parts[0]) {
    const candidate = parts[0].slice(0, 60);
    const trimmed = candidate.replace(/\s+\S*$/, "");
    return trimmed || candidate;
  }
  const fallback = String(h1).slice(0, 60);
  return fallback.replace(/\s+\S*$/, "") || fallback;
}

/* ---------------------- Additional HTML helpers & checks ---------------------- */

function countHtmlListItems(html = "") {
  if (!html) return 0;
  const m = html.match(/<li\b/gi);
  return m ? m.length : 0;
}
function countH3Groups(html = "") {
  if (!html) return 0;
  const m = html.match(/<h3\b[^>]*>/gi);
  return m ? m.length : 0;
}
function extractH2Titles(html = "") {
  if (!html) return [];
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push((m[1] || "").trim());
  }
  return out;
}
function extractH3Titles(html = "") {
  if (!html) return [];
  const re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push((m[1] || "").trim());
  }
  return out;
}
function stripHtml(s = "") {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function countExactShortNameUsageAcross(parsed = {}, shortName = "") {
  if (!shortName) return 0;
  const fields = ["hook_html", "main_description_html", "features_html", "why_choose_html", "specs_html", "faq_html"];
  const joined = fields.map(f => parsed[f] || "").join(" ").toLowerCase();
  const s = shortName.toLowerCase();
  const re = new RegExp(`\\b${escapeRegExp(s)}\\b`, "gi");
  const m = joined.match(re);
  return m ? m.length : 0;
}
function findDuplicateTitles(h2s = [], h3s = []) {
  const dups = [];
  const map = new Map();
  h2s.forEach(t => {
    const k = (t || "").toLowerCase();
    if (!k) return;
    map.set(k, (map.get(k) || 0) + 1);
  });
  for (const [k, v] of map.entries()) {
    if (v > 1) dups.push({ type: "h2", title: k, count: v });
  }
  const map3 = new Map();
  h3s.forEach(t => {
    const k = (t || "").toLowerCase();
    if (!k) return;
    map3.set(k, (map3.get(k) || 0) + 1);
  });
  for (const [k, v] of map3.entries()) {
    if (v > 1) dups.push({ type: "h3", title: k, count: v });
  }
  return dups;
}

// keep the original bullet/spec formatting helpers (unchanged)
function fixBulletFormattingInHtml(html = "") {
  if (!html) return html;
  return html.replace(/<li>([\s\S]*?)<\/li>/gi, (m, inner) => {
    let s = (inner || "").trim();
    s = enforceEnDashAndFixEm(s);
    if (/<strong>.*?<\/strong>/.test(s) && /–/.test(s)) {
      return `<li>${s.replace(/\s*–\s*/g, " – ")}</li>`;
    }
    let parts = null;
    if (s.indexOf(" – ") !== -1) parts = s.split(" – ");
    else if (s.indexOf(" - ") !== -1) parts = s.split(" - ");
    else {
      const p = s.split(/[\.\,]\s+/);
      parts = [p[0], s.slice(p[0].length).replace(/^[\.,\s]+/, "")];
    }
    const label = (parts[0] || "").replace(/<\/?strong>/gi, "").trim();
    let rest = (parts[1] || "").trim();
    if (rest) rest = rest[0].toUpperCase() + rest.slice(1);
    if (rest && !/[\.!?]$/.test(rest)) rest += ".";
    return `<li><strong>${label}</strong> – ${rest}</li>`;
  });
}
function fixSpecsFormattingInHtml(html = "") {
  if (!html) return html;
  return html.replace(/<li>([\s\S]*?)<\/li>/gi, (m, inner) => {
    let s = (inner || "").trim();
    s = s.replace(/\s+/g, " ").trim();
    const idx = s.indexOf(":");
    if (idx !== -1) {
      const label = s.slice(0, idx).replace(/<\/?strong>/gi, "").trim();
      let value = s.slice(idx + 1).trim();
      value = value.replace(/^[\s–-]+/, "").trim();
      return `<li><strong>${label}</strong>: ${value}</li>`;
    }
    if (/<strong>.*<\/strong>/i.test(s)) {
      return `<li>${s}</li>`;
    }
    return `<li><strong>${s}</strong>:</li>`;
  });
}

/* -------------------- Assemble structured -> description (unchanged) -------------------- */

function assembleDescriptionFromStructured(parsed = {}) {
  const parts = [];

  if (parsed.hook_html) parts.push(parsed.hook_html);

  if (parsed.main_description_title) parts.push(`<h2>${parsed.main_description_title}</h2>`);
  if (parsed.main_description_html) parts.push(parsed.main_description_html);

  if (parsed.features_html) {
    parts.push(`<h2>Features and Benefits</h2>`);
    parts.push(parsed.features_html);
  }

  if (parsed.specs_html) {
    const fixed = fixSpecsFormattingInHtml(parsed.specs_html);
    parts.push(`<h2>Product Specifications</h2>`);
    parts.push(fixed);
  }

  if (Array.isArray(parsed.internal_links) && parsed.internal_links.length) {
    const linksHtml = parsed.internal_links.map(l => {
      const anchor = l.anchor || (l.type ? `See all ${l.type}` : "See more");
      const url = l.url || "#";
      return `<a href="${url}">${anchor}</a>`;
    }).join(" | ");
    parts.push(`<h2>Internal Links</h2>`);
    parts.push(`<p class="explore-links"><strong>Explore More:</strong> ${linksHtml}</p>`);
  } else if (parsed.internal_links_html) {
    parts.push(`<h2>Internal Links</h2>`);
    parts.push(parsed.internal_links_html);
  }

  const whyTitle = parsed.why_choose_title || "Why Choose";
  if (parsed.why_choose_html) {
    parts.push(`<h2>${whyTitle}</h2>`);
    parts.push(parsed.why_choose_html);
  }

  if (parsed.manuals_html) {
    parts.push(`<h2>Manuals and Troubleshooting Guides</h2>`);
    parts.push(parsed.manuals_html);
  } else if (Array.isArray(parsed.manuals) && parsed.manuals.length) {
    parts.push(`<h2>Manuals and Troubleshooting Guides</h2>`);
    if (parsed.manuals.length === 1) {
      const m = parsed.manuals[0];
      parts.push(`<p><a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.text || m.title || m.url}</a></p>`);
    } else {
      const list = parsed.manuals.map(m => `<li><a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.text || m.title || m.url}</a></li>`).join("");
      parts.push(`<ul>${list}</ul>`);
    }
  }

  if (parsed.faq_html) {
    parts.push(`<h2>Frequently Asked Questions</h2>`);
    parts.push(parsed.faq_html);
  } else if (Array.isArray(parsed.faqs) && parsed.faqs.length) {
    parts.push(`<h2>Frequently Asked Questions</h2>`);
    const faqParts = parsed.faqs.map(q => `<h3>${q.q}</h3>\n<p>${q.a}</p>`).join("\n");
    parts.push(faqParts);
  }

  return parts.filter(Boolean).join("\n\n");
}

/* -------------------- OpenAI wrapper (unchanged) -------------------- */

async function callOpenAI(openAiKey, messages, model = DEFAULTS.MODEL, temperature = DEFAULTS.TEMPERATURE, maxTokens = DEFAULTS.MAX_TOKENS) {
  const client = new OpenAI({ apiKey: openAiKey });
  const completion = await client.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  });
  return completion?.choices?.[0]?.message?.content ?? "";
}

/* -------------------- Main route mount (augmented checks) -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  console.log("gptEnforcer-3: mounting /describe (structured schema enforcement - augmented)");

  app.get("/healthz", (_, res) => res.json({ ok: true }));

  app.post("/describe", async (req, res) => {
    try {
      const rawHeader = (req.header("x-engine-key") || req.header("authorization") || "").toString();
      const key = rawHeader.toLowerCase().startsWith("bearer ") ? rawHeader.replace(/^Bearer\s+/i, "") : rawHeader;
      if (!key || key !== ENGINE_SECRET) return res.status(401).json({ error: "unauthorized: invalid engine key" });

      const body = req.body || {};
      const name = body.name || "Sample product";
      const shortDescription = body.shortDescription || "Short description";

      let finalPrompt = null;
      let promptEngineInfo = { usedBuildPrompt: false, buildError: null };

      try {
        const loaderPath = path.resolve(process.cwd(), "tools/render-engine/utils/buildPrompt.mjs");
        if (fs.existsSync(loaderPath)) {
          const mod = await import(loaderPath);
          if (mod && typeof mod.buildPrompt === "function") {
            promptEngineInfo.usedBuildPrompt = true;
            finalPrompt = mod.buildPrompt("describe", {
              PRODUCT_NAME: name,
              SHORT_DESCRIPTION: shortDescription,
              BRAND: body.brand || "",
              FEATURES: Array.isArray(body.features) ? body.features.join("\n") : (body.features || ""),
              SPECS: JSON.stringify(body.specs || {}),
              MANUALS: (body.manuals || []).join("\n"),
              FORMAT: body.format || "avidia_standard",
              CATEGORY: body.category || ""
            });
          }
        }
      } catch (e) {
        promptEngineInfo.buildError = String(e?.message || e);
        console.warn("gptEnforcer-3: buildPrompt load failed:", promptEngineInfo.buildError);
      }

      if (!finalPrompt) {
        finalPrompt = `MASTER-FALLBACK: Return valid JSON only. REQUIRED structured top-level fields: hook_html, main_description_title, main_description_html, features_html, specs_html, why_choose_title, why_choose_html, faq_html or faqs, name_best, short_name_60, desc_audit. Use only INPUT grounding provided.`;
      }

      if (!OPENAI_KEY) {
        const mock = {
          hook_html: `<p><strong>${pickShortNameFromH1(name)}</strong> is designed for ...</p><ul><li><strong>Feature A</strong> – Benefit A.</li><li><strong>Feature B</strong> – Benefit B.</li><li><strong>Feature C</strong> – Benefit C.</li></ul>`,
          main_description_title: "Dynamic Main Description Title",
          main_description_html: `<p>Main description paragraph with buyer-outcome.</p>`,
          features_html: `<h3>Category A</h3><ul><li><strong>Feature A1</strong> – Function and benefit.</li></ul>`,
          specs_html: `<h3>Dimensions</h3><ul><li><strong>Capacity</strong>: 25 mL</li></ul>`,
          why_choose_title: "Why Choose This Product",
          why_choose_html: `<p>Lead paragraph describing benefits.</p><ul><li><strong>Durable</strong> – Built to last.</li></ul>`,
          faq_html: `<h3>Q1</h3><p>A1</p><h3>Q2</h3><p>A2</p><h3>Q3</h3><p>A3</p><h3>Q4</h3><p>A4</p><h3>Q5</h3><p>A5</p>`,
          name_best: name,
          short_name_60: pickShortNameFromH1(name),
          desc_audit: { score: 9.9, passed: true, violations: [] }
        };
        mock.description_html = assembleDescriptionFromStructured(mock);
        mock.descriptionHtml = mock.description_html;
        return res.json(mock);
      }

      const modelInput = {
        tenant_id: ((req.header("x-tenant-id") || null) || body.tenant_id || null),
        user_id: ((req.header("x-user-id") || null) || body.user_id || null),
        name,
        shortDescription,
        brand: body.brand || null,
        specs: body.specs || {},
        format: body.format || "avidia_standard",
        variants: body.variants || [],
        features: Array.isArray(body.features) ? body.features : (body.features ? [body.features] : []),
        pdf_manual_urls: body.pdf_manual_urls || body.manuals || []
      };

      const groundingInstruction = [
        "READ THESE INSTRUCTIONS CAREFULLY:",
        "1) INPUT JSON follows in the next message. Use ONLY the input data to produce customer-facing content.",
        "2) DO NOT INVENT product names, specs, weights, warranty terms, capacities, or other factual values.",
        "3) If a value is missing or ambiguous, OMIT that bullet and add the missing key to desc_audit.data_gaps.",
        "4) RETURN ONLY valid JSON matching the structured schema described in the system prompt. No commentary, no code fences."
      ].join("\n\n");

      async function callModel(userInstructions) {
        const messages = [
          { role: "system", content: finalPrompt },
          { role: "user", content: groundingInstruction },
          { role: "user", content: "INPUT:\n" + JSON.stringify(modelInput, null, 2) },
          { role: "user", content: userInstructions }
        ];
        return await callOpenAI(OPENAI_KEY, messages, OPENAI_MODEL, DEFAULTS.TEMPERATURE, DEFAULTS.MAX_TOKENS);
      }

      const primaryInstruction = [
        "RETURN ONLY valid JSON. DO NOT output any other text.",
        "You MUST return the required structured fields at the top level: hook_html, main_description_title, main_description_html, features_html, specs_html, why_choose_title, why_choose_html, faq_html or faqs, name_best, short_name_60, desc_audit.",
        "Do NOT return description_html-only. The server will assemble the final description_html from these structured fields.",
        "If any required item cannot be grounded from input, omit the specific bullet/line and list it under desc_audit.data_gaps.",
        "Use only the grounding INPUT provided below."
      ].join("\n\n");

      let attempt = 0;
      let lastModelText = "";
      let lastParsed = null;
      let lastViolations = [];
      let lastWarnings = [];

      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        try {
          lastModelText = await callModel(primaryInstruction);
        } catch (e) {
          lastModelText = "";
        }

        const parsed = (() => {
          try { return JSON.parse(lastModelText); } catch (_) { return extractJsonCandidate(lastModelText); }
        })();

        if (!parsed) {
          if (attempt < MAX_ATTEMPTS) {
            const repair = [
              "The previous output could not be parsed as valid JSON. RETURN ONLY valid JSON matching the required structured schema (no commentary).",
              "Required fields: hook_html, main_description_title, main_description_html, features_html, specs_html, why_choose_title, why_choose_html, faq_html or faqs, name_best, short_name_60, desc_audit.",
              "INPUT:",
              JSON.stringify(modelInput, null, 2)
            ].join("\n\n");
            try {
              lastModelText = await callModel(repair);
            } catch (e) { lastModelText = ""; }
            continue;
          } else {
            lastViolations = [{ section: "JSON", issue: "Model output could not be parsed as JSON", fix_hint: "Ensure the model returns a single JSON object with the required structured fields" }];
            break;
          }
        }

        // AJV schema validation
        const { valid, violations } = validateStructuredResponse(parsed);
        lastParsed = parsed;
        lastViolations = violations || [];

        // Additional structural & content checks (minimal, robust)
        if (valid) {
          const extra = [];

          try {
            // main_description_title presence + not equal to name_best
            if (!parsed.main_description_title || String(parsed.main_description_title).trim().length === 0) {
              extra.push({ section: "Structure", issue: "Missing main_description_title", fix_hint: "Provide a dynamic H2 in main_description_title" });
            } else if (parsed.name_best && String(parsed.main_description_title).trim() === String(parsed.name_best).trim()) {
              extra.push({ section: "Structure", issue: "main_description_title equals name_best/H1", fix_hint: "Use a benefit/audience H2, not the product H1 verbatim" });
            }

            // Hook bullets: require 3-6 bullets
            const hookLi = countHtmlListItems(parsed.hook_html || "");
            if (hookLi < 3 || hookLi > 6) {
              extra.push({ section: "Hook", issue: `Hook bullets count out of bounds (${hookLi})`, fix_hint: "Provide 3–6 bullets in the hook <ul> using the Label – Explanation pattern" });
            }

            // Features: 2-4 H3 groups and total 3-6 bullets
            const featHtml = parsed.features_html || "";
            if (!featHtml || featHtml.trim().length === 0) {
              extra.push({ section: "Features", issue: "features_html empty", fix_hint: "Populate features_html with 2–4 H3 groups and a total of 3–6 bullets" });
            } else {
              const h3Count = countH3Groups(featHtml);
              const liCount = countHtmlListItems(featHtml);
              if (h3Count < 2 || h3Count > 4) extra.push({ section: "Features", issue: `features_html H3 groups out of bounds (${h3Count})`, fix_hint: "Provide 2–4 H3 groups" });
              if (liCount < 3 || liCount > 6) extra.push({ section: "Features", issue: `features_html bullets out of bounds (${liCount})`, fix_hint: "Provide 3–6 bullets total across H3 groups" });
            }

            // Why-Choose: lead paragraph & 3-6 bullets
            const whyHtml = parsed.why_choose_html || "";
            const whyLi = countHtmlListItems(whyHtml);
            const whyText = stripHtml(whyHtml || "");
            if (!whyText || whyText.length < 20) extra.push({ section: "Why-Choose", issue: "why_choose_html lead paragraph missing or too short", fix_hint: "Include a 1–3 sentence lead paragraph before bullets" });
            if (whyLi < 3 || whyLi > 6) extra.push({ section: "Why-Choose", issue: `why_choose_html bullets out of bounds (${whyLi})`, fix_hint: "Provide 3–6 bullets in why_choose_html" });

            // FAQs: 5-7 Q&A pairs
            let faqCount = 0;
            if (parsed.faq_html) {
              const m = String(parsed.faq_html).match(/<h3\b[^>]*>/gi);
              faqCount = m ? m.length : 0;
            } else if (Array.isArray(parsed.faqs)) {
              faqCount = parsed.faqs.length;
            }
            if (faqCount < 5 || faqCount > 7) extra.push({ section: "FAQs", issue: `FAQ count out of bounds (${faqCount})`, fix_hint: "Provide 5–7 Q&A pairs; each question uses <h3> and each answer a <p>" });

            // short_name usage <=2
            const shortName = parsed.short_name_60 || pickShortNameFromH1(parsed.name_best || name);
            const shortCount = countExactShortNameUsageAcross(parsed, shortName);
            if (shortCount > 2) extra.push({ section: "Style", issue: `short_name_60 appears ${shortCount} times`, fix_hint: "Use short_name verbatim at most 2× (hook first sentence + optional once more)" });

            // Duplicate H2/H3 detection
            const assembled = assembleDescriptionFromStructured(parsed);
            const h2s = extractH2Titles(assembled);
            const h3s = extractH3Titles(assembled);
            const dupes = findDuplicateTitles(h2s, h3s);
            if (dupes.length) {
              dupes.forEach(d => {
                if (d.type === "h2") extra.push({ section: "Structure", issue: `Repeated H2 title "${d.title}" appears ${d.count} times`, fix_hint: "Ensure each H2 appears once; avoid duplicated sections" });
                else extra.push({ section: "Structure", issue: `Repeated H3 title "${d.title}" appears ${d.count} times`, fix_hint: "Avoid repeating identical H3 group titles across the description" });
              });
            }

            // Specific duplication pattern: "Product Specifications" repeated
            const psCount = h2s.filter(t => (t || "").toLowerCase().includes("product specifications")).length;
            if (psCount > 1) extra.push({ section: "Structure", issue: `Multiple "Product Specifications" H2 headings detected (${psCount})`, fix_hint: "Use a single Product Specifications H2 and place all spec H3 groups beneath it" });

          } catch (err) {
            // resilience: if any check throws, record a warning but don't crash the whole route
            console.warn("gptEnforcer-3: structural checks error:", err?.stack || err);
            lastWarnings.push({ code: "structural_check_error", message: String(err?.message || err) });
          }

          if (extra.length) lastViolations = lastViolations.concat(extra);
        }

        // If no violations -> success
        if (!lastViolations.length) {
          if (!lastParsed.description_html) {
            lastParsed.specs_html = lastParsed.specs_html ? fixSpecsFormattingInHtml(lastParsed.specs_html) : lastParsed.specs_html;
            lastParsed.features_html = lastParsed.features_html ? fixBulletFormattingInHtml(lastParsed.features_html) : lastParsed.features_html;
            lastParsed.why_choose_html = lastParsed.why_choose_html ? fixBulletFormattingInHtml(lastParsed.why_choose_html) : lastParsed.why_choose_html;
            lastParsed.hook_html = lastParsed.hook_html ? fixBulletFormattingInHtml(lastParsed.hook_html) : lastParsed.hook_html;
            lastParsed.description_html = assembleDescriptionFromStructured(lastParsed);
            lastParsed.descriptionHtml = lastParsed.description_html;
          }
          lastParsed._debug = lastParsed._debug || {};
          lastParsed._debug.attempts = attempt;
          lastParsed._debug.lastModelTextPreview = String(lastModelText || "").slice(0, 1200);
          if (lastWarnings.length) lastParsed._debug.warnings = lastWarnings;
          return res.json(lastParsed);
        }

        // If violations and attempts remain, instruct repair
        if (attempt < MAX_ATTEMPTS) {
          const repairInstruction = [
            "The previous JSON failed schema/structure validation. Apply the exact fixes below and RETURN ONLY the corrected JSON object.",
            "Validation issues:",
            ...lastViolations.map((v, i) => `${i + 1}. ${v.section} — ${v.issue} (${v.fix_hint || "no hint"})`),
            "",
            "Ensure the required structured fields are present: hook_html, main_description_title, main_description_html, features_html, specs_html, why_choose_title, why_choose_html, faq_html or faqs, name_best, short_name_60, desc_audit.",
            "If a required fact cannot be grounded from input, OMIT that bullet and add it to desc_audit.data_gaps.",
            "",
            "INPUT (grounding):",
            JSON.stringify(modelInput, null, 2),
            "",
            "PreviousOutput:",
            JSON.stringify(lastParsed || parsed, null, 2),
            "",
            "Return only JSON."
          ].join("\n\n");
          try {
            lastModelText = await callModel(repairInstruction);
          } catch (e) {
            lastModelText = "";
          }
          continue;
        }

        // exhausted attempts -> break to return 422
        break;
      }

      const errorPayload = {
        error: "structured_validation_failed",
        message: "Model output failed structured schema/structure validation after retries.",
        violations: lastViolations,
        model_text_preview: String(lastModelText || "").slice(0, 3200),
        attempts: attempt,
        promptEngineInfo
      };
      return res.status(422).json(errorPayload);

    } catch (err) {
      console.error("gptEnforcer-3: unexpected error:", err?.stack || err);
      return res.status(500).json({ error: "internal", details: String(err) });
    }
  });

  console.log("gptEnforcer-3: /describe mounted (structured schema enforcement - augmented)");
}

export default mountDescribeRoute;
