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

- Validator must treat empty features_html (empty string or <ul></ul>) as a structural violation with fix_hint "Populate features_html with 2–4 H3 groups and 3–6 bullets derived from grounded inputs (pdf_text, specs, description_raw, features_raw)."
- Validator must treat empty faq_html or faqs as a structural violation with fix_hint "Provide 5–7 grounded Q&A pairs using input sources; if factual Q&As unavailable, create product-centered Q&As derived from the inputs but do not invent numeric facts."
- When the server receives a model response missing those sections, it should include these violations in the repair prompt and call the model again (up to MAX_ATTEMPTS). The repair prompt must include a short example JSON (see describePrompt example) so the model sees desired structure.

REPAIR PROMPT TEMPLATE (server to send when features/faqs empty)
- Title: "REPAIR: Populate Missing Sections"
- Body (user role):
  "Your previous JSON was missing required content. Populate features_html (2–4 H3 groups, total 3–6 bullets) and faq_html (5–7 Q&A pairs) using ONLY the provided grounding INPUT. Return only corrected JSON. INPUT:\n<modelInput JSON>\nPreviousOutput:\n<previous parsed JSON>\nValidationIssues:\n1) features_html empty — populate with grounded bullets\n2) faq_html missing — add 5–7 Q&A pairs\nExampleOutput: <small sample object snippet from describePrompt example>"

[End additions — keep remainder of canonical master prompt]
