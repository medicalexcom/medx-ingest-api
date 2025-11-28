// tools/render-engine/gptInstructionsEnforcer.mjs
// GPT Instructions Enforcer: mounts /describe on an Express app and enforces
// the custom GPT instructions (validation, normalization, grounding, repair loop).
//
// Usage: import { mountDescribeRoute } from "./tools/render-engine/gptInstructionsEnforcer.mjs";
//        mountDescribeRoute(app);
//
// Notes:
// - Reads OPENAI_API_KEY and RENDER_ENGINE_SECRET from env when available.
// - Attempts to load tools/render-engine/utils/buildPrompt.mjs (if present).
// - Returns JSON with desc_audit, normalized product payload, and _debug info.

import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs";

const DEFAULTS = {
  TARGET_AUDIT_SCORE: 9.8,
  MAX_ATTEMPTS: 3,
  MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
  TEMPERATURE: 0.0,
  MAX_TOKENS: 3200
};

/* ------------------------------ Utilities ------------------------------ */

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

function slugifyName(name = "") {
  // Deterministic slugify aligned with instruction rules (ASCII-folding omitted for brevity)
  // Lowercase, & -> and, non-alnum -> single hyphen, trim hyphens
  if (!name) return "";
  let s = String(name).toLowerCase();
  s = s.replace(/&/g, " and ");
  // Replace non-ascii chars with ascii approximations if possible (basic)
  s = s.normalize("NFKD").replace(/[\u0300-\u036F]/g, "");
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  s = s.replace(/-+/g, "-");
  return s;
}

function trimSlugByRules(slug, maxChars = 60, maxTokens = 7) {
  if (!slug) return slug;
  slug = slug.slice(0, maxChars);
  const parts = slug.split("-").filter(Boolean);
  while (parts.join("-").length > maxChars || parts.length > maxTokens) {
    // drop the weakest trailing token (prefer descriptors)
    parts.pop();
  }
  return parts.join("-");
}

function pickShortNameFromH1(h1) {
  if (!h1) return "";
  const parts = String(h1).split("–").map(p => p.trim()); // split on en-dash
  if (parts.length > 0 && parts[0]) {
    const candidate = parts[0].slice(0, 60);
    // trim to last whole word
    const trimmed = candidate.replace(/\s+\S*$/, "");
    return trimmed || candidate;
  }
  const fallback = String(h1).slice(0, 60);
  return fallback.replace(/\s+\S*$/, "") || fallback;
}

/* -------------------------- HTML normalization ------------------------- */

function fixBulletFormattingInHtml(html = "") {
  if (!html) return html;
  // Ensure bullets follow: <li><strong>Label</strong> – Explanation.</li>
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

function extractTextLength(html = "") {
  if (!html) return 0;
  return String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

function countHtmlListItems(html = "") {
  if (!html) return 0;
  const m = html.match(/<li>/gi);
  return m ? m.length : 0;
}

/* ------------------------ Helpers for Avidia adjustments ------------------------ */

// Remove sections (H2 and following until next H2) from HTML string.
// sectionsToRemove is array of exact H2 titles, e.g. ["Internal Links", "Manuals and Troubleshooting Guides"]
function stripSectionsFromHtml(html = "", sectionsToRemove = []) {
  if (!html || !sectionsToRemove || !sectionsToRemove.length) return html;
  let out = String(html);
  for (const sec of sectionsToRemove) {
    // Match <h2>sec</h2> and everything up to next <h2> or end
    const re = new RegExp(`<h2>\\s*${escapeRegExp(sec)}\\s*<\\/h2>[\\s\\S]*?(?=(<h2>|$))`, "i");
    out = out.replace(re, "");
  }
  return out;
}

// Replace extra occurrences (>allowed) of shortName in HTML with a neutral phrase.
// Keeps the first `allowed` occurrences; replaces subsequent with 'this product'.
function replaceExtraShortNameOccurrences(html = "", shortName = "", allowed = 2) {
  if (!html || !shortName) return html;
  const regex = new RegExp(escapeRegExp(shortName), "gi");
  let count = 0;
  return html.replace(regex, (m) => {
    count++;
    if (count <= allowed) return m;
    // preserve case of first char: if original starts with uppercase, use 'This product' else 'this product'
    const isUpper = /^[A-Z]/.test(m);
    return isUpper ? "This product" : "this product";
  });
}

/* ------------------------ Validation & Normalization ------------------------ */

function validateAndNormalize(parsed = {}, modelInput = {}) {
  const violations = [];
  const warnings = [];
  const normalized = JSON.parse(JSON.stringify(parsed || {}));

  const descHtml = normalized.descriptionHtml || normalized.description_html || "";
  const nameBest = normalized.name_best || normalized.product_name || modelInput.name || "";
  const shortName = normalized.short_name_60 || pickShortNameFromH1(nameBest);

  const isAvidia = String((modelInput && modelInput.format) || "").toLowerCase() === "avidia_standard";

  // H1 length enforcement (90-110) if present
  if (normalized.name_best) {
    const nlen = String(normalized.name_best).length;
    if (nlen < 90 || nlen > 110) {
      violations.push({
        section: "Name",
        issue: `H1 length ${nlen} not in 90–110 characters`,
        fix_hint: "Append grounded feature descriptors or specs to reach 90–110 chars"
      });
    }
  } else {
    violations.push({ section: "Name", issue: "Missing name_best (H1) in output", fix_hint: "Provide name_best equal to the selected H1" });
  }

  // Description length
  const dlen = extractTextLength(descHtml);
  if (dlen < 1200) {
    violations.push({ section: "Description", issue: `Description too short (${dlen} chars)`, fix_hint: "Add grounded content from inputs until description reaches minimum length" });
  } else if (dlen > 32000) {
    violations.push({ section: "Description", issue: `Description too long (${dlen} chars)`, fix_hint: "Trim non-essential content while preserving required sections" });
  }

  // Required H2 headings presence and order
  // For AvidiaDescribe we skip Internal Links and Manuals sections entirely.
  let requiredH2 = [
    "Hook and Bullets",
    "Main Description",
    "Features and Benefits",
    "Product Specifications",
    // "Internal Links",   // SKIP for Avidia
    "Why Choose",
    "Frequently Asked Questions"
  ];
  // For non-Avidia modes, keep Internal Links in the required list if desired (original behavior)
  if (!isAvidia) {
    requiredH2.splice(4, 0, "Internal Links"); // insert at original place
  }
  requiredH2.forEach((h) => {
    if (!descHtml.includes(`<h2>${h}</h2>`)) {
      violations.push({ section: "Structure", issue: `Missing heading: ${h}`, fix_hint: `Insert <h2>${h}</h2> in the correct order` });
    }
  });

  // Hook bullets count
  const hookMatch = descHtml.match(/<h2>Hook and Bullets<\/h2>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const hookListHtml = hookMatch ? hookMatch[1] : "";
  const hookCount = countHtmlListItems(hookListHtml);
  if (hookCount < 3) {
    violations.push({ section: "Hook", issue: `Hook bullets count ${hookCount}; expected 3–6`, fix_hint: "Add grounded bullets to reach 3–6" });
  }

  // Why Choose bullets count
  const whyMatch = descHtml.match(/<h2>Why Choose<\/h2>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const whyListHtml = whyMatch ? whyMatch[1] : "";
  const whyCount = countHtmlListItems(whyListHtml);
  if (whyCount < 3 || whyCount > 6) {
    violations.push({ section: "Why Choose", issue: `Why Choose bullets ${whyCount}; expected 3–6`, fix_hint: "Adjust bullets count to be within 3–6" });
  }

  // FAQ count 5-7
  const faqSectionMatch = descHtml.match(/<h2>Frequently Asked Questions<\/h2>[\s\S]*$/i);
  const faqSection = faqSectionMatch ? faqSectionMatch[0] : "";
  const faqCount = (faqSection.match(/<h3>/gi) || []).length;
  if (faqCount < 5 || faqCount > 7) {
    violations.push({ section: "FAQ", issue: `FAQ count ${faqCount}; expected 5–7`, fix_hint: "Add or remove Q&A pairs to reach 5–7" });
  }

  // short_name usage <=2
  try {
    const occ = shortName ? (String(descHtml).match(new RegExp(escapeRegExp(shortName), "gi")) || []).length : 0;
    if (occ > 2) {
      violations.push({ section: "ShortName", issue: `short_name appears ${occ} times; max 2`, fix_hint: "Replace extra occurrences with synonyms or pronouns" });
    }
  } catch (e) {}

  // Remove or normalize trivial formatting issues
  if (descHtml) {
    let fixed = descHtml;
    fixed = enforceEnDashAndFixEm(fixed);
    fixed = fixBulletFormattingInHtml(fixed);
    normalized.descriptionHtml = fixed;
    normalized.description_html = fixed;
  }

  // Manuals section presence when input has manuals
  const manualsPresentInInput = Array.isArray(modelInput.pdf_manual_urls) && modelInput.pdf_manual_urls.length > 0;
  // For AvidiaDescribe: skip penalizing Manuals entirely (user requested). For other modes, enforce.
  if (!isAvidia && /\<h2\>Manuals and Troubleshooting Guides\<\/h2\>/i.test(normalized.descriptionHtml || "") && !manualsPresentInInput) {
    violations.push({ section: "Manuals", issue: "Manuals section rendered but no pdf_manual_urls provided", fix_hint: "Remove manuals section or provide valid PDF URLs" });
  }

  return { normalized, violations, warnings };
}

/* -------------------- OpenAI call wrapper -------------------- */

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

/* -------------------- Optional buildPrompt loader -------------------- */

function loadBuildPromptIfAvailable() {
  try {
    const loaderPath = path.resolve(process.cwd(), "tools/render-engine/utils/buildPrompt.mjs");
    if (fs.existsSync(loaderPath)) {
      return import(loaderPath);
    }
  } catch (e) { /* ignore */ }
  return null;
}

/* -------------------- Main mount function -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const TARGET_AUDIT_SCORE = Number(process.env.TARGET_AUDIT_SCORE || opts.targetAuditScore || DEFAULTS.TARGET_AUDIT_SCORE);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  console.log("gptEnforcer: mounting /describe route (modular)");

  // health idempotent
  app.get("/healthz", (_, res) => res.json({ ok: true }));

  app.post("/describe", async (req, res) => {
    try {
      const rawHeader = (req.header("x-engine-key") || req.header("authorization") || "").toString();
      const key = rawHeader.toLowerCase().startsWith("bearer ") ? rawHeader.replace(/^Bearer\s+/i, "") : rawHeader;
      if (!key || key !== ENGINE_SECRET) return res.status(401).json({ error: "unauthorized: invalid engine key" });

      const body = req.body || {};
      const name = body.name || "Sample product";
      const shortDescription = body.shortDescription || "Short description";

      // Build finalPrompt using buildPrompt if available
      let finalPrompt = null;
      let promptEngineInfo = { usedBuildPrompt: false, buildError: null };

      try {
        const modImport = await loadBuildPromptIfAvailable();
        if (modImport) {
          const mod = await modImport;
          if (mod && typeof mod.buildPrompt === "function") {
            promptEngineInfo.usedBuildPrompt = true;
            const vars = {
              PRODUCT_NAME: name,
              SHORT_DESCRIPTION: shortDescription,
              BRAND: body.brand || "",
              SCRAPED_OVERVIEW: body.scrapedOverview || "",
              FEATURES: Array.isArray(body.features) ? body.features.join("\n") : (body.features || ""),
              SPECS: JSON.stringify(body.specs || {}),
              MANUALS: (body.manuals || []).join("\n"),
              FORMAT: body.format || "avidia_standard",
              CATEGORY: body.category || "",
              SOURCE_URL: body.sourceUrl || "",
              VARIANTS: JSON.stringify(body.variants || []),
              SPEC_TABLE: JSON.stringify(body.spec_table || {})
            };
            finalPrompt = mod.buildPrompt("describe", vars);
          } else {
            promptEngineInfo.buildError = "buildPrompt not found in module";
          }
        }
      } catch (e) {
        promptEngineInfo.buildError = String(e && e.message ? e.message : e);
        console.warn("gptEnforcer: buildPrompt load failed:", promptEngineInfo.buildError);
      }

      if (!finalPrompt) {
        finalPrompt = `MASTER-FALLBACK: You are a normalization pipeline that MUST RETURN RAW JSON ONLY with keys: descriptionHtml, sections, seo, normalizedPayload, raw.
Input placeholders: {{PRODUCT_NAME}}, {{SHORT_DESCRIPTION}}, {{BRAND}}, {{SPECS}}, {{FORMAT}}.
Return valid JSON only.`;
      }

      // If no OpenAI key -> deterministic mock
      if (!OPENAI_KEY) {
        const response = {
          descriptionHtml: `<p>${shortDescription}</p>`,
          sections: {
            overview: `${shortDescription}`,
            features: [`Feature A for ${name}`, `Feature B`],
            specsSummary: body.specs || {},
            includedItems: [],
            manualsSectionHtml: ""
          },
          seo: {
            h1: name,
            pageTitle: `${name} - Buy now`,
            metaDescription: shortDescription,
            seoShortDescription: shortDescription
          },
          normalizedPayload: { name, brand: body.brand ?? null, specs: body.specs ?? null, format: body.format ?? "avidia_standard" },
          raw: { request: body, promptEngineInfo }
        };
        return res.json(response);
      }

      // Build structured model input for grounding
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

      // grounding instruction
      const groundingInstruction = [
        "READ THESE INSTRUCTIONS CAREFULLY:",
        "1) INPUT JSON follows in the next message. Use ONLY the input data to produce customer-facing content.",
        "2) DO NOT INVENT product names, specs, weights, warranty terms, capacities, or other factual values.",
        "3) If a value is missing or ambiguous, OMIT the corresponding line/bullet from the customer-facing HTML and list the gap under desc_audit.data_gaps.",
        "4) RETURN ONLY valid JSON matching the schema requested by the system prompt. No commentary, no code fences, no extra text."
      ].join(" ");

      async function callModel(userInstructions) {
        const messages = [
          { role: "system", content: finalPrompt },
          { role: "user", content: groundingInstruction },
          { role: "user", content: "INPUT:\n" + JSON.stringify(modelInput, null, 2) },
          { role: "user", content: userInstructions }
        ];
        return await callOpenAI(OPENAI_KEY, messages, OPENAI_MODEL, DEFAULTS.TEMPERATURE, DEFAULTS.MAX_TOKENS);
      }

      // Attempt + repair loop
      let attempt = 0;
      let lastModelText = "";
      let lastRepairText = "";
      let parsedResult = null;
      let passed = false;
      let lastViolations = [];
      let lastWarnings = [];

      while (attempt < MAX_ATTEMPTS && !passed) {
        attempt++;
        try {
          lastModelText = await callModel("Produce ONLY valid JSON matching the Avidia schema. RETURN JSON ONLY.");
        } catch (e) {
          lastModelText = "";
        }

        parsedResult = (() => {
          try { return JSON.parse(lastModelText); } catch (_) { return extractJsonCandidate(lastModelText); }
        })();

        // If parsed includes desc_audit.score, check early accept
        if (parsedResult && parsedResult.desc_audit && typeof parsedResult.desc_audit.score === "number") {
          const sc = Number(parsedResult.desc_audit.score);
          if (sc >= TARGET_AUDIT_SCORE || parsedResult.desc_audit.passed === true) {
            // run programmatic validation and return
            const { normalized, violations, warnings } = validateAndNormalize(parsedResult, modelInput);
            parsedResult = normalized;
            lastViolations = violations;
            lastWarnings = warnings;
            // Before accepting, apply Avidia-specific post-processing:
            const isAvidia = String((modelInput && modelInput.format) || "").toLowerCase() === "avidia_standard";
            if (isAvidia) {
              // Strip Internal Links and Manuals sections from descriptionHtml for AvidiaDescribe
              parsedResult.descriptionHtml = stripSectionsFromHtml(parsedResult.descriptionHtml || "", ["Internal Links", "Manuals and Troubleshooting Guides"]);
              parsedResult.description_html = parsedResult.descriptionHtml;
              // Remove internal_links array if present
              if (parsedResult.internal_links) delete parsedResult.internal_links;
              // Replace extra short_name occurrences beyond 2 with neutral phrase
              const shortName = parsedResult.short_name_60 || pickShortNameFromH1(parsedResult.name_best || modelInput.name || "");
              parsedResult.descriptionHtml = replaceExtraShortNameOccurrences(parsedResult.descriptionHtml || "", shortName, 2);
              parsedResult.description_html = parsedResult.descriptionHtml;
            }
            passed = true;
            break;
          }
        }

        if (parsedResult) {
          // programmatic validation
          const { normalized, violations, warnings } = validateAndNormalize(parsedResult, modelInput);
          parsedResult = normalized;
          lastViolations = violations;
          lastWarnings = warnings;

          // Avidia-specific post-processing before repair iteration: strip the sections so they don't trigger violations
          const isAvidia = String((modelInput && modelInput.format) || "").toLowerCase() === "avidia_standard";
          if (isAvidia && parsedResult && parsedResult.descriptionHtml) {
            parsedResult.descriptionHtml = stripSectionsFromHtml(parsedResult.descriptionHtml, ["Internal Links", "Manuals and Troubleshooting Guides"]);
            parsedResult.description_html = parsedResult.descriptionHtml;
            if (parsedResult.internal_links) delete parsedResult.internal_links;
            // replace extra short_name occurrences beyond 2
            const shortName = parsedResult.short_name_60 || pickShortNameFromH1(parsedResult.name_best || modelInput.name || "");
            parsedResult.descriptionHtml = replaceExtraShortNameOccurrences(parsedResult.descriptionHtml || "", shortName, 2);
            parsedResult.description_html = parsedResult.descriptionHtml;
            // re-validate after stripping/replacing
            const reVal = validateAndNormalize(parsedResult, modelInput);
            parsedResult = reVal.normalized;
            lastViolations = reVal.violations;
            lastWarnings = reVal.warnings;
          }

          // If structural violations exist, ask for explicit fixes
          if (lastViolations.length && attempt < MAX_ATTEMPTS) {
            const repairInstruction = [
              "The previous JSON output failed these validation checks. Apply the exact fixes below and RETURN ONLY the corrected JSON object. Do NOT add commentary.",
              "Validation issues:",
              ...lastViolations.map((v, i) => `${i + 1}. ${v.section} — ${v.issue} (${v.fix_hint || "no hint"})`),
              "",
              "Fix rules (apply programmatically where possible):",
              "- Use en-dash (–) between bold label and explanation in bullets.",
              "- Ensure bullet format: <li><strong>Label</strong> – Explanation.</li>",
              "- Hook bullets >=3 and <=6; Why Choose bullets 3–6; FAQs 5–7.",
              "- Ensure description text length 1200–32000 characters (text only).",
              "- H1 length 90–110 characters (do not change name_best unless explicitly allowed).",
              "",
              "INPUT (for grounding):",
              JSON.stringify(modelInput, null, 2),
              "",
              "PreviousOutput:",
              JSON.stringify(parsedResult, null, 2),
              "",
              "Return only JSON."
            ].join("\n\n");
            try {
              lastRepairText = await callModel(repairInstruction);
            } catch (e) { lastRepairText = ""; }
            const parsedRepair = (() => {
              try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
            })();
            if (parsedRepair) {
              parsedResult = parsedRepair;
              const res = validateAndNormalize(parsedResult, modelInput);
              parsedResult = res.normalized;
              lastViolations = res.violations;
              lastWarnings = res.warnings;
              // continue loop - will re-evaluate
            }
          } else if (!lastViolations.length && parsedResult.desc_audit && typeof parsedResult.desc_audit.score === "number" && parsedResult.desc_audit.score < TARGET_AUDIT_SCORE && attempt < MAX_ATTEMPTS) {
            // semantic improvement pass
            const repairInstruction = [
              "The previous JSON output passed structural validation but its desc_audit.score is below the target.",
              `Target desc_audit.score: ${TARGET_AUDIT_SCORE}.`,
              "Do not change name_best. Improve semantic quality by: adding grounded LSI variants, ensuring metaTitle/metaDescription length criteria, enforcing short_name usage <=2, and enhancing 'Why Choose' differentiator.",
              "Return ONLY the revised JSON object (no commentary).",
              "",
              "INPUT (for grounding):",
              JSON.stringify(modelInput, null, 2),
              "",
              "PreviousOutput:",
              JSON.stringify(parsedResult, null, 2)
            ].join("\n\n");
            try {
              lastRepairText = await callModel(repairInstruction);
            } catch (e) { lastRepairText = ""; }
            const parsedRepair = (() => {
              try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
            })();
            if (parsedRepair) {
              parsedResult = parsedRepair;
              const res = validateAndNormalize(parsedResult, modelInput);
              parsedResult = res.normalized;
              lastViolations = res.violations;
              lastWarnings = res.warnings;
            }
          }
        } else {
          // parsing failed - forced JSON repair
          if (attempt < MAX_ATTEMPTS) {
            const repairPrompt = [
              "The model's previous output could not be parsed as JSON. Here is the original output:",
              lastModelText,
              "Please return the same information but ONLY as valid JSON matching the schema. Do not include code fences or extra text.",
              "INPUT:",
              JSON.stringify(modelInput, null, 2)
            ].join("\n\n");
            try {
              lastRepairText = await callModel(repairPrompt);
            } catch (e) { lastRepairText = ""; }
            const parsedRepair = (() => {
              try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
            })();
            if (parsedRepair) {
              parsedResult = parsedRepair;
              const res = validateAndNormalize(parsedResult, modelInput);
              parsedResult = res.normalized;
              lastViolations = res.violations;
              lastWarnings = res.warnings;
            }
          }
        }
      } // end attempts

      // If we have a parsedResult return it; else fallback
      if (parsedResult && typeof parsedResult === "object") {
        parsedResult._debug ||= {};
        parsedResult._debug.promptEngine = promptEngineInfo;
        parsedResult._debug.attempts = attempt;
        parsedResult._debug.lastModelTextPreview = String(lastModelText || "").slice(0, 1200);
        parsedResult._debug._input_preview = {
          name: modelInput.name,
          shortDescription: String(modelInput.shortDescription || "").slice(0,200),
          brand: modelInput.brand,
          specs_keys: Object.keys(modelInput.specs || {}).slice(0,50),
          violations: lastViolations,
          warnings: lastWarnings
        };

        // Enforce slug rules: build from name_best if present
        try {
          const finalName = parsedResult.name_best || parsedResult.product_name || modelInput.name || "";
          let rawSlug = slugifyName(finalName);
          let finalSlug = trimSlugByRules(rawSlug, 60, 7);
          parsedResult.generated_product_url = finalSlug ? `/${finalSlug}` : `/${slugifyName(modelInput.name || "product")}`;
          if (finalSlug !== rawSlug) {
            parsedResult.desc_audit = parsedResult.desc_audit || {};
            parsedResult.desc_audit.slug_resolution = `trimmed from ${rawSlug} to ${finalSlug}`;
            parsedResult.desc_audit.warnings = parsedResult.desc_audit.warnings || [];
            parsedResult.desc_audit.warnings.push({ code: "SLUG_TRIMMED", section: "Slug", message: `Slug was trimmed to meet token/length limits`, fix_hint: "Trim trailing tokens or adjust name_best" });
          }
        } catch (e) { /* non-fatal */ }

        return res.json(parsedResult);
      }

      // fallback response
      const fallback = {
        descriptionHtml: `<p>${shortDescription}</p>`,
        sections: {
          overview: shortDescription,
          features: [`Feature A for ${name}`, `Feature B`],
          specsSummary: body.specs || {},
          includedItems: [],
          manualsSectionHtml: ""
        },
        seo: {
          h1: name,
          pageTitle: `${name} - Buy now`,
          metaDescription: shortDescription,
          seoShortDescription: shortDescription
        },
        normalizedPayload: { name, brand: body.brand ?? null, specs: body.specs ?? {}, format: body.format ?? "avidia_standard" },
        raw: {
          request: body,
          promptEngineInfo,
          modelText: lastModelText,
          repairText: lastRepairText,
          note: "fallback returned after attempts",
          violations: lastViolations,
          warnings: lastWarnings
        }
      };
      return res.json(fallback);
    } catch (err) {
      console.error("gptEnforcer: unexpected error:", err?.stack || err);
      return res.status(500).json({ error: "internal", details: String(err) });
    }
  });

  console.log("gptEnforcer: /describe mounted");
}

export default mountDescribeRoute;
