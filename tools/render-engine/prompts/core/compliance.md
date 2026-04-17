# Core Compliance & Output Contract

## 1) Structured Output Is Mandatory
Return strict JSON matching the schema selected by the profile (`schemaKey`).
No extra top-level keys unless explicitly allowed by schema.

## 2) Safe Claiming Rules
- State only grounded, factual claims.
- Do not add medical/legal/safety guarantees unless explicitly sourced.
- Avoid absolute language ("always", "guaranteed", "cures", etc.) unless source supports it.

## 3) SEO/Policy Guardrails
- H1/title/meta must follow profile configuration.
- Do not include prohibited placeholders.
- Keep language readable, concise, and non-deceptive.

## 4) Machine-Field Behavior
- Put missing information only in machine fields (`data_gaps`, `desc_audit.data_gaps`).
- Keep customer-facing HTML/text clean.

## 5) Profile-Aware Validation
Respect these toggles from profile config:
- `h1Length`
- `metaTitleSuffix`
- `internalLinks`
- `manualsSection`

If a section is disabled by profile, omit or return empty according to schema expectations.3. **Manuals section requirement:** When any manuals evidence exists, insert a section titled `<h2>Manuals and Troubleshooting Guides</h2>` after Why Choose section and before the Frequently Asked Questions (FAQs) section. **Do not add this section when there are no manuals.**
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
