# Core Compliance Rules

## BINDING & VALIDATION

* `<h1>` text must equal `name_best`.

* **H1 length hard check:** Require `90 ≤ name_len ≤ 110`. If `name_len < 90`, treat as a non-compliance. Add violation: `{"section":"Name","issue":"H1 shorter than 90 characters","fix_hint":"Append grounded feature descriptors or specs to reach 90–110 chars"}` 
The model must automatically revise the H1 until the lower bound is satisfied. GPT must attempt auto-expansion pass before finalizing.

* **Description length check:** Strip HTML and require 1200–32000 characters. If outside this range, set `desc_audit.passed = false`.

* **Short_name cap (verbatim):** The short_name must appear at most **2×** in the description body — once in the first sentence of the intro (bolded), and optionally once more in the Main Description or Why-Choose. If exceeded, auto-revise extra mentions with synonyms, pronouns, or descriptive variations.

* **Meta Title** length 60–65 chars. Hard cap 68. If out of bounds, revise.
* **Meta Description** length 150–160 chars and includes the primary keyword within the first 100 chars. If out of bounds or missing the keyword, revise.

* **Slug Enforcement**: The generated\_product\_url must equal "/" + slugify(name\_best). If length or word limits fail, or if a collision is detected, the slug must be rebuilt automatically. Do not fail QA for slug issues. Instead, add a machine note under `desc_audit.warnings` and log the resolution in `desc_audit.slug_resolution`. Sync to BigCommerce must continue with the auto-revised slug.

* **Bullet format** in all sections: bolded label plus en dash plus explanation. **Exception:** in Product Specifications, a colon after the label is allowed. If not, revise.

* **Variant Non‑Blocking Policy:** Variant detection or mapping issues never fail QA or block sync. Keep desc_audit.passed = true and include allow_sync = true. Report issues as desc_audit.warnings with codes that start with "VAR_". Variant-only warnings do not reduce the audit score.
* **Placeholder scan:** If any customer-facing HTML contains a banned placeholder phrase (case-insensitive, including variants like n/a, tbd, not available, information not disclosed), delete the affected line and omit the field.
* **Specs null handling:** Any spec without a concrete value must be omitted entirely, not labeled as unavailable. If a spec bullet contains a placeholder phrase, remove the bullet and log the gap in desc_audit.data_gaps.specs.
* **Warranty null handling:** The Warranty spec must appear ONLY when an explicit warranty string exists in inputs. If absent, the Warranty line must not be rendered.
* **FAQs** include **five to seven** Q\&A pairs. Each **question** uses `<h3>…</h3>`. Each **answer** is a paragraph. If not, revise.
* **Why-Choose** includes one short lead paragraph plus 3–6 bullets. If not, revise.

* **No placeholders in body:** Description body must not include "Not provided/unknown." Omit missing items instead.
* **Redundancy check:** Identical feature phrasing must not appear in more than one section.
* **Differentiator check (Why-Choose):** Require ≥1 bullet that states a competitive edge.

* **Slug Enforcement:** The `generated_product_url` must equal "/" + slugify(name_best). The slug must have ≤60 characters and ≤7 tokens. If the raw slug does not match normalization, or if length/token limits fail, or if a collision is detected, auto-revise the slug and log the resolution in `desc_audit.slug_resolution`. Do not fail QA or block sync for slug issues — instead, add a machine note under `desc_audit.warnings` and continue with the auto-revised slug.

* **Scenario line check:** Require ≥1 concise scenario sentence in Hook or Main Description that names likely users or use cases.
* **LSI coverage check:** Require ≥2 distinct secondary/LSI variants of the primary concept in body headings or copy.
* **Grounding scan:** Fail if any spec, capacity, material, accessory compatibility, or warranty term in the body lacks an exact or equivalent match in inputs.
* **Source-priority check:** Fail if a lower-authority value is used where a higher-authority value exists.
* **Stop on success** when `desc_audit.passed === true`.

---

## Additional Compliance Rules

1. **H1 expansion rule:** If the selected H1 (`name_best`) remains under 90 characters after the second pass, automatically expand it with grounded specs or features until it reaches **at least 90 characters**. Never emit a final `name_best` under 90 characters.
2. **Short‑name placement and limit:** Always use the generated `short_name_60` (not the full product name) in the very first sentence of the hook. Bold it once with `<strong>…</strong>`. Use it **no more than one additional time** later in the body. Replace any extra occurrences with synonyms or pronouns to respect the ≤ 2 verbatim limit.
3. **Manuals section requirement:** When any manuals evidence exists, insert a section titled `<h2>Manuals and Troubleshooting Guides</h2>` after Why Choose section and before the Frequently Asked Questions (FAQs) section. **Do not add this section when there are no manuals.**
4. **Manuals formatting rules**  
When generating the Manuals and Troubleshooting Guides section:
* Only include this section when there is actual evidence of manuals (i.e. at least one PDF link or non‑empty pdf_text from the input). Do not invent manuals or include the section when no manuals exist.
* The section must be inserted after the Why Choose section and before the Frequently Asked Questions (FAQs) section. Title the section <h2>Manuals and Troubleshooting Guides</h2> exactly.
* If multiple PDF URLs are provided, list them as a single bulleted list (<ul>). Each list item should contain an anchor tag where the link text follows the pattern "{short product name} – {cleaned file name}". The file name should be derived from the PDF filename, replacing underscores or hyphens with spaces and trimming file extensions.
* If only one PDF URL is provided, output a single paragraph (<p>) with the same anchor tag rather than a bulleted list.
* Never include PDFs in other sections of the description and never hyperlink the product name outside of the manuals section.
* Avoid duplicating the same manual name multiple times; each document should appear once.
5. **Slug length and tokens:** Set `generated_product_url` equal to `'/' + slugify(name_best)` with **≤ 60 characters** and **≤7 tokens**. The slug MUST be derived from the final product name (`name_best`), not from the manufacturer URL or any other source. Trim trailing tokens until both limits are met.
6. **Revision loop:** Continue description revisions until the audit score is ≥ 9.8 or `desc_audit.passed` is true with only `data_gaps` or variant warnings remaining. Allow up to three full revision iterations.

---

## Compliance Keyword Filter

* Descriptions must automatically flag risky or non-compliant terms such as:

  * "FDA approved"
  * "Covered by Medicare"
  * "Cures" or "diagnoses"
  * "Guaranteed results"
  * "Insured coverage"

* If any appear, insert a `compliance_redflags` block into the payload.

* Final descriptions must not pass unless all redflags are resolved or explicitly overridden.

**Example**

```json
"compliance_redflags": [
  {
    "phrase": "covered by Medicare",
    "section": "Main Description",
    "fix_hint": "Replace with compliant alternative such as 'designed for home use'"
  }
]
```

---

## Redundancy Elimination (Enforced)

* Remove duplicate or near-duplicate feature phrasing across sections.
* Keep a single canonical expression in the section where the feature is most appropriate and use different emphasis elsewhere.
* The auditor must add a `violations[]` entry when duplicates are detected.

## Placeholder Prohibition (Enforced)

* Description body must never include "Not provided/unknown."
* If a required line would otherwise be empty, omit the line; do not backfill with generic statements (e.g., "Standard 1-year warranty").
* Missing data → omit the line/QA.
* Auditor must add a `violations[]` entry if any placeholder appears in the body.
