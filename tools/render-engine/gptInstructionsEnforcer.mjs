// tools/render-engine/gptInstructionsEnforcer.mjs
// GPT Instructions Enforcer (STRICT + server-side audit authoritative).
// - Server computes desc_audit; model cannot claim a pass.
// - Deterministic, grounded H1 auto-expansion (no guessing).
// - Explicit HTML skeleton repair prompts to enforce Avidia structure.
// - If model fails to produce fully compliant JSON after attempts → 422 (no fallback).
//
// Deploy notes:
// - Requires OPENAI_API_KEY and RENDER_ENGINE_SECRET in env.
// - You can set ENFORCE_AVIDIA_STANDARD="0" to disable strict enforcement (not recommended).
// - Test in staging first.

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
function escapeRegExp(s = "") { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
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
  while (parts.join("-").length > maxChars || parts.length > maxTokens) parts.pop();
  return parts.join("-");
}
function pickShortNameFromH1(h1) {
  if (!h1) return "";
  const parts = String(h1).split("–").map(p => p.trim());
  if (parts.length > 0 && parts[0]) {
    const candidate = parts[0].slice(0, 60);
    return candidate.replace(/\s+\S*$/, "") || candidate;
  }
  const fallback = String(h1).slice(0, 60);
  return fallback.replace(/\s+\S*$/, "") || fallback;
}

/* -------------------------- HTML normalization helpers ------------------------- */

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
    violations.push({ section: "Description", issue: `Description too short (${dlen} chars)`, fix_hint: "Add grounded content from inputs until description reaches minimum length" });
  } else if (dlen > 32000) {
    violations.push({ section: "Description", issue: `Description too long (${dlen} chars)`, fix_hint: "Trim non-essential content while preserving required sections" });
  }

  // Required H2 headings presence and order
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

  // Apply minor fixes
  if (descHtml) {
    let fixed = descHtml;
    fixed = enforceEnDashAndFixEm(fixed);
    fixed = fixBulletFormattingInHtml(fixed);
    normalized.descriptionHtml = fixed;
    normalized.description_html = fixed;
  }

  // Manuals presence when pdf manual urls are present
  const manualsPresentInInput = Array.isArray(modelInput.pdf_manual_urls) && modelInput.pdf_manual_urls.length > 0;
  if (/\<h2\>Manuals and Troubleshooting Guides\<\/h2\>/i.test(normalized.descriptionHtml || "") && !manualsPresentInInput) {
    violations.push({ section: "Manuals", issue: "Manuals section rendered but no pdf_manual_urls provided", fix_hint: "Remove manuals section or provide valid PDF URLs" });
  }

  return { normalized, violations, warnings };
}

/* -------------------- Server-side desc_audit computation -------------------- */

function computeDescAudit(normalized, modelInput) {
  // simple deterministic scoring based on violations and presence of required features.
  const out = { score: 10.0, passed: false, violations: [], warnings: [], data_gaps: [], conflicts: [] };

  const { violations, warnings } = (() => {
    try { return validateAndNormalize(normalized, modelInput); } catch (e) { return { normalized, violations: [{ section: "System", issue: "validation-failed", fix_hint: String(e) }], warnings: [] }; }
  })();

  out.violations = violations;
  out.warnings = warnings || [];

  // Deduct per violation
  const base = 10.0;
  let deduction = 0;
  deduction += Math.min(violations.length * 0.9, 9.5); // heavy penalty per violation
  let score = Math.max(0, base - deduction);

  // If no violations and description length ok → pass
  if (!violations.length) out.passed = true;

  out.score = Math.round(score * 100) / 100;
  return out;
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

/* -------------------- Deterministic H1 auto-expansion (grounded only) -------------------- */

function expandNameDeterministically(nameBest, modelInput, targetMin = 90) {
  if (!nameBest) return nameBest;
  if (String(nameBest).length >= targetMin) return nameBest;
  const pieces = [];

  // Extract grounded candidates from specs (prefer high-value keys)
  const specPriority = ["capacity", "weight_capacity", "product_weight", "overall_dimensions", "material", "model", "color"];
  try {
    const specs = modelInput.specs || {};
    for (const k of specPriority) {
      if (specs[k] && !pieces.includes(String(specs[k]).trim())) pieces.push(String(specs[k]).trim());
      if (pieces.length >= 4) break;
    }
  } catch {}

  // Also use first two features if present
  try {
    if (Array.isArray(modelInput.variants) && modelInput.variants.length && pieces.length < 4) {
      // skip - variants are structured
    }
    if (Array.isArray(modelInput.features) && modelInput.features.length) {
      for (const f of modelInput.features) {
        const t = String(f || "").trim();
        if (t && !pieces.includes(t)) {
          pieces.push(t);
          if (pieces.length >= 4) break;
        }
      }
    }
  } catch {}

  // Use shortDescription if available
  if (modelInput.shortDescription && pieces.length < 4) {
    const s = String(modelInput.shortDescription).trim();
    if (s && !pieces.includes(s)) pieces.push(s);
  }

  // Build appended string progressively until reaches targetMin or no candidates
  let cur = String(nameBest);
  let i = 0;
  while (cur.length < targetMin && i < pieces.length) {
    const add = pieces[i++];
    // sanitize: remove trailing punctuation
    const clean = String(add).replace(/^[\s\-\–\:]+|[\s\-\–\:]+$/g, "");
    if (!clean) continue;
    cur = `${cur}, ${clean}`;
    if (cur.length >= targetMin) break;
  }

  // Final trim to max 110 if needed by removing trailing tokens
  if (cur.length > 110) cur = cur.slice(0, 110).replace(/\s+\S*$/, "").trim();
  return cur;
}

/* -------------------- Repair prompt skeleton -------------------- */

function buildRepairSkeletonPrompt(violations, modelInput, previousOutput) {
  const requiredSkeleton = [
    "<!-- REQUIRED: Return valid JSON only. No extra text. -->",
    "JSON keys required: name_candidates (array), name_best (string), name_best_seo_score (number), short_name_60 (string), desc_audit (object), product_name, generated_product_url, description_html (string), meta_title, meta_description, search_keywords, internal_links (array), final_description (string)",
    "",
    "description_html MUST contain the following H2 headings in this exact order:",
    "1) <h2>Hook and Bullets</h2>",
    "2) <h2>Main Description</h2>",
    "3) <h2>Features and Benefits</h2>",
    "4) <h2>Product Specifications</h2>",
    "5) <h2>Internal Links</h2>",
    "6) <h2>Why Choose</h2>",
    "7) <h2>Frequently Asked Questions</h2>",
    "",
    "HOOK requirements:",
    "- First paragraph: 2–3 sentences including one empathy clause and one outcome clause.",
    "- Bold the short_name_60 once in the first sentence using <strong>short_name</strong>.",
    "- Provide 3–6 bullets (<ul><li>...) following bullet format: <li><strong>Label</strong> – Explanation.</li>",
    "",
    "MAIN DESCRIPTION requirements:",
    "- H2 title: use a short keyword variation (not the full long name).",
    "- 4–6 sentence intro paragraph including one buyer-outcome sentence and at least two semantic variants of the primary concept.",
    "",
    "FEATURES & BENEFITS requirements:",
    "- H2 exactly 'Features and Benefits'.",
    "- 2–4 H3 groups with title and bullets in the <li><strong>Label</strong> – Explanation.</li> format.",
    "",
    "PRODUCT SPECIFICATIONS requirements:",
    "- H2 exactly 'Product Specifications'.",
    "- 2–4 H3 groups, bullets follow <li><strong>Spec Name</strong>: imperial (metric)</li>",
    "",
    "INTERNAL LINKS:",
    "- Place exactly two site-relative internal_links after Product Specifications and before Why Choose. Provide internal_links array in JSON with type, anchor, url, confidence.",
    "",
    "WHY CHOOSE:",
    "- H2 and 3–6 bullets. Include at least one differentiator bullet (measurable if present in inputs).",
    "",
    "FAQ:",
    "- 5–7 Q&A pairs. Questions use <h3> and answers are <p> paragraphs.",
    "",
    "GROUNDING rules:",
    "- Use ONLY the input JSON for facts (modelInput). Do NOT invent numbers, warranty terms, weights, capacities, or specs.",
    "- If a value is missing, OMIT it from customer-facing HTML and list it in desc_audit.data_gaps.",
    "",
    "AUDIT:",
    "- Do not set desc_audit.passed = true yourself. The server will compute the audit after your JSON. Return desc_audit with score field only if you include a draft; the server will override.",
    "",
    "PREVIOUS OUTPUT (for context):",
    JSON.stringify(previousOutput || {}, null, 2),
    "",
    "INPUT (grounding):",
    JSON.stringify(modelInput || {}, null, 2),
    "",
    "Return only JSON. Strictly follow skeleton and formatting rules above."
  ].join("\n");

  // Add readable violations list
  const vlist = (violations || []).map((v, i) => `${i+1}. ${v.section} — ${v.issue} (${v.fix_hint || "no hint"})`).join("\n");
  return `The previous output failed validation for these issues:\n\n${vlist}\n\nPlease apply the exact fixes and return only JSON matching the skeleton below.\n\n${requiredSkeleton}`;
}

/* -------------------- Main mount function -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const TARGET_AUDIT_SCORE = Number(process.env.TARGET_AUDIT_SCORE || opts.targetAuditScore || DEFAULTS.TARGET_AUDIT_SCORE);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  const ENFORCE_AVIDIA = process.env.ENFORCE_AVIDIA_STANDARD !== "0"; // default true

  console.log("gptEnforcer (STRICT): mounting /describe route enforceAvidia=", ENFORCE_AVIDIA);

  app.get("/healthz", (_, res) => res.json({ ok: true }));

  app.post("/describe", async (req, res) => {
    try {
      const rawHeader = (req.header("x-engine-key") || req.header("authorization") || "").toString();
      const key = rawHeader.toLowerCase().startsWith("bearer ") ? rawHeader.replace(/^Bearer\s+/i, "") : rawHeader;
      if (!key || key !== ENGINE_SECRET) return res.status(401).json({ error: "unauthorized: invalid engine key" });

      if (!ENFORCE_AVIDIA) {
        return res.status(400).json({ error: "ENFORCE_AVIDIA_STANDARD must be enabled for this service" });
      }

      if (!OPENAI_KEY) {
        console.error("gptEnforcer: OPENAI_API_KEY missing; cannot run strict enforcer");
        return res.status(503).json({ error: "render engine unavailable", message: "OPENAI_API_KEY missing; Avidia standard cannot run without model access" });
      }

      const body = req.body || {};
      const name = body.name || "Sample product";
      const shortDescription = body.shortDescription || "Short description";

      // Build finalPrompt: prefer buildPrompt, else use canonical describePrompt.md; fatal if missing
      let finalPrompt = null;
      let promptEngineInfo = { usedBuildPrompt: false, usedDescribeMd: false, buildError: null };

      try {
        const modImport = await loadBuildPromptIfAvailable();
        if (modImport) {
          const mod = await modImport;
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
              CATEGORY: body.category || "",
              SOURCE_URL: body.sourceUrl || ""
            });
          }
        }
      } catch (e) {
        promptEngineInfo.buildError = String(e && e.message ? e.message : e);
      }

      if (!finalPrompt) {
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

      if (!finalPrompt) {
        console.error("gptEnforcer: no describe prompt available (buildPrompt or describePrompt.md).");
        return res.status(500).json({ error: "server_misconfiguration", message: "No describe prompt available for strict enforcer", details: promptEngineInfo });
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
        "3) If a value is missing, OMIT it from the customer-facing HTML and list the gap under desc_audit.data_gaps.",
        "4) RETURN ONLY valid JSON matching the required schema. No commentary, no code fences, no extra text."
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

      // First request: ask model to produce Avidia-format JSON (no desc_audit passed claims necessary)
      let attempt = 0;
      let lastModelText = "";
      let lastRepairText = "";
      let parsedResult = null;
      let collectedViolations = [];
      let collectedWarnings = [];

      // Primary initial instruction: produce JSON following schema; do NOT mark passed=true (server will compute)
      const primaryInstruction = [
        "Produce ONLY valid JSON matching the Avidia schema. RETURN JSON ONLY.",
        "Do NOT set desc_audit.passed = true yourself; include desc_audit.score only if you produce a draft. The server will compute the authoritative desc_audit after receiving your JSON.",
        "Ensure description_html contains all required H2 headings and the structure in the repository's describePrompt.md.",
        "If you lack facts, omit them and list them in desc_audit.data_gaps."
      ].join("\n\n");

      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        try {
          lastModelText = await callModel(primaryInstruction);
        } catch (e) {
          lastModelText = "";
        }

        parsedResult = (() => {
          try { return JSON.parse(lastModelText); } catch (_) { return extractJsonCandidate(lastModelText); }
        })();

        if (parsedResult) {
          // Programmatic normalization + validation
          const { normalized, violations, warnings } = validateAndNormalize(parsedResult, modelInput);
          parsedResult = normalized;
          collectedViolations = violations;
          collectedWarnings = warnings;

          // Deterministic H1 auto-expansion when too short (grounded only)
          try {
            const h = parsedResult.name_best || parsedResult.product_name || modelInput.name || "";
            if (h && String(h).length < 90) {
              const expanded = expandNameDeterministically(h, modelInput, 90);
              if (expanded && expanded.length >= 90 && expanded.length <= 110) {
                parsedResult.name_best = expanded;
                parsedResult.short_name_60 = pickShortNameFromH1(expanded);
                // refresh slug
                const rawSlug = slugifyName(expanded);
                parsedResult.generated_product_url = `/${trimSlugByRules(rawSlug, 60, 7)}`;
                // Re-run validation
                const reVal = validateAndNormalize(parsedResult, modelInput);
                parsedResult = reVal.normalized;
                collectedViolations = reVal.violations;
                collectedWarnings = reVal.warnings;
              }
            }
          } catch (e) {
            // non-fatal
          }

          // compute server authoritative audit
          const descAudit = computeDescAudit(parsedResult, modelInput);
          parsedResult.desc_audit = parsedResult.desc_audit || {};
          parsedResult.desc_audit.score = descAudit.score;
          parsedResult.desc_audit.passed = descAudit.passed;
          parsedResult.desc_audit.violations = descAudit.violations;
          parsedResult.desc_audit.warnings = descAudit.warnings;

          // Accept only when passed true and no programmatic violations
          if (descAudit.passed && (!descAudit.violations || descAudit.violations.length === 0)) {
            // attach debug and return
            parsedResult._debug = {
              promptEngineInfo,
              attempts: attempt,
              lastModelTextPreview: String(lastModelText || "").slice(0, 1200)
            };
            return res.json(parsedResult);
          }

          // Not passed: if attempts remain, send repair prompt with exact violations and skeleton
          if (attempt < MAX_ATTEMPTS) {
            const repairPrompt = buildRepairSkeletonPrompt(collectedViolations, modelInput, parsedResult);
            try {
              lastRepairText = await callModel(repairPrompt);
            } catch (e) {
              lastRepairText = "";
            }
            const parsedRepair = (() => {
              try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
            })();
            if (parsedRepair) {
              // loop will validate parsedRepair next iteration
              parsedResult = parsedRepair;
              continue;
            } else {
              // loop continues, will re-issue primaryInstruction or next repair
              continue;
            }
          }
        } else {
          // not parseable, if attempts remain, ask for JSON-only repair
          if (attempt < MAX_ATTEMPTS) {
            const repairPrompt = [
              "The model's previous output could not be parsed as JSON. Here is the original output:",
              lastModelText,
              "",
              "Please return the same information but ONLY as valid JSON matching the Avidia schema. Do not include code fences or extra text.",
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
              parsedResult = parsedRepair;
              continue;
            } else {
              continue;
            }
          }
        }
      } // end attempts

      // If we get here, model failed to produce Avidia-compliant JSON
      console.error("gptEnforcer: model failed to produce Avidia-compliant JSON after attempts", {
        attempts: MAX_ATTEMPTS,
        lastModelText: String(lastModelText || "").slice(0, 16000),
        lastRepairText: String(lastRepairText || "").slice(0, 16000),
        violations: collectedViolations
      });

      return res.status(422).json({
        error: "model_noncompliant",
        message: "Model did not produce Avidia Standard compliant JSON within allowed repair attempts. No fallback returned.",
        attempts: MAX_ATTEMPTS,
        _debug: {
          promptEngineInfo,
          lastModelText: String(lastModelText || "").slice(0, 16000),
          lastRepairText: String(lastRepairText || "").slice(0, 16000),
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
