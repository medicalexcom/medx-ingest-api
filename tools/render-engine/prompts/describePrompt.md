# Describe prompt (wrapper)

This file points model authors and the runtime to the canonical instruction file.

Short instructions for model runs:
- Use the canonical instructions in tools/render-engine/prompts/custom_gpt_instructions.md as the authoritative system prompt.
- Return ONLY the structured JSON object defined in the canonical schema (tools/render-engine/schema/describeSchema.json).
- The server will handle schema validation, repair loops, unit normalization, and final HTML assembly.

Integrator note:
- The server should call the helper `loadCanonicalPrompt()` to build the system message for /describe model calls.
- The runtime enforcer will validate the output and may request repairs (see Repair Prompt Template in runtime docs).

ADDITIONAL REQUIREMENTS: REQUIRED CONTENT COUNTS, TITLE RULES, UNITS, SHORT-NAME LIMITS & EXAMPLE OUTPUT

1) Strong requirement: Non-empty sections & counts
- features_html MUST be non-empty and include 2–4 H3 groups and a total of 3–6 `<li>` bullets across those groups. Each bullet must follow the exact pattern:
  `<li><strong>Label</strong> – Explanation.</li>`
- faq_html OR faqs MUST contain 5–7 Q&A pairs. When using faq_html, each question must be `<h3>…</h3>` and each answer a `<p>…</p>` paragraph.
  - If factual Q&As cannot be grounded from input sources, create 5–7 neutral, product-centered Q&As derived only from available inputs (do NOT invent numeric specs; omit any numeric bullet that cannot be grounded and record it in `desc_audit.data_gaps`).
- internal_links should contain up to 2 site-relative links (subcategory and brand hub) when category or brand is present in inputs. The server will sanitize and reject absolute/external links.
- manuals or manuals_html must be present when any validated PDF URL exists in `pdf_manual_urls`/`pdf_docs`/`manuals`/`pdfs`. Follow the Manuals rules in the canonical instructions.

2) Main Description title (dynamic H2)
- `main_description_title` MUST be an H2-style benefit or audience-focused title (e.g., "Polyurethane Foam Swab for Accurate and Comfortable Collection"), NOT the H1/name_best repeated verbatim.
- The server will flag a violation if `main_description_title` equals `name_best` exactly and request a repair to a benefit-oriented H2.

3) Units & International standard formatting
- Use standardized unit abbreviations and casing in all returned fields:
  - Examples: `in`, `ft`, `cm`, `mm`, `m`, `g`, `kg`, `lb`, `oz`, `mL`, `µL`
- Avoid uppercase tokens like `IN`, `LB`, `ML`. Preferred formatting: `25 mL`, `3 in`, `5 lb`.
- The server will normalize units in `specs_html` but will issue a repair request if model output uses non-standard casing. Prefer emitting correct units to avoid extra repair rounds.

4) Short name usage (strict)
- `short_name_60` must be bolded once in the first sentence of the hook using `<strong>...</strong>`.
- The short name may appear verbatim in the body at most twice (first sentence of the hook + one optional additional exact occurrence in Main Description or Why-Choose).
- After the first mention, prefer synonyms and descriptive variations (e.g., "this collection device", "the [brand] swab") — avoid repeating tokens from `short_name` excessively.
- The server will flag and request repairs when exact `short_name_60` usage exceeds 2 occurrences or when tokens from the short name are excessively repeated.

5) Use all grounding sources (priority and evidence)
- When building `features_html`, `main_description_html`, and `why_choose_html`, prefer sources in this authoritative order:
  1. `pdf_text` / `pdf_docs` (manuals/specs)
  2. structured `specs` / `features_raw`
  3. `description_raw` / `sections`
  4. `dom`
  5. `browsed_text`
- Where you include numeric specs, materials, warranty terms, or manual links, add machine evidence entries under `desc_audit.evidence` showing `{ field, value, source, snippet_or_key }` to prove grounding.
- If sources disagree, prefer the higher-authority source and include a `desc_audit.conflicts` entry explaining the resolution.

6) Formatting & patterns (enforced)
- Hook bullets, Features bullets, and Why-Choose bullets use en dash pattern:
  `<li><strong>Label</strong> – Explanation.</li>`
- Spec bullets must use colon format with bold label before colon:
  `<li><strong>Label</strong>: value</li>`
- Bullets must be one or two short sentences; each explanation starts with a capital letter and ends with a period.
- No Markdown in output; use HTML tags only.

7) Example output pattern (model must follow the exact structure)
Return only JSON (the server will parse and validate). Example snippet (trimmed for brevity):

```json
{
  "hook_html": "<p><strong>Short Name</strong> short intro sentence with empathy + outcome. Scenario sentence naming likely users.</p><ul><li><strong>Patented Polyurethane Foam Tip</strong> – Provides gentle specimen collection, supporting patient comfort.</li><li><strong>Sterile, Single Swab Format</strong> – Reduces contamination risk, ensuring accurate results.</li><li><strong>Media-Free System</strong> – Simplifies handling and storage.</li></ul>",
  "main_description_title": "Polyurethane Foam Swab for Accurate and Comfortable Collection",
  "main_description_html": "<p>This sterile collection swab features a patented polyurethane foam tip, engineered for optimal patient comfort during wound specimen collection. The media-free design eliminates the need for transport media, making the system simple to use and easy to store. Laboratory professionals and clinicians benefit from a streamlined process that supports diagnostic accuracy and efficiency. The single swab format helps reduce contamination risk, while the 100 shelfpack packaging is ideal for high-volume settings.</p>",
  "features_html": "<h3>Comfort and Patient Experience</h3><ul><li><strong>Polyurethane Foam Swab</strong> – Designed for gentle contact, enhancing patient comfort during specimen collection.</li><li><strong>Single Swab Format</strong> – Minimizes handling and supports precise sampling for wound care and microbiology.</li></ul><h3>Workflow Efficiency</h3><ul><li><strong>Media-Free System</strong> – Eliminates the need for transport media, simplifying storage and reducing preparation time.</li><li><strong>Bulk Shelfpack Packaging</strong> – 100 swabs per shelfpack, supporting high-throughput clinical environments.</li></ul>",
  "specs_html": "<h3>Packaging and Identification</h3><ul><li><strong>SKU</strong>: 220144</li><li><strong>Quantity Per Shelfpack</strong>: 100</li></ul>",
  "why_choose_title": "Reliable Collection and Patient Comfort in Every Use",
  "why_choose_html": "<p>Choose this polyurethane foam swab for a collection device that balances accuracy, comfort, and workflow efficiency. The sterile, media-free system is designed to meet the needs of busy clinical teams, offering dependable performance and ease of use.</p><ul><li><strong>Patented Foam Tip</strong> – Unique polyurethane design offers a gentler experience than traditional swabs.</li><li><strong>Bulk Packaging Advantage</strong> – 100 shelfpack format reduces restocking frequency and supports busy labs.</li><li><strong>Media-Free Simplicity</strong> – No transport media required, streamlining your workflow and storage needs.</li></ul>",
  "faq_html": "<h3>What is the tip material of this swab?</h3><p>The swab features a patented polyurethane foam tip for gentle specimen collection.</p> ... (5–7 Q&A pairs) ...",
  "name_best": "...",
  "short_name_60": "...",
  "desc_audit": { "score": 9.8, "passed": true, "violations": [], "data_gaps": [], "evidence": [ ... ] }
}
```

8) Repair behavior & server actions
- If `features_html`, `faq_html/faqs`, `main_description_title` (equals H1), `short_name` overuse, or non-standard units are detected, the server MUST trigger a repair loop:
  - The server will return a machine-actionable violation list and a repair prompt (see runtime docs).
  - The repair prompt will include the grounding `modelInput`, the previous parsed JSON, and a clear list of issues (counts, formatting, title equality).
  - The model MUST respond with corrected JSON only.
- The server will attempt up to `MAX_ATTEMPTS` repair rounds (default 3). If validation still fails, /describe returns HTTP 422 with `violations` and a truncated `model_text_preview`.

9) Use of grounding and non-invention
- Do NOT invent numeric specs, capacities, warranty terms, or manuals. If a fact is missing, omit the bullet/line and add an entry to `desc_audit.data_gaps`.
- If `features_raw`, `specs`, or `pdf_text` lack enough detail, prefer improving ingestion rather than forcing hallucinated features.

10) Observability suggestion for integrators
- Log and metricize:
  - missing_features_count (increment when features_html empty)
  - faq_count_mismatch
  - title_equals_h1_count
  - unit_normalization_fixes
  - short_name_overuse_count

4) If features_html or faq_html are empty in the model output, server MUST trigger an explicit repair prompt instructing the model to re-run and populate those sections using only grounded inputs. See the repair prompt template in runtime docs.

[End additions — keep remainder of canonical instructions intact]
