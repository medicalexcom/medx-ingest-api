// GPT instructions enforcer: generateDescription()
// - finalPrompt: the system-level prompt (string)
// - modelInput: structured JSON input (object)
// - opts: { openAiKey, model, targetAuditScore=9.8, maxAttempts=3, temperature=0.0, maxTokens=3200 }
// Returns: { parsedResult, lastModelText, lastRepairText, attempts, violations }

import OpenAI from "openai";

const DEFAULTS = {
  targetAuditScore: 9.8,
  maxAttempts: 3,
  temperature: 0.0,
  maxTokens: 3200,
  model: "gpt-4o-mini"
};

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
  // try to find first {...} block
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = t.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch (_) {}
  }
  try { return JSON.parse(t); } catch (_) {}
  return null;
}

/* ----------------- Basic normalization & validation -----------------
   These are intentionally conservative, only fixing trivial formatting
   issues and returning an array of remaining violations for the repair prompt.
*/
function enforceEnDashAndFixEm(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(/\u2014/g, "–").replace(/---+/g, "–");
}

function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixBulletFormattingInHtml(html = "") {
  if (!html || typeof html !== "string") return html;
  // Normalize <li> items to: <li><strong>Label</strong> – Explanation.</li>
  return html.replace(/<li>([\s\S]*?)<\/li>/gi, (m, inner) => {
    let s = inner.trim();
    s = enforceEnDashAndFixEm(s);
    if (/<strong>.*?<\/strong>/.test(s) && /–/.test(s)) {
      return `<li>${s.replace(/\s*–\s*/g, " – ")}</li>`;
    }
    // Try to split on en-dash or hyphen-like separators
    let parts = null;
    if (s.indexOf(" – ") !== -1) parts = s.split(" – ");
    else if (s.indexOf(" - ") !== -1) parts = s.split(" - ");
    else {
      // fallback: first sentence boundary or comma
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
  const stripped = String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return stripped.length;
}

function countHtmlListItems(blockHtml = "") {
  if (!blockHtml) return 0;
  const m = blockHtml.match(/<li>/gi);
  return m ? m.length : 0;
}

function validateAndNormalize(parsed = {}, modelInput = {}) {
  const violations = [];
  const normalized = JSON.parse(JSON.stringify(parsed || {})); // copy

  // canonical fields we expect: descriptionHtml or description_html
  const descHtml = normalized.descriptionHtml || normalized.description_html || "";
  const nameBest = normalized.name_best || normalized.product_name || modelInput.name || "";
  const shortName = normalized.short_name_60 || (typeof nameBest === "string" ? nameBest.slice(0, 60) : "");

  // H1 length (90-110) if provided
  if (normalized.name_best) {
    const nlen = String(normalized.name_best).length;
    if (nlen < 90 || nlen > 110) violations.push(`H1 length ${nlen} not in 90–110 chars.`);
  }

  // Description length (text only) 1200–32000
  const dlen = extractTextLength(descHtml);
  if (dlen < 1200) violations.push(`description length ${dlen} < 1200 characters.`);
  if (dlen > 32000) violations.push(`description length ${dlen} > 32000 characters.`);

  // Required headings presence (simple scan)
  const requiredH2 = [
    "Hook and Bullets",
    "Main Description",
    "Features and Benefits",
    "Product Specifications",
    "Internal Links",
    "Why Choose",
    "Frequently Asked Questions"
  ];
  requiredH2.forEach(h => {
    if (!descHtml.includes(`<h2>${h}</h2>`)) violations.push(`Missing heading: <h2>${h}</h2>.`);
  });

  // Hook bullets count (>=3)
  const hookMatch = descHtml.match(/<h2>Hook and Bullets<\/h2>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const hookListHtml = hookMatch ? hookMatch[1] : "";
  const hookCount = countHtmlListItems(hookListHtml);
  if (hookCount < 3) violations.push(`Hook bullets ${hookCount}; expected 3–6.`);

  // Why Choose bullets count (3-6)
  const whyMatch = descHtml.match(/<h2>Why Choose<\/h2>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
  const whyListHtml = whyMatch ? whyMatch[1] : "";
  const whyCount = countHtmlListItems(whyListHtml);
  if (whyCount < 3 || whyCount > 6) violations.push(`Why Choose bullets ${whyCount}; expected 3–6.`);

  // FAQs count (5-7)
  const faqSectionMatch = descHtml.match(/<h2>Frequently Asked Questions<\/h2>[\s\S]*$/i);
  const faqSection = faqSectionMatch ? faqSectionMatch[0] : "";
  const faqCount = (faqSection.match(/<h3>/gi) || []).length;
  if (faqCount < 5 || faqCount > 7) violations.push(`FAQ count ${faqCount}; expected 5–7.`);

  // Short name cap ≤2 occurrences in body
  try {
    const occur = shortName ? (String(descHtml).match(new RegExp(escapeRegExp(shortName), "gi")) || []).length : 0;
    if (occur > 2) violations.push(`short_name appears ${occur} times in body; max 2.`);
  } catch (e) {}

  // Fix simple formatting: em-dashes -> en-dashes and bullets
  if (descHtml) {
    let fixed = descHtml;
    fixed = enforceEnDashAndFixEm(fixed);
    fixed = fixBulletFormattingInHtml(fixed);
    normalized.descriptionHtml = fixed;
    normalized.description_html = fixed;
  }

  // Manuals section must only be present when modelInput.pdf_manual_urls exists
  const manualsPresentInInput = Array.isArray(modelInput.pdf_manual_urls) && modelInput.pdf_manual_urls.length > 0;
  if (/\<h2\>Manuals and Troubleshooting Guides\<\/h2\>/i.test(descHtml) && !manualsPresentInInput) {
    violations.push("Manuals section present but no pdf_manual_urls in input.");
  }

  return { normalized, violations };
}

/* ----------------- generateDescription ----------------- */
export async function generateDescription(finalPrompt, modelInput = {}, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const client = new OpenAI({ apiKey: cfg.openAiKey });

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
    const completion = await client.chat.completions.create({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens
    });
    return completion?.choices?.[0]?.message?.content ?? "";
  }

  let attempt = 0;
  let lastModelText = "";
  let lastRepairText = "";
  let parsed = null;
  let lastViolations = [];

  while (attempt < cfg.maxAttempts) {
    attempt++;
    // primary ask
    try {
      lastModelText = await callModel("Produce ONLY valid JSON matching the Avidia schema. RETURN JSON ONLY.");
    } catch (e) {
      lastModelText = "";
    }

    parsed = (() => {
      try { return JSON.parse(lastModelText); } catch (_) { return extractJsonCandidate(lastModelText); }
    })();

    if (parsed && parsed.desc_audit && typeof parsed.desc_audit.score === "number") {
      const sc = Number(parsed.desc_audit.score);
      if (sc >= cfg.targetAuditScore || parsed.desc_audit.passed === true) {
        // quick normalization pass plus return
        const { normalized, violations } = validateAndNormalize(parsed, modelInput);
        parsed = normalized;
        lastViolations = violations;
        break;
      }
    }

    // If parsed, attempt programmatic validation & create concise repair instruction
    if (parsed) {
      const { normalized, violations } = validateAndNormalize(parsed, modelInput);
      lastViolations = violations;
      // if no violations but score low, ask model to improve semantic score
      if (!violations.length && parsed.desc_audit && typeof parsed.desc_audit.score === "number" && parsed.desc_audit.score < cfg.targetAuditScore && attempt < cfg.maxAttempts) {
        const repairInstruction = [
          "The previous JSON output passed structural validation but its desc_audit.score is below the target.",
          `Target desc_audit.score: ${cfg.targetAuditScore}.`,
          "Do not change name_best. Improve semantic quality by: adding grounded LSI variants, ensuring metaTitle/metaDescription length criteria, enforcing short_name usage <=2, and enhancing 'Why Choose' differentiator.",
          "Return ONLY the revised JSON object (no commentary).",
          "\nPreviousOutput:\n",
          JSON.stringify(parsed, null, 2),
          "\nINPUT(for grounding):\n",
          JSON.stringify(modelInput, null, 2)
        ].join("\n\n");
        try {
          lastRepairText = await callModel(repairInstruction);
        } catch (e) {
          lastRepairText = "";
        }
        const parsedRepair = (() => {
          try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
        })();
        if (parsedRepair) {
          parsed = parsedRepair;
          const res = validateAndNormalize(parsed, modelInput);
          parsed = res.normalized;
          lastViolations = res.violations;
          if ((!lastViolations.length && parsed.desc_audit && (parsed.desc_audit.score >= cfg.targetAuditScore || parsed.desc_audit.passed === true))) break;
          // else loop to attempt another repair
        } else {
          // parsing of repair failed; continue to forced repair below
        }
      } else if (violations.length && attempt < cfg.maxAttempts) {
        // Build explicit repair instruction listing violations
        const repairInstruction = [
          "The previous JSON output failed these validation checks. Apply exact fixes and RETURN ONLY the corrected JSON object. Do NOT add commentary.",
          "Validation issues:",
          ...violations.map((v, i) => `${i + 1}. ${v}`),
          "",
          "Fix rules:",
          "- Use en-dash (–) between bold label and explanation in bullets.",
          "- Ensure bullet format: <li><strong>Label</strong> – Explanation.</li>",
          "- Hook bullets >=3, Why Choose bullets 3–6, FAQs 5–7.",
          "- Description text length 1200–32000 characters (text only).",
          "- H1 length 90–110 characters (do not change name_best unless instructed to expand using grounded specs).",
          "",
          "INPUT (for grounding):",
          JSON.stringify(modelInput, null, 2),
          "",
          "PreviousOutput:",
          JSON.stringify(parsed, null, 2),
          "",
          "Return only JSON."
        ].join("\n\n");
        try {
          lastRepairText = await callModel(repairInstruction);
        } catch (e) {
          lastRepairText = "";
        }
        const parsedRepair = (() => {
          try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
        })();
        if (parsedRepair) {
          parsed = parsedRepair;
          const res = validateAndNormalize(parsed, modelInput);
          parsed = res.normalized;
          lastViolations = res.violations;
          if ((!lastViolations.length && parsed.desc_audit && (parsed.desc_audit.score >= cfg.targetAuditScore || parsed.desc_audit.passed === true))) break;
          // else loop for another attempt
        }
      } else {
        // parsed but no immediate path to fix; attempt a targeted semantic repair if attempts remain
        if (attempt < cfg.maxAttempts) {
          try {
            lastRepairText = await callModel(
              "The previous JSON was parsed but needs improvement. Return a corrected JSON only. Improve metadata lengths and section completeness where grounded."
            );
          } catch (e) { lastRepairText = ""; }
          const parsedRepair = (() => {
            try { return JSON.parse(lastRepairText); } catch (_) { return extractJsonCandidate(lastRepairText); }
          })();
          if (parsedRepair) {
            parsed = parsedRepair;
            const res = validateAndNormalize(parsed, modelInput);
            parsed = res.normalized;
            lastViolations = res.violations;
            if ((!lastViolations.length && parsed.desc_audit && (parsed.desc_audit.score >= cfg.targetAuditScore || parsed.desc_audit.passed === true))) break;
          }
        }
      }
    } else {
      // no parse at all - forced JSON repair
      if (attempt < cfg.maxAttempts) {
        const repairPrompt = [
          "The model's previous output could not be parsed as JSON. Here is the original output:",
          lastModelText,
          "Please return the same information but ONLY as valid JSON matching the schema. Do not include code fences or extra text.",
          "",
          "INPUT (for grounding):",
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
          parsed = parsedRepair;
          const res = validateAndNormalize(parsed, modelInput);
          parsed = res.normalized;
          lastViolations = res.violations;
          if ((!lastViolations.length && parsed.desc_audit && (parsed.desc_audit.score >= cfg.targetAuditScore || parsed.desc_audit.passed === true))) break;
        }
      }
    }
  } // end attempts loop

  return {
    parsedResult: parsed,
    lastModelText,
    lastRepairText,
    attempts: attempt,
    violations: lastViolations
  };
}
