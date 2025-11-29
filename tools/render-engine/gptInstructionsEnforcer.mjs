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

/* ------------------------ Helpers for Avidia adjustments ------------------------ */

function stripSectionsFromHtml(html = "", sectionsToRemove = []) {
  if (!html || !sectionsToRemove || !sectionsToRemove.length) return html;
  let out = String(html);
  for (const sec of sectionsToRemove) {
    const re = new RegExp(`<h2>\\s*${escapeRegExp(sec)}\\s*<\\/h2>[\\s\\S]*?(?=(<h2>|$))`, "i");
    out = out.replace(re, "");
  }
  return out;
}

function replaceExtraShortNameOccurrences(html = "", shortName = "", allowed = 2) {
  if (!html || !shortName) return html;
  const regex = new RegExp(escapeRegExp(shortName), "gi");
  let count = 0;
  return html.replace(regex, (m) => {
    count++;
    if (count <= allowed) return m;
    const isUpper = /^[A-Z]/.test(m);
    return isUpper ? "This product" : "this product";
  });
}

/* -------------------- Specs formatting helper -------------------- */

function fixSpecsFormattingInHtml(html = "") {
  if (!html) return html;
  return html.replace(/<li>([\s\S]*?)<\/li>/gi, (m, inner) => {
    let s = (inner || "").trim();
    s = s.replace(/\s+/g, " ").trim();
    const strongColonMatch = s.match(/^(?:<strong>)?([\s\S]*?)(?:<\/strong>)?\s*:\s*([\s\S]*)$/i);
    if (strongColonMatch) {
      let label = strongColonMatch[1].replace(/<\/?strong>/gi, "").trim();
      let value = strongColonMatch[2].trim();
      value = value.replace(/\s*[–-]\s*$/, "").trim();
      return `<li><strong>${label}</strong>: ${value}</li>`;
    }
    const idx = s.indexOf(":");
    if (idx !== -1) {
      const label = s.slice(0, idx).replace(/<\/?strong>/gi, "").trim();
      let value = s.slice(idx + 1).trim();
      value = value.replace(/^[\s–-]+/, "");
      value = value.replace(/\s*[–-]\s*$/, "").trim();
      return `<li><strong>${label}</strong>: ${value}</li>`;
    }
    const containsStrong = /<strong>.*<\/strong>/i.test(s);
    if (containsStrong) {
      let cleaned = s.replace(/\s*[–-]\s*$/, "").trim();
      return `<li>${cleaned}</li>`;
    }
    return `<li>${s}</li>`;
  });
}

/* -------------------- Structured assembly helper -------------------- */

function assembleDescriptionFromStructured(parsed = {}) {
  let parts = [];

  if (parsed.hook_html) {
    parts.push(parsed.hook_html);
  } else if (parsed.hook) {
    parts.push(parsed.hook);
  }

  if (parsed.main_description_title) {
    parts.push(`<h2>${parsed.main_description_title}</h2>`);
  }
  if (parsed.main_description_html) {
    parts.push(parsed.main_description_html);
  } else if (parsed.main_description) {
    parts.push(parsed.main_description);
  }

  if (parsed.features_html) {
    parts.push(`<h2>Features and Benefits</h2>`);
    parts.push(parsed.features_html);
  } else if (parsed.features) {
    parts.push(`<h2>Features and Benefits</h2>`);
    parts.push(parsed.features);
  }

  if (parsed.specs_html) {
    const fixedSpecs = fixSpecsFormattingInHtml(parsed.specs_html);
    parts.push(`<h2>Product Specifications</h2>`);
    parts.push(fixedSpecs);
  } else if (parsed.specs_html_groups) {
    const fixed = fixSpecsFormattingInHtml(parsed.specs_html_groups);
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
  } else if (parsed.why_choose) {
    parts.push(`<h2>${whyTitle}</h2>`);
    parts.push(parsed.why_choose);
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
    const faqParts = parsed.faqs.map(q => {
      const qHtml = `<h3>${q.q}</h3>\n<p>${q.a}</p>`;
      return qHtml;
    }).join("\n");
    parts.push(faqParts);
  }

  return parts.filter(Boolean).join("\n\n");
}

/* ------------------------ Validation & Normalization (structured-only) ------------------------ */

function validateAndNormalize(parsed = {}, modelInput = {}) {
  const violations = [];
  const warnings = [];
  const normalized = JSON.parse(JSON.stringify(parsed || {}));

  // Strict structured-field presence check (no legacy fallback)
  const requiredStructuredFields = [
    "hook_html",
    "main_description_html",
    "features_html",
    "specs_html",
    "why_choose_html",
    // FAQs must be provided either faq_html or faqs array
  ];

  const hasFaqs = Boolean(normalized.faq_html || (Array.isArray(normalized.faqs) && normalized.faqs.length));
  const missing = requiredStructuredFields.filter(f => !normalized[f]);

  if (!hasFaqs) missing.push("faq_html or faqs");

  if (missing.length) {
    missing.forEach(m => {
      violations.push({ section: "Structure", issue: `Missing required structured field: ${m}`, fix_hint: `Include ${m} in top-level JSON response (no description_html-only fallback).` });
    });
    // Return early with normalized so calling code can handle finalization
    return { normalized, violations, warnings };
  }

  // Build descriptionHtml by assembling structured fields
  normalized.descriptionHtml = assembleDescriptionFromStructured(normalized);
  normalized.description_html = normalized.descriptionHtml;

  const descHtml = normalized.descriptionHtml || "";
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

  // Hook bullets
  const hookHtml = normalized.hook_html || "";
  const hookListMatch = hookHtml.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const hookCount = hookListMatch ? countHtmlListItems(hookListMatch[1]) : 0;
  if (!hookHtml) {
    violations.push({ section: "Structure", issue: "Missing Hook content (hook_html)", fix_hint: "Provide hook_html with intro paragraph and bullets" });
  } else if (hookCount < 3 || hookCount > 6) {
    violations.push({ section: "Hook", issue: `Hook bullets count ${hookCount}; expected 3–6`, fix_hint: "Add grounded bullets to reach 3–6" });
  }

  // Main Description presence (already ensured), check sentences roughly (naive check)
  const mainDesc = normalized.main_description_html || "";
  if (!mainDesc) {
    violations.push({ section: "Structure", issue: "Missing Main Description (main_description_html)", fix_hint: "Provide main_description_html with 4–6 sentences and a dynamic H2 title (main_description_title)" });
  } else {
    // check for at least one buyer-outcome sentence: presence heuristic (word like 'helps', 'support', 'provide', 'ensur' etc)
    const outcomeRegex = /\b(help|helps|support|supports|provide|provides|ensure|ensures|deliver|delivers)\b/i;
    if (!outcomeRegex.test(mainDesc)) {
      warnings.push({ code: "MAIN_OUTCOME_MISSING", section: "Main Description", message: "Buyer-outcome sentence not detected; ensure one explicit buyer-outcome sentence is present." });
    }
  }

  // Features: count bullets
  const featuresHtml = normalized.features_html || "";
  if (!featuresHtml) {
    violations.push({ section: "Structure", issue: "Missing Features and Benefits (features_html)", fix_hint: "Provide features_html with H3 groups and bullets" });
  } else {
    const liCount = countHtmlListItems(featuresHtml);
    if (liCount < 2) {
      violations.push({ section: "Features", issue: `Features list too short (${liCount} bullets)`, fix_hint: "Add grounded feature bullets" });
    }
  }

  // Specs: ensure at least one bullet
  const specsHtml = normalized.specs_html || "";
  const specLiCount = countHtmlListItems(specsHtml);
  if (specLiCount < 1) {
    violations.push({ section: "Product Specifications", issue: `Product Specifications list too short (${specLiCount} bullets)`, fix_hint: "Add grounded spec bullets" });
  }

  // Why Choose bullets count
  const whyHtml = normalized.why_choose_html || "";
  const whyListMatch = whyHtml.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const whyCount = whyListMatch ? countHtmlListItems(whyListMatch[1]) : 0;
  if (!whyHtml) {
    violations.push({ section: "Structure", issue: "Missing Why Choose (why_choose_html)", fix_hint: "Provide why_choose_html with lead paragraph and 3–6 bullets" });
  } else if (whyCount < 3 || whyCount > 6) {
    violations.push({ section: "Why Choose", issue: `Why Choose bullets ${whyCount}; expected 3–6`, fix_hint: "Adjust bullets count to be within 3–6" });
  }

  // FAQs count
  let faqCount = 0;
  if (normalized.faq_html) {
    faqCount = (normalized.faq_html.match(/<h3>/gi) || []).length;
  } else if (Array.isArray(normalized.faqs) && normalized.faqs.length) {
    faqCount = normalized.faqs.length;
  }
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

  // Normalize formatting
  let fixed = normalized.descriptionHtml || "";
  fixed = enforceEnDashAndFixEm(fixed);
  fixed = fixBulletFormattingInHtml(fixed);
  fixed = fixed.replace(normalized.specs_html || "", fixSpecsFormattingInHtml(normalized.specs_html || ""));
  normalized.descriptionHtml = fixed;
  normalized.description_html = fixed;

  // Manuals validation
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

/* -------------------- Main mount function -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const TARGET_AUDIT_SCORE = Number(process.env.TARGET_AUDIT_SCORE || opts.targetAuditScore || DEFAULTS.TARGET_AUDIT_SCORE);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  console.log("gptEnforcer: mounting /describe route (structured-only)");

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
        finalPrompt = `MASTER-FALLBACK (STRUCTURED-ONLY): Return valid JSON only. Required structured fields: hook_html, main_description_title (optional), main_description_html, features_html, specs_html, why_choose_title (optional), why_choose_html, faq_html (or faqs array), internal_links (array), manuals_html (or manuals array). Do NOT return description_html-only or any other legacy fallback.`;
      }

      // Development deterministic mock if no key (still returns structured fields)
      if (!OPENAI_KEY) {
        const response = {
          descriptionHtml: `<p><strong>${shortDescription}</strong></p>`,
          hook_html: `<p><strong>${shortDescription}</strong></p><ul><li><strong>Feature one</strong> – Benefit one.</li><li><strong>Feature two</strong> – Benefit two.</li><li><strong>Feature three</strong> – Benefit three.</li></ul>`,
          main_description_title: `Dynamic Main Description Title`,
          main_description_html: `<p>Main description with buyer-outcome that helps clinicians perform tasks more efficiently.</p><p>Secondary detail sentence with LSI variant.</p>`,
          features_html: `<h3>Performance</h3><ul><li><strong>Durable Construction</strong> – Built to last and support frequent use.</li></ul>`,
          specs_html: `<h3>Dimensions & Packaging</h3><ul><li><strong>Capacity</strong>: 25 mL (25 mL)</li><li><strong>Packaging</strong>: 50 vials/tray</li></ul>`,
          why_choose_title: `Reliable Lab Dilution Vials`,
          why_choose_html: `<p>Lead paragraph describing why this product is better for lab workflows.</p><ul><li><strong>Guaranteed Cleanliness</strong> – Each lot tested to ensure cleanliness.</li><li><strong>High-Quality Material</strong> – Polystyrene for durability.</li><li><strong>Bulk Packaging</strong> – 50 vials/tray for efficiency.</li></ul>`,
          faq_html: `<h3>What is the capacity?</h3><p>25 mL.</p><h3>How many per case?</h3><p>1000 vials per case.</p><h3>Are they sterile?</h3><p>Yes.</p><h3>What material?</h3><p>Polystyrene.</p><h3>How are they tested?</h3><p>Each lot is tested to OEM specs.</p>`,
          name_best: name,
          short_name_60: pickShortNameFromH1(name),
          desc_audit: { score: 9.9, passed: true, violations: [] },
          normalizedPayload: { name, brand: body.brand ?? null, specs: body.specs ?? null, format: body.format ?? "avidia_standard" },
          raw: { request: body, promptEngineInfo }
        };
        return res.json(response);
      }

      // Build modelInput for grounding
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
        "You MUST return only valid JSON that includes the required structured fields (hook_html, main_description_html, features_html, specs_html, why_choose_html, faq_html/faqs, internal_links, manuals_html/manuals).",
        "The server will assemble final HTML and enforce structure. DO NOT return description_html-only. If any required value is missing in inputs, omit that bullet and record it in desc_audit.data_gaps.",
        "Return only JSON, no commentary."
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

      // Primary instruction: structured-only enforcement
      const primaryInstruction = [
        "RETURN ONLY valid JSON. DO NOT output any text outside the JSON object.",
        "You MUST include these structured fields in the JSON: hook_html, main_description_title (optional), main_description_html, features_html, specs_html, why_choose_title (optional), why_choose_html, faq_html (or faqs array), internal_links (array), manuals_html (or manuals array).",
        "No description_html-only outputs will be accepted. If you cannot provide required structured fields using only the INPUT grounding data, populate desc_audit.data_gaps and still return structured fields (omitting ungrounded bullets).",
        "For Product Specifications, use colon format: <li><strong>Spec Name</strong>: imperial (metric)</li> with label bolded before the colon.",
        "Do not invent facts. Use only the grounding INPUT provided below."
      ].join("\n\n");

      // Attempt/repair loop (structured-only)
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
          lastModelText = await callModel(primaryInstruction);
        } catch (e) {
          lastModelText = "";
        }

        parsedResult = (() => {
          try { return JSON.parse(lastModelText); } catch (_) { return extractJsonCandidate(lastModelText); }
        })();

        // If parse succeeded and structured fields present, assemble description and validate
        if (parsedResult) {
          // Validate & normalize strictly
          const { normalized, violations, warnings } = validateAndNormalize(parsedResult, modelInput);
          parsedResult = normalized;
          lastViolations = violations;
          lastWarnings = warnings;

          // If model provided desc_audit.score that meets target, still verify structure
          const scoredOk = parsedResult.desc_audit && typeof parsedResult.desc_audit.score === "number" && parsedResult.desc_audit.score >= TARGET_AUDIT_SCORE;

          // Avidia-specific post-processing (strip some sections and short_name capping)
          const isAvidia = String((modelInput && modelInput.format) || "").toLowerCase() === "avidia_standard";
          if (isAvidia && parsedResult && parsedResult.descriptionHtml) {
            parsedResult.descriptionHtml = stripSectionsFromHtml(parsedResult.descriptionHtml, ["Internal Links", "Manuals and Troubleshooting Guides"]);
            parsedResult.description_html = parsedResult.descriptionHtml;
            if (parsedResult.internal_links) delete parsedResult.internal_links;
            const shortName = parsedResult.short_name_60 || pickShortNameFromH1(parsedResult.name_best || modelInput.name || "");
            parsedResult.descriptionHtml = replaceExtraShortNameOccurrences(parsedResult.descriptionHtml || "", shortName, 2);
            parsedResult.description_html = parsedResult.descriptionHtml;
            const reVal = validateAndNormalize(parsedResult, modelInput);
            parsedResult = reVal.normalized;
            lastViolations = reVal.violations;
            lastWarnings = reVal.warnings;
          }

          if (!lastViolations.length && (scoredOk || (parsedResult.desc_audit && parsedResult.desc_audit.passed === true))) {
            passed = true;
            break;
          }

          // If structural violations exist, instruct model to repair (explicit)
          if (lastViolations.length && attempt < MAX_ATTEMPTS) {
            const repairInstruction = [
              "The previous JSON output failed these validation checks. Apply the exact fixes below and RETURN ONLY the corrected JSON object. Do NOT add commentary.",
              "Validation issues:",
              ...lastViolations.map((v, i) => `${i + 1}. ${v.section} — ${v.issue} (${v.fix_hint || "no hint"})`),
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
              const rv = validateAndNormalize(parsedRepair, modelInput);
              parsedResult = rv.normalized;
              lastViolations = rv.violations;
              lastWarnings = rv.warnings;
              // loop continues
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
              const rv = validateAndNormalize(parsedRepair, modelInput);
              parsedResult = rv.normalized;
              lastViolations = rv.violations;
              lastWarnings = rv.warnings;
            }
          }
        } else {
          // Parsing failed; attempt a forced JSON repair once more if attempts remain
          if (attempt < MAX_ATTEMPTS) {
            const repairPrompt = [
              "The model's previous output could not be parsed as JSON. Here is the original output:",
              lastModelText,
              "Please return the same information but ONLY as valid JSON matching the REQUIRED structured schema (hook_html, main_description_html, features_html, specs_html, why_choose_html, faq_html/faqs, internal_links, manuals_html). Do not include description_html-only fallback.",
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
              const rv = validateAndNormalize(parsedRepair, modelInput);
              parsedResult = rv.normalized;
              lastViolations = rv.violations;
              lastWarnings = rv.warnings;
            }
          }
        }
      } // end attempts

      // Finalize: if passed, return normalized payload; otherwise return 422 with details (no legacy fallback)
      if (parsedResult && typeof parsedResult === "object" && !lastViolations.length) {
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

        // Ensure descriptionHtml assembled and normalized
        if (!parsedResult.descriptionHtml && (parsedResult.hook_html || parsedResult.features_html || parsedResult.main_description_html)) {
          parsedResult.descriptionHtml = assembleDescriptionFromStructured(parsedResult);
          parsedResult.description_html = parsedResult.descriptionHtml;
        }

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

      // Structured required fields or other violations remain — return 422 with machine actionable info
      const errorPayload = {
        error: "structured_validation_failed",
        message: "The model output did not meet the required structured schema or had unresolved structural violations. No legacy description_html fallback is accepted.",
        violations: lastViolations,
        warnings: lastWarnings,
        desc_audit: (parsedResult && parsedResult.desc_audit) ? parsedResult.desc_audit : undefined,
        model_text_preview: String(lastModelText || "").slice(0, 3200),
        attempts: attempt,
        promptEngineInfo
      };
      return res.status(422).json(errorPayload);
    } catch (err) {
      console.error("gptEnforcer: unexpected error:", err?.stack || err);
      return res.status(500).json({ error: "internal", details: String(err) });
    }
  });

  console.log("gptEnforcer: /describe mounted (structured-only)");
}

export default mountDescribeRoute;
