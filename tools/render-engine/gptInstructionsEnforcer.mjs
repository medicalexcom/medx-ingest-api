// tools/render-engine/gptInstructionsEnforcer.mjs
// GPT Instructions Enforcer (STRICT): mounts /describe on an Express app and enforces
// the full "Avidia Standard" behavior: no guessing, no fallback, no deterministic mocks.
// This file is intentionally strict: when the model does not produce Avidia-compliant JSON
// within the allowed repair attempts, the route returns a 422 error with debug info.
// If OPENAI_API_KEY is missing the service returns 503 — strict mode cannot operate without
// a model key.
//
// Usage: import { mountDescribeRoute } from "./tools/render-engine/gptInstructionsEnforcer.mjs";
//        await mountDescribeRoute(app);
//
// Notes:
// - Reads OPENAI_API_KEY and RENDER_ENGINE_SECRET and optional ENFORCE_AVIDIA_STANDARD env.
// - ENFORCE_AVIDIA_STANDARD defaults to "1" in this file (strict by default per request).
// - Attempts to load tools/render-engine/utils/buildPrompt.mjs (if present).
// - Attempts up to MAX_ATTEMPTS (default 3) repair loops. No fallback content ever returned.

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
  if (!name) return "";
  let s = String(name).toLowerCase();
  s = s.replace(/&/g, " and ");
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
    parts.pop();
  }
  return parts.join("-");
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

/* -------------------------- HTML normalization ------------------------- */

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

function extractTextLength(html = "") {
  if (!html) return 0;
  return String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

function countHtmlListItems(html = "") {
  if (!html) return 0;
  const m = html.match(/<li>/gi);
  return m ? m.length : 0;
}

/* ------------------------ Validation & Normalization ------------------------ */

function validateAndNormalize(parsed = {}, modelInput = {}) {
  const violations = [];
  const warnings = [];
  const normalized = JSON.parse(JSON.stringify(parsed || {}));

  const descHtml = normalized.descriptionHtml || normalized.description_html || "";
  const nameBest = normalized.name_best || normalized.product_name || modelInput.name || "";
  const shortName = normalized.short_name_60 || pickShortNameFromH1(nameBest);

  // H1 length enforcement (90-110)
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
    violations.push({
      section: "Description",
      issue: `Description too short (${dlen} chars)`,
      fix_hint: "Add grounded content from inputs until description reaches minimum length"
    });
  } else if (dlen > 32000) {
    violations.push({
      section: "Description",
      issue: `Description too long (${dlen} chars)`,
      fix_hint: "Trim non-essential content while preserving required sections"
    });
  }

  // Required H2 headings presence and order (presence checks)
  const requiredH2 = [
    "Hook and Bullets",
    "Main Description",
    "Features and Benefits",
    "Product Specifications",
    "Internal Links",
    "Why Choose",
    "Frequently Asked Questions"
  ];
  requiredH2.forEach((h) => {
    if (!descHtml.includes(`<h2>${h}</h2>`)) {
      violations.push({ section: "Structure", issue: `Missing heading: ${h}`, fix_hint: `Insert <h2>${h}</h2> in the correct order` });
    }
  });

  // Hook bullets count
  const hookMatch = descHtml.match(/<h2>Hook and Bullets<\/h2>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const hookListHtml = hookMatch ? hookMatch[1] : "";
  const hookCount = countHtmlListItems(hookListHtml);
  if (hookCount < 3 || hookCount > 6) {
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

  // Apply formatting fixes (en-dash, bullet normalization)
  if (descHtml) {
    let fixed = descHtml;
    fixed = enforceEnDashAndFixEm(fixed);
    fixed = fixBulletFormattingInHtml(fixed);
    normalized.descriptionHtml = fixed;
    normalized.description_html = fixed;
  }

  // Manuals section presence when input has manuals
  const manualsPresentInInput = Array.isArray(modelInput.pdf_manual_urls) && modelInput.pdf_manual_urls.length > 0;
  if (/\<h2\>Manuals and Troubleshooting Guides\<\/h2\>/i.test(normalized.descriptionHtml || "") && !manualsPresentInInput) {
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

/* -------------------- Main mount function (STRICT) -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const TARGET_AUDIT_SCORE = Number(process.env.TARGET_AUDIT_SCORE || opts.targetAuditScore || DEFAULTS.TARGET_AUDIT_SCORE);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  // Strict enforcement is ON by default per request: no fallback, no guessing.
  const ENFORCE_AVIDIA = process.env.ENFORCE_AVIDIA_STANDARD !== "0"; // default true

  console.log("gptEnforcer (STRICT): mounting /describe route enforceAvidia=", ENFORCE_AVIDIA);

  // health
  app.get("/healthz", (_, res) => res.json({ ok: true }));

  // Helper: returns true only when Avidia audit shows passed true or score >= target
  function isAvidiaCompliant(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (!obj.desc_audit || typeof obj.desc_audit !== "object") return false;
    if (obj.desc_audit.passed === true) return true;
    if (typeof obj.desc_audit.score === "number" && Number(obj.desc_audit.score) >= TARGET_AUDIT_SCORE) return true;
    return false;
  }

  app.post("/describe", async (req, res) => {
    try {
      const rawHeader = (req.header("x-engine-key") || req.header("authorization") || "").toString();
      const key = rawHeader.toLowerCase().startsWith("bearer ") ? rawHeader.replace(/^Bearer\s+/i, "") : rawHeader;
      if (!key || key !== ENGINE_SECRET) {
        return res.status(401).json({ error: "unauthorized: invalid engine key" });
      }

      const body = req.body || {};
      const name = body.name || "Sample product";
      const shortDescription = body.shortDescription || "Short description";

      // Load prompt (prefer buildPrompt, else fallback to describePrompt.md if present)
      let finalPrompt = null;
      let promptEngineInfo = { usedBuildPrompt: false, usedDescribeMd: false, buildError: null };

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
        // Try to read canonical describePrompt.md in repo
        try {
          const dp = path.resolve(process.cwd(), "tools/render-engine/prompts/describePrompt.md");
          if (fs.existsSync(dp)) {
            finalPrompt = fs.readFileSync(dp, "utf8");
            promptEngineInfo.usedDescribeMd = true;
          }
        } catch (e) {
          promptEngineInfo.buildError = String(e && e.message ? e.message : e);
        }
      }

      // If still no prompt, this is a fatal config error in strict mode.
      if (!finalPrompt) {
        console.error("gptEnforcer: no prompt available (buildPrompt nor describePrompt.md). Cannot proceed in strict mode.");
        return res.status(500).json({ error: "server_misconfiguration", message: "No describe prompt available for strict enforcer", details: promptEngineInfo });
      }

      // Enforce presence of OpenAI key when strict
      if (!OPENAI_KEY) {
        console.error("gptEnforcer: OPENAI_API_KEY missing. Strict mode requires a valid key.");
        return res.status(503).json({ error: "render engine unavailable", message: "OPENAI_API_KEY missing; Avidia standard cannot run without model access" });
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
        pdf_manual_urls: body.pdf_manual_urls || body.manuals || []
      };

      // grounding instruction (strict)
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

      // Repair loop: attempts to get parseable + Avidia-compliant JSON
      let attempt = 0;
      let lastModelText = "";
      let lastRepairText = "";
      let parsedResult = null;
      let collectedViolations = [];
      let collectedWarnings = [];

      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        try {
          lastModelText = await callModel("Produce ONLY valid JSON matching the Avidia schema. RETURN JSON ONLY.");
        } catch (e) {
          lastModelText = "";
          console.warn("gptEnforcer: model call error on attempt", attempt, String(e).slice(0, 400));
        }

        parsedResult = (() => {
          try { return JSON.parse(lastModelText); } catch (_) { return extractJsonCandidate(lastModelText); }
        })();

        if (parsedResult) {
          // Programmatic validation
          const { normalized, violations, warnings } = validateAndNormalize(parsedResult, modelInput);
          parsedResult = normalized;
          collectedViolations = violations;
          collectedWarnings = warnings;

          // If parsed includes desc_audit score/passed, prefer that; else require validation to be clean
          if (isAvidiaCompliant(parsedResult) && collectedViolations.length === 0) {
            // Successful: return normalized, with debug
            parsedResult._debug = {
              promptEngineInfo,
              attempts: attempt,
              lastModelTextPreview: String(lastModelText || "").slice(0, 1200),
              input_preview: { name: modelInput.name, brand: modelInput.brand, specs_keys: Object.keys(modelInput.specs || {}) }
            };

            // Enforce slug rules
            try {
              const finalName = parsedResult.name_best || parsedResult.product_name || modelInput.name || "";
              let rawSlug = slugifyName(finalName);
              let finalSlug = trimSlugByRules(rawSlug, 60, 7);
              parsedResult.generated_product_url = finalSlug ? `/${finalSlug}` : `/${slugifyName(modelInput.name || "product")}`;
              if (finalSlug !== rawSlug) {
                parsedResult.desc_audit = parsedResult.desc_audit || {};
                parsedResult.desc_audit.slug_resolution = `trimmed from ${rawSlug} to ${finalSlug}`;
                parsedResult.desc_audit.warnings = parsedResult.desc_audit.warnings || [];
                parsedResult.desc_audit.warnings.push({ code: "SLUG_TRIMMED", section: "Slug", message: `Slug trimmed to meet limits`, fix_hint: "Adjust name_best" });
              }
            } catch (e) { /* non-fatal */ }

            return res.json(parsedResult);
          }

          // If not compliant and attempts remain, create a repair instruction using exact violations
          if (attempt < MAX_ATTEMPTS) {
            const repairInstruction = [
              "The previous JSON output failed validation or audit thresholds. Apply the exact fixes below and RETURN ONLY the corrected JSON object. Do NOT add commentary.",
              "Validation/Audit issues:",
              ...collectedViolations.map((v, i) => `${i + 1}. ${v.section} — ${v.issue} (${v.fix_hint || "no hint"})`),
              "",
              "Repair rules (apply programmatically):",
              "- Do not invent missing facts. Omit missing items and record gaps under desc_audit.data_gaps.",
              "- Ensure required H2 headings (Hook and Bullets, Main Description, Features and Benefits, Product Specifications, Internal Links, Why Choose, Frequently Asked Questions) are present in that order.",
              "- Hook bullets: 3–6. Why Choose bullets: 3–6. FAQs: 5–7 Q&A pairs.",
              "- H1 (name_best) must be 90–110 chars. Do not change name_best unless explicitly allowed by higher-level workflow.",
              "- Use en-dash (–) between <strong>label</strong> and explanation in bullets.",
              "",
              "INPUT (grounding):",
              JSON.stringify(modelInput, null, 2),
              "",
              "PreviousOutput:",
              JSON.stringify(parsedResult, null, 2),
              "",
              "Return only JSON."
            ].join("\n\n");
            try {
              lastRepairText = await callModel(repairInstruction);
            } catch (e) {
              lastRepairText = "";
            }
            // parse the repair result and continue loop
            const parsedRepair = (() => {
              try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
            })();
            if (parsedRepair) {
              const resVal = validateAndNormalize(parsedRepair, modelInput);
              parsedResult = resVal.normalized;
              collectedViolations = resVal.violations;
              collectedWarnings = resVal.warnings;
              // loop continues
            } else {
              // if repair could not be parsed, continue to next attempt to re-request repair
            }
          } // end attempt < MAX_ATTEMPTS
        } else {
          // Could not parse model response. If attempts remain, ask for strict JSON repair.
          if (attempt < MAX_ATTEMPTS) {
            const repairPrompt = [
              "The model's previous output could not be parsed as JSON. Here is the original output:",
              lastModelText,
              "",
              "Please return the same information but ONLY as valid JSON matching the schema. Do not include code fences or extra text.",
              "INPUT:",
              JSON.stringify(modelInput, null, 2)
            ].join("\n\n");
            try {
              lastRepairText = await callModel(repairPrompt);
            } catch (e) {
              lastRepairText = "";
            }
            const parsedRepair = (() => {
              try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
            })();
            if (parsedRepair) {
              const resVal = validateAndNormalize(parsedRepair, modelInput);
              parsedResult = resVal.normalized;
              collectedViolations = resVal.violations;
              collectedWarnings = resVal.warnings;
              // loop continues
            }
          }
        }
      } // end repair attempts loop

      // If we reach here, the model failed to produce Avidia-compliant output within attempts.
      console.error("gptEnforcer: model failed to produce Avidia-compliant JSON after attempts", {
        attempts: MAX_ATTEMPTS,
        lastModelText: String(lastModelText || "").slice(0, 8000),
        lastRepairText: String(lastRepairText || "").slice(0, 8000),
        violations: collectedViolations,
        warnings: collectedWarnings
      });

      // Per strict requirement: do NOT return fallback or mock. Return error with debug for operator.
      return res.status(422).json({
        error: "model_noncompliant",
        message: "Model did not produce Avidia Standard compliant JSON within allowed repair attempts. No fallback returned.",
        attempts: MAX_ATTEMPTS,
        _debug: {
          promptEngineInfo,
          lastModelText: String(lastModelText || "").slice(0, 8000),
          lastRepairText: String(lastRepairText || "").slice(0, 8000),
          violations: collectedViolations,
          warnings: collectedWarnings,
          input_preview: { name: modelInput.name, brand: modelInput.brand, specs_keys: Object.keys(modelInput.specs || {}) }
        }
      });
    } catch (err) {
      console.error("gptEnforcer: unexpected error:", err?.stack || err);
      return res.status(500).json({ error: "internal", details: String(err) });
    }
  });

  console.log("gptEnforcer (STRICT): /describe mounted");
}

export default mountDescribeRoute;
