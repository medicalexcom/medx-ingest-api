/* -------------------- Main mount function (replacement block) -------------------- */

export async function mountDescribeRoute(app, opts = {}) {
  const ENGINE_SECRET = process.env.RENDER_ENGINE_SECRET || opts.engineSecret || "dev-secret";
  const OPENAI_KEY = process.env.OPENAI_API_KEY || opts.openAiKey || null;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || opts.model || DEFAULTS.MODEL;
  const TARGET_AUDIT_SCORE = Number(process.env.TARGET_AUDIT_SCORE || opts.targetAuditScore || DEFAULTS.TARGET_AUDIT_SCORE);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || opts.maxAttempts || DEFAULTS.MAX_ATTEMPTS);

  // Opt-in strict enforcement flag: set env ENFORCE_AVIDIA_STANDARD="1" or pass { enforceAvidiaStandard: true }
  const ENFORCE_AVIDIA = process.env.ENFORCE_AVIDIA_STANDARD === "1" || Boolean(opts.enforceAvidiaStandard);

  console.log("gptEnforcer: mounting /describe route (modular) enforceAvidia=", ENFORCE_AVIDIA);

  // health idempotent
  app.get("/healthz", (_, res) => res.json({ ok: true }));

  // small helper used only when enforcement is enabled
  function isAvidiaCompliant(parsed) {
    if (!parsed || typeof parsed !== "object") return false;
    if (!parsed.desc_audit || typeof parsed.desc_audit !== "object") return false;
    const sc = typeof parsed.desc_audit.score === "number" ? Number(parsed.desc_audit.score) : NaN;
    if (parsed.desc_audit.passed === true) return true;
    if (!Number.isNaN(sc) && sc >= TARGET_AUDIT_SCORE) return true;
    return false;
  }

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

      // Enforcement: if strict and no OpenAI key, fail fast
      if (!OPENAI_KEY && ENFORCE_AVIDIA) {
        console.error("gptEnforcer: ENFORCE_AVIDIA_STANDARD=1 but OPENAI_API_KEY is missing");
        return res.status(503).json({ error: "render engine unavailable: missing OpenAI key for strict enforcement" });
      }

      // If no OpenAI key -> deterministic mock (keeps current behavior when NOT enforcing)
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

      // Attempt + repair loop (unchanged behavior)
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

          // If structural violations exist, ask for explicit fixes
          if (violations.length && attempt < MAX_ATTEMPTS) {
            const repairInstruction = [
              "The previous JSON output failed these validation checks. Apply the exact fixes below and RETURN ONLY the corrected JSON object. Do NOT add commentary.",
              "Validation issues:",
              ...violations.map((v, i) => `${i + 1}. ${v.section} — ${v.issue} (${v.fix_hint || "no hint"})`),
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
          } else if (!violations.length && parsedResult.desc_audit && typeof parsedResult.desc_audit.score === "number" && parsedResult.desc_audit.score < TARGET_AUDIT_SCORE && attempt < MAX_ATTEMPTS) {
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

      // If we have a parsedResult return it; else fallback (but enforce if requested)
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

        // Enforcement check: if strict, require Avidia compliance, otherwise return as-is
        if (ENFORCE_AVIDIA && !isAvidiaCompliant(parsedResult)) {
          console.error("gptEnforcer: model output failed Avidia compliance under enforcement", { attempts: attempt, violations: lastViolations });
          return res.status(422).json({
            error: "model_noncompliant",
            message: "model did not produce Avidia Standard compliant JSON within allowed attempts",
            _debug: {
              promptEngineInfo,
              attempts: attempt,
              lastModelTextPreview: String(lastModelText || "").slice(0, 8000),
              lastRepairTextPreview: String(lastRepairText || "").slice(0, 8000),
              violations: lastViolations,
              warnings: lastWarnings
            }
          });
        }

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

      // fallback response (if enforcement off) OR error if enforcement on
      if (ENFORCE_AVIDIA) {
        console.error("gptEnforcer: no compliant parsed result and enforcement active", { lastModelText: String(lastModelText || "").slice(0,1200) });
        return res.status(422).json({
          error: "model_noncompliant",
          message: "no compliant JSON result produced",
          _debug: {
            promptEngineInfo,
            attempts: attempt,
            lastModelText: String(lastModelText || "").slice(0, 8000),
            lastRepairText: String(lastRepairText || "").slice(0, 8000),
            violations: lastViolations,
            warnings: lastWarnings
          }
        });
      }

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
