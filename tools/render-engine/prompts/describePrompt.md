# Describe prompt (wrapper)

This file points model authors and the runtime to the canonical instruction file.

Short instructions for model runs:
- Use the canonical instructions in tools/render-engine/prompts/custom_gpt_instructions.md as the authoritative system prompt.
- Return ONLY the structured JSON object defined in the canonical schema (tools/render-engine/schema/describeSchema.json).
- The server will handle schema validation, repair loops, and assembly.

Integrator note:
- The server should call the helper `loadCanonicalPrompt()` to build the system message for /describe model calls.

ADDITIONAL REQUIREMENTS: REQUIRED CONTENT COUNTS & EXAMPLE OUTPUT

1) Strong requirement: Non-empty sections
- features_html MUST be non-empty and include 2–4 H3 groups and a total of 3–6 <li> bullets. Each bullet must follow the pattern:
  <li><strong>Label</strong> – Explanation.</li>
- faq_html OR faqs MUST contain exactly 5–7 Q&A pairs. If no factual Q&A can be grounded, add 5–7 neutral, product-centered Q&As derived from inputs (do NOT invent numeric specs—use only grounded facts; if a numeric value is missing then omit that bullet and log it in desc_audit.data_gaps).
- internal_links should contain up to 2 site-relative links (subcategory and brand hub) when category or brand is present in inputs.
- manuals or manuals_html must be provided when any validated PDF URL exists in pdf_manual_urls/pdf_docs.

2) Use all grounding sources
When building features_html and the Main Description, use these fields (in priority order):
  pdf_text, pdf_docs, description_raw, features_raw, dom, browsed_text.
If a section would otherwise be empty, search all input fields for any semantically relevant sentences, transform them into feature bullets, and cite evidence entries under desc_audit.evidence.

3) Example output pattern (model must follow the exact structure)
Return only JSON. Example portion (trimmed) showing the richer output expected:

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

4) If features_html or faq_html are empty in the model output, server MUST trigger an explicit repair prompt instructing the model to re-run and populate those sections using only grounded inputs. See the repair prompt template in runtime docs.

[End additions — keep remainder of canonical instructions intact]
