# MedicalEx MASTER PROMPT (wrapper)

This file is a small wrapper. At runtime the server should read the canonical instructions
from tools/render-engine/prompts/custom_gpt_instructions.md and use them as the system instruction.

Usage guidance for integrators (include in runtime docs):
- Load the canonical text (tools/render-engine/prompts/custom_gpt_instructions.md)
- Prepend any environment/runtime notes if necessary (e.g., tenant hints)
- Pass the loaded canonical text to the model as the "system" message.

Example (not part of the model prompt, for integrators):
1. const systemPrompt = loadCanonicalPrompt('custom_gpt_instructions.md')
2. messages = [{ role: 'system', content: systemPrompt }, ...user grounding messages...]

OPERATIONAL ADDITIONS FOR ENFORCER

This master wrapper must also document the runtime enforcement responsibilities for integrators and engineers. The sections below describe the server-side validation rules, the repair/loop behavior, unit normalization, title rules, short-name usage limits, and the repair prompt template the server will use when the model output fails structural checks.

1) Structural validation enforcement (server)
- The server MUST validate every model response JSON against the canonical AJV schema at tools/render-engine/schema/describeSchema.json.
- In addition to schema validation, the server MUST apply these extra structural checks and treat failures as schema/structure violations:
  - features_html:
    - Must be non-empty.
    - Must contain 2–4 H3 groups.
    - Must contain a total of 3–6 `<li>` bullets across those groups.
    - Each bullet must follow the pattern: `<li><strong>Label</strong> – Explanation.</li>`.
    - If violations occur, add a `desc_audit.violations` entry with section "Structure" and a clear fix_hint.
  - faq_html or faqs:
    - Must contain 5–7 Q&A pairs.
    - When using faq_html each question must be `<h3>` and each answer `<p>`.
    - Missing or out-of-range counts are structural violations.
  - main_description_title:
    - Must be present and non-empty.
    - Must NOT equal `name_best` (H1) verbatim. If equal, flag as violation with fix_hint: "Use a benefit/audience-focused H2 instead of the H1".
  - short_name_60 usage:
    - Exact verbatim occurrences of `short_name_60` in the body (hook, main_description_html, features_html, why_choose_html, specs_html, faq_html) must be <= 2.
    - If >2, add a style violation and request replacement of extra verbatim mentions with synonyms/variations.
  - Units:
    - Detect non-standard uppercase unit tokens (e.g., `IN`, `LB`, `ML`) in specs_html or other fields.
    - Flag formatting violation and request normalized units (e.g., `in`, `lb`, `oz`, `mL`, `µL`).
    - The server will normalize units in assembly, but the model should emit correct unit forms to avoid extra repair rounds.
  - Hook bullets:
    - Hook must contain 3–6 bullets in a single `<ul>` and follow the required bullet pattern.
  - Why-Choose:
    - Must include a short lead paragraph and 3–6 bullets; at least one bullet must be a measurable differentiator when grounded.

2) Grounding & evidence enforcement (server)
- The server expects all numeric specs, warranty terms, manual links, and other factual claims to be traceable to a source in the input packet.
- For each numeric spec, warranty, or manual link rendered in the body, ensure there is a corresponding `desc_audit.evidence` entry: `{ field, value, source, snippet_or_key }`.
- When the server resolves conflicts between sources it will populate `desc_audit.conflicts` with `{ field, chosen_source, discarded_source, note }` and prefer the higher-authority source (pdf_text/pdf_docs > specs/features_raw > description_raw > dom > browsed_text).

3) Repair loop behavior & response codes
- MAX_ATTEMPTS default = 3 (configurable via env var MAX_ATTEMPTS).
- On first model response:
  - Run AJV validation + the extra structural checks above.
  - If validation passes, assemble `description_html` (server-side) and return HTTP 200 with the structured JSON plus `_debug` info.
  - If validation fails, build a machine-actionable repair prompt listing the violations and call the model again (repair loop).
- Repair prompt requirements:
  - Include grounding `modelInput` (the exact object passed to the model).
  - Include the previous parsed JSON (`PreviousOutput`).
  - Include a numbered list of validation issues with clear `fix_hint` text.
  - Include a short example JSON snippet (see describePrompt example) demonstrating desired structure and counts.
  - Ask the model to "RETURN ONLY valid JSON" with fixes applied.
- If after MAX_ATTEMPTS validation still fails → return HTTP 422:
  - Body shape:
    {
      "error": "structured_validation_failed",
      "message": "Model output failed structured schema/structure validation after retries.",
      "violations": [ { section, issue, fix_hint }, ... ],
      "model_text_preview": "<truncated model output>",
      "attempts": <int>,
      "promptEngineInfo": { usedBuildPrompt: bool, buildError?: string }
    }
- If the model output is not parseable JSON at all, add violation `{ section: "JSON", issue: "Model output not parseable JSON", fix_hint: "Return a single JSON object" }`.

REPAIR PROMPT TEMPLATE (server to send when features/faqs/title/units/short_name errors found)
- Title: "REPAIR: Populate Missing Sections / Fix formatting"
- Body (user role), plain text:
  "Your previous JSON contained the following validation issues:
   1) <issue 1> — <fix_hint>
   2) <issue 2> — <fix_hint>
   ...
   Using ONLY the grounding INPUT below (pdf_text, pdf_docs, description_raw, features_raw, dom, browsed_text), produce corrected JSON that:
   - fixes each listed issue,
   - preserves all grounded facts,
   - does not invent numeric specs or manuals.
   INPUT:
   <modelInput JSON>
   PreviousOutput:
   <previous parsed JSON>
   ValidationIssues:
   <numbered list>
   ExampleOutput:
   <small JSON snippet showing required features_html with 2–4 H3 groups and 3–6 bullets, faq_html with 5–7 Q&As, benefit H2, and unit examples>
   RETURN ONLY THE CORRECTED JSON OBJECT (no commentary, no code fences)."

4) Server-side assembly & normalization rules
- The server will assemble `description_html` from the returned structured fields in the following order:
  1. `hook_html`
  2. `<h2>{main_description_title}</h2>` + `main_description_html`
  3. `<h2>Features and Benefits</h2>` + `features_html`
  4. `<h2>Product Specifications</h2>` + `specs_html` (server will normalize spec bullets to `<li><strong>Label</strong>: value</li>` and will normalize units to canonical casing)
  5. Internal links (if provided) inserted between Product Specifications and Why-Choose
  6. `<h2>{why_choose_title}</h2>` + `why_choose_html`
  7. `<h2>Manuals and Troubleshooting Guides</h2>` (if manuals present) + manuals list
  8. `<h2>Frequently Asked Questions</h2>` + faqs/faq_html
- During assembly the server will:
  - Normalize bullets to the en-dash pattern where appropriate for hook/features/why-choose.
  - Normalize spec bullets to bold label + colon pattern and canonical unit casing.
  - Remove any HTML placeholders or banned placeholder phrases if present (but placeholder presence is a violation and must be recorded in desc_audit).

5) Short-name & variation enforcement (server)
- The server will count exact verbatim `short_name_60` uses and token overlap to detect overuse.
- If exact verbatim uses >2, add violation and include suggested replacement fix_hint.
- The server will not automatically rewrite model output except in controlled fallback modes; instead it requests model repairs via the repair loop.

6) Unit normalization & warnings (server)
- The server will normalize common uppercase tokens to canonical casing (e.g., `IN` -> `in`, `LB` -> `lb`, `ML` -> `mL`) during assembly.
- If the model emits non-standard casing, server issues a formatting violation and requests correction in the repair loop. Repeated non-standard unit emissions across many items should be surfaced to model authors.

7) Observability & metrics to emit
- Emit and record metrics for:
  - total_requests
  - success_responses
  - validation_failures
  - avg_attempts
  - avg_latency_ms
  - model_timeouts
  - manual_validations_failed
  - missing_features_count
  - faq_count_mismatch
  - title_equals_h1_count
  - unit_normalization_fixes
  - short_name_overuse_count
- Capture a truncated `model_text_preview` for failed validations (PII redaction required).

8) Local development / fallback
- When `OPENAI_API_KEY` is not set, server returns a deterministic mock structured JSON to support local dev and CI smoke tests. Document this behavior in runtime docs and ensure tests account for mock mode.

9) Security & privacy
- Do not include provider API keys, engine secrets, or user PII in responses or `_debug` previews.
- Redact emails, phone numbers, SSNs, and similar PII in logs and stored previews.

10) Backwards compatibility & rollout
- If adding stricter schema requirements (new required fields or stricter counts), gate via a runtime toggle and provide a migration window so existing model runs do not suddenly fail.
- Log and chart the 422 validation rate after rollout to monitor regressions.

11) CI & smoke tests (recommended)
- Add a smoke test that posts a representative fixture to `/describe` and asserts:
  - HTTP 200 when model present (or mock behavior in local mode)
  - `features_html` contains at least 1 H3 and at least 3 `<li>` entries (prefer full 2–4 H3 and 3–6 bullets)
  - `faq_html` or `faqs` contains 5–7 Q&As
  - `main_description_title` does not equal `name_best`
  - `specs_html` units are canonical or server-side normalized
  - `desc_audit` exists and includes `score` and `passed` booleans

SUMMARY
- This wrapper documents the runtime contract: load canonical instructions as the system prompt, pass grounding input as user messages, and rely on the server enforcer to run AJV + additional structural checks (features/faqs counts, H2 title vs H1, units, short_name usage).
- When validation fails, the server will use the repair prompt template to request corrected JSON from the model (up to MAX_ATTEMPTS) and return machine-actionable failures if unresolved.

If you'd like, I can:
- produce a PR updating tools/render-engine/prompts/masterPrompt.md with this content,
- add a smoke test fixture and CI job to assert the main checks,
- or create a short checklist for QA to validate these behaviors after deployment. Which would you like next?
