// tools/render-engine/gptInstructionsEnforcer.mjs
// GPT Instructions Enforcer (structured-only + schema validation)
// - Strictly requires structured fields (no legacy description_html fallback).
// - Uses the AJV-based structured validator at validators/structuredValidator.mjs.
// - Enforces presence of dynamic H2 titles: main_description_title and why_choose_title.
// - Formats specs (label before colon bolded) before assembling description_html.
// - Runs a repair loop up to MAX_ATTEMPTS; if schema/structure still invalid returns 422 with violations.
//
// Usage: mountDescribeRoute(app)
// Ensure tools/render-engine/validators/structuredValidator.mjs and schema/describeSchema.json are present.

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

/* -------------------------- Utilities -------------------------- */

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

/* ---------------------- HTML helpers ---------------------- */

function countHtmlListItems(html = "") {
  if (!html) return 0;
  const m = html.match(/<li>/gi);
  return m ? m.length : 0;
}

// Fix bullets to use en-dash pattern where appropriate
function fixBulletFormattingInHtml(html = "") {
  if (!html) return html;
  return html.replace(/<li>([\s\S]*?)<\/li>/gi, (m, inner) => {
    let s = (inner || "").trim();
    s = enforceEnDashAndFixEm(s);
    if (/<strong>.*?<\/strong>/.test(s) && /–/.test(s)) {
      return `<li>${s.replace(/\s*–\s*/g, " – ")}</li>`;
    }
    // Attempt to split label / body heuristically
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

// Specs formatting: ensure <li><strong>Label</strong>: value</li>
function fixSpecsFormattingInHtml(html = "") {
  if (!html) return html;
  return html.replace(/<li>([\s\S]*?)<\/li>/gi, (m, inner) => {
    let s = (inner || "").trim();
    s = s.replace(/\s+/g, " ").trim();
    // If colon present - split
    const idx = s.indexOf(":");
    if (idx !== -1) {
      const label = s.slice(0, idx).replace(/<\/?strong>/gi, "").trim();
      let value = s.slice(idx + 1).trim();
      value = value.replace(/^[\s–-]+/, "").trim();
      return `<li><strong>${label}</strong>: ${value}</li>`;
    }
    // If <strong> present and no colon, keep but normalize
    if (/<strong>.*<\/strong>/i.test(s)) {
      return `<li>${s}</li>`;
    }
    // fallback: treat whole as label with empty value
    return `<li><strong>${s}</strong>:</li>`;
  });
}

/* -------------------- Assemble structured -> description -------------------- */

// This assembly enforces dynamic H2 insertion for main_description_title and why_choose_title.
// Hook remains un-titled (no H2).
function assembleDescriptionFromStructured(parsed = {}) {
  const parts = [];

  if (parsed.hook_html) parts.push(parsed.hook_html);

  // Main Description: dynamic H2 must be present per requirement
  if (parsed.main_description_title) parts.push(`<h2>${parsed.main_description_title}</h2>`);
  if (parsed.main_description_html) parts.push(parsed.main_description_html);

  // Features and Benefits
  if (parsed.features_html) {
    parts.push(`<h2>Features and Benefits</h2>`);
    parts.push(parsed.features_html);
  }

  // Product Specifications - normalize spec li formatting
  if (parsed.specs_html) {
    const fixed = fixSpecsFormattingInHtml(parsed.specs_html);
    parts.push(`<h2>Product Specifications</h2>`);
    parts.push(fixed);
  }

  // Internal Links (if provided)
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

  // Why Choose dynamic H2 required as well
  const whyTitle = parsed.why_choose_title || "Why Choose";
  if (parsed.why_choose_html) {
    parts.push(`<h2>${whyTitle}</h2>`);
    parts.push(parsed.why_choose_html);
  }

  // Manuals (conditional)
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

  // FAQs
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

/* -------------------- OpenAI wrapper -------------------- */

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

/* -------------------- Main route mount -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  console.log("gptEnforcer: mounting /describe (structured schema enforcement)");

  app.get("/healthz", (_, res) => res.json({ ok: true }));

  app.post("/describe", async (req, res) => {
    try {
      const rawHeader = (req.header("x-engine-key") || req.header("authorization") || "").toString();
      const key = rawHeader.toLowerCase().startsWith("bearer ") ? rawHeader.replace(/^Bearer\s+/i, "") : rawHeader;
      if (!key || key !== ENGINE_SECRET) return res.status(401).json({ error: "unauthorized: invalid engine key" });

      const body = req.body || {};
      const name = body.name || "Sample product";
      const shortDescription = body.shortDescription || "Short description";

      // Build finalPrompt from buildPrompt if available, otherwise fallback
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
        console.warn("gptEnforcer: buildPrompt load failed:", promptEngineInfo.buildError);
      }

      if (!finalPrompt) {
        finalPrompt = `MASTER-FALLBACK: Return valid JSON only. REQUIRED structured top-level fields: hook_html (string), main_description_title (string), main_description_html (string), features_html (string), specs_html (string), why_choose_title (string), why_choose_html (string), faq_html or faqs (array), name_best, short_name_60, desc_audit.\nDo NOT return description_html-only. Use only the INPUT grounding provided.`;
      }

      // If no OpenAI key, respond with a deterministic structured mock (useful for local dev)
      if (!OPENAI_KEY) {
        const mock = {
          hook_html: `<p><strong>${pickShortNameFromH1(name)}</strong> is designed for ...</p><ul><li><strong>Feature A</strong> – Benefit A.</li><li><strong>Feature B</strong> – Benefit B.</li><li><strong>Feature C</strong> – Benefit C.</li></ul>`,
          main_description_title: "Dynamic Main Description Title",
          main_description_html: `<p>Main description paragraph with buyer-outcome that helps users perform tasks more efficiently.</p>`,
          features_html: `<h3>Category A</h3><ul><li><strong>Feature A1</strong> – Function and benefit.</li></ul>`,
          specs_html: `<h3>Dimensions</h3><ul><li><strong>Capacity</strong>: 25 mL</li><li><strong>Packaging</strong>: 50 vials/tray</li></ul>`,
          why_choose_title: "Why Choose This Product",
          why_choose_html: `<p>Lead paragraph describing benefits.</p><ul><li><strong>Durable</strong> – Built to last.</li><li><strong>Clean</strong> – Tested for cleanliness.</li><li><strong>Bulk</strong> – 50 vials/tray.</li></ul>`,
          faq_html: `<h3>Q1</h3><p>A1</p><h3>Q2</h3><p>A2</p><h3>Q3</h3><p>A3</p><h3>Q4</h3><p>A4</p><h3>Q5</h3><p>A5</p>`,
          name_best: name,
          short_name_60: pickShortNameFromH1(name),
          desc_audit: { score: 9.9, passed: true, violations: [] }
        };
        // Assemble description_html server-side
        mock.description_html = assembleDescriptionFromStructured(mock);
        mock.descriptionHtml = mock.description_html;
        return res.json(mock);
      }

      // Build grounding modelInput for prompts
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

      // Primary instruction (strict - model must return structured fields)
      const primaryInstruction = [
        "RETURN ONLY valid JSON. DO NOT output any other text.",
        "You MUST return the required structured fields at the top level: hook_html (string), main_description_title (string), main_description_html (string), features_html (string), specs_html (string), why_choose_title (string), why_choose_html (string), faq_html (string) or faqs (array), name_best, short_name_60, desc_audit (object).",
        "Do NOT return description_html-only. The server will assemble the final description_html from these structured fields.",
        "For Product Specifications use colon format: <li><strong>Spec Name</strong>: value</li> (label bold before colon).",
        "If any required item cannot be grounded from input, omit the specific bullet/line and list it under desc_audit.data_gaps.",
        "Use only the grounding INPUT provided below."
      ].join("\n\n");

      // Repair loop: attempt to get schema-compliant JSON up to MAX_ATTEMPTS
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
          // Ask model to return valid JSON only
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
            continue; // next attempt will try to parse
          } else {
            lastViolations = [{ section: "JSON", issue: "Model output could not be parsed as JSON", fix_hint: "Ensure the model returns a single JSON object with the required structured fields" }];
            break;
          }
        }

        // Validate with AJV-based validator
        const { valid, violations } = validateStructuredResponse(parsed);
        lastParsed = parsed;
        lastViolations = violations || [];

        // Extra enforcement: require dynamic H2 titles to be present and non-empty
        if (valid) {
          const titleViolations = [];
          if (!parsed.main_description_title || String(parsed.main_description_title).trim().length === 0) {
            titleViolations.push({ section: "Structure", issue: "Missing main_description_title", fix_hint: "Provide a dynamic H2 title in main_description_title" });
          }
          if (!parsed.why_choose_title || String(parsed.why_choose_title).trim().length === 0) {
            titleViolations.push({ section: "Structure", issue: "Missing why_choose_title", fix_hint: "Provide a dynamic H2 title in why_choose_title" });
          }
          if (titleViolations.length) {
            lastViolations = lastViolations.concat(titleViolations);
          }
        }

        // If no violations -> success
        if (!lastViolations.length) {
          // Run server-side assembly, normalize specs formatting and bullets
          if (!parsed.description_html) {
            parsed.specs_html = parsed.specs_html ? fixSpecsFormattingInHtml(parsed.specs_html) : parsed.specs_html;
            parsed.features_html = parsed.features_html ? fixBulletFormattingInHtml(parsed.features_html) : parsed.features_html;
            parsed.why_choose_html = parsed.why_choose_html ? fixBulletFormattingInHtml(parsed.why_choose_html) : parsed.why_choose_html;
            parsed.hook_html = parsed.hook_html ? fixBulletFormattingInHtml(parsed.hook_html) : parsed.hook_html;
            parsed.description_html = assembleDescriptionFromStructured(parsed);
            parsed.descriptionHtml = parsed.description_html;
          }
          // Attach debug and return
          parsed._debug = parsed._debug || {};
          parsed._debug.attempts = attempt;
          parsed._debug.lastModelTextPreview = String(lastModelText || "").slice(0, 1200);
          return res.json(parsed);
        }

        // If violations and attempts remain, ask the model to repair with explicit violations list
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
            JSON.stringify(parsed, null, 2),
            "",
            "Return only JSON."
          ].join("\n\n");
          try {
            lastModelText = await callModel(repairInstruction);
          } catch (e) {
            lastModelText = "";
          }
          // loop - next iteration will parse and validate again
          continue;
        }

        // If here, no attempts left and violations present -> break to return 422
        break;
      } // end attempts loop

      // Failure path: return 422 with machine actionable violations and model preview
      const errorPayload = {
        error: "structured_validation_failed",
        message: "Model output failed structured schema/structure validation after retries. No legacy description_html-only fallback is accepted.",
        violations: lastViolations,
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

  console.log("gptEnforcer: /describe mounted (structured schema enforcement)");
}

export default mountDescribeRoute;
