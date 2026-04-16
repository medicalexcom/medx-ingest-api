# BigCommerce Longform Channel Rules

This file contains the structure and content generation rules specific to BigCommerce's longform product description format.

---

## PRE-STEP: PRODUCT NAMING & DESCRIPTION SEO SELF-AUDIT (MANDATORY)

This pre-step runs before any output is returned. It has two parts.

### Naming

* Generate exactly 3 H1 candidates → score each 0–10 → pick best → self-rate best.
* If self-rating < 9.8, produce one improved revision and keep the higher-scoring one as `name_best` (Product Name).
* The `<h1>` in the final output must equal `name_best`.
* Enforce the 90–110 character H1 rule.
* Compute `name_len = length(name_best)` counting spaces.
* If `name_len < 90`, **append** 1–2 high-value specs from inputs, comma separated. Use unit shorteners: ounces → oz, pounds → lb, inches → in.
* If `name_len > 110`, **shrink** by removing the weakest trailing spec segment, de-duplicating words, and shortening units. Never drop brand or the primary keyword.
* Allow up to **2 revision passes**. If `name_len < 90` after the second pass, the name must be expanded automatically using additional grounded feature descriptors (materials, mechanisms, dimensions, capacities) until it reaches at least 90 characters. Do not emit a final name under 90 characters.
* **Return** `name_len` and `name_length_ok` in the function output.
* Also produce `short_name_60` (≤ 60 chars) for use outside H1.
* **Short-name brand normalization (multi-word brands):** When generating `short_name_60`, if the brand contains 2 or more words, use only the **first brand word** in the short name. Example: brand = "Aspen Surgical" → short_name starts with "Aspen", not "Aspen Surgical".
* Preserve the full brand in `name_best` (H1) unless another H1 sanitization rule requires removal of invalid tokens.

### Draft → Audit → Auto-Revise (max 2 passes)

After selecting `name_best`, the model must:

#### Draft the full description package (one pass)

Generate a complete draft in the exact order and with the exact formatting rules laid out in **Sections 6–11**.

* Use all four data sources (`pdf_text`, `pdf_docs`, `dom`, `browsed_text`).
* Respect every HTML, metadata, and length constraint.
* If any required detail is missing, OMIT that specific bullet/spec/FAQ from the customer-facing body. Do not print placeholders. Surface absences only in machine fields (e.g., `desc_audit.data_gaps`).

#### Run the Description SEO/Compliance Audit

Compute a 0–10 score with this rubric:

**Revision thresholds:**

* `desc_audit.score < 9.5` → always re-audit and auto-revise.
* `9.5 ≤ score < 9.8` → attempt one optimization pass for semantic or authority improvements.
* `score ≥ 9.8` → stop; mark passed.
The system accepts any version with `score ≥ 9.5` as passable (`desc_audit.passed = true`), even if GPT aims for 9.8 ideal.
For every product description, perform an SEO audit and include:
"desc_audit": {
  "score": [numeric value between 0 and 10],
  "passed": true/false,
  "violations": [array of issues, or empty if passed]
}
The score must always be a real numeric value.

1. **Structure & Completeness (0–2 pts)**

   * **H1 length compliance (0.25 pt):** passes if 90–110, else deduct and trigger auto-revise.
   * **Sections & Order (1 pt):** All required sections present, in sequence. H1. Hook. Bullets. Main Description. Features and Benefits. Product Specifications. Internal Links. Why-Choose paragraph plus 3–6 bullets. Manuals and Troubleshooting Guides (conditional). FAQs 5–7.
   * **HTML Tags & Counts (0.5 pt):** Correct use of H1–H6, `<p>`, `<ul>/<li>`, and correct counts for bullets and FAQs.
   * **Redundancy control (0.25 pt):** No duplicate or near-duplicate feature phrasing across sections (e.g., "Adjustable Height Range" vs "Height Adjustability"). Flag if repeated.

2. **Keyword Optimization & On-Page SEO (0–3 pts)**

   * **Primary Keyword (1 pts):** Appears in H1, within the first 100 words, and once in meta title and meta description.
   * **Secondary/LSI Keywords (1 pt):** Use at least **two distinct semantic variants** of the primary concept, naturally (e.g., for pain gels: topical analgesic, cooling therapy gel, sports recovery gel). Keep density ~1–2%.
   * **No Stuffing & Short Name Compliance (1 pt):**

     The `short_name` appears **no more than 2× verbatim** (intro-first paragraph + optional closing).
     Any excess repetitions must be replaced with synonyms or natural descriptive variations.
     Deduct 0.5 pts if `short_name` >2×. Deduct full 1 pt if overuse remains after revision.

3. **Synonym Rotation (0.5 pt)**

   * For any core concept mentioned 3 or more times across sections, use at least two distinct synonyms or phrasings. Deduct 0.5 pt if unmet.

4. **Metadata Compliance (0–2 pts)**

   * **Meta Title (1 pt):** Core title 60–65 characters with a hard cap of 68, excluding the store suffix. Ends with the store suffix.
   * **Meta Description (1 pt):** 150–160 characters; includes the primary keyword within the first 100 chars and ends with a CTA. Summarizes benefits and features.

#### Auto-Revise when score < 9.8 or any violation exists

* The H1 name revision has a separate limit of 2 passes.

**Stop Rule (single source of truth)**
Perform up to **three full revision iterations** for the description package.
- **Stop early** when `desc_audit.passed === true` **and** any remaining shortfall is **solely** missing factual inputs (data gaps, variant warnings, or slug warnings). Set `allow_sync = true`.
- Otherwise, continue revising until `desc_audit.score ≥ 9.8` or iteration 3, whichever comes first.
- If iteration 3 ends with score < 9.8 **due only to missing inputs**, return the highest‑scoring version with `desc_audit.passed = true` and a populated `data_gaps` block.
- If structural violations remain after iteration 3, return the highest‑scoring version with `desc_audit.passed = false` and explicit `violations`.

#### Result Emission (Tools Mode)
* When the draft and audit are complete, return a single **function call** to `auditResult` with:
{name_candidates, name_best, name_best_seo_score, name_best_feedback, name_best_revision, short_name_60, desc_audit{score, passed, violations[]}, product_name, generated_product_url, description_html, meta_title, meta_description, search_keywords, image_alts, internal_links, body_cta, final_description}

---

## DESCRIPTION STRUCTURE & WRITING GUIDELINES

All marketing copy, bullets, and structured sections go here. Do not include the H1 or Search Keywords in this block.

### Hook and Bullets

**Emotional Lead (Hook)**

* Two or three sentence introduction including **one empathy clause** that recognizes the buyer's situation, plus **one outcome clause** that frames how life feels with the product.
* Front-load the short_name naturally in the opening line.
* Include **one scenario sentence** naming likely users or use cases (e.g., athletes, post-workout routines, sensitive-skin users), tied to a concrete feature. One sentence only.
* Keep factual claims grounded in the inputs. No medical promises.

**Bullets — Emotional Payoff**

* Three to six short, scannable bullets.
* Each bullet ends with a short **user outcome/feeling** phrase (still 1–2 sentences total).
* Each bullet follows Feature → Why it matters → User benefit.
* Pattern: `<strong>[feature]</strong> – [function/benefit], [emotional payoff].`

**Examples**

* `<strong>Orthopedic Handle</strong> – Reduces hand strain during long use, helps you feel steadier through the day.`
* `<strong>Adjustable Height</strong> – Sets up in minutes for a precise fit, adds confidence in every step.`
* `<strong>Ultra-Light and Foldable</strong> – Weighs 12 lb and packs flat for mobile clinicians.`
* `<strong>Reinforced Aluminum Frame</strong> – Resists rust for long-term reliability in clinics.`

*(Avoid "you can/may"; use "helps you feel," "adds confidence," "keeps you steady.")*
**Avoid duplicate phrasing:** If a concept appears in multiple sections, vary the wording and highlight a different benefit. Do not repeat the same label + claim combination across sections.

### Main Description (H2 with dynamic sub-heading)

* Generate an engaging H2 using a **keyword variation** (not the full product name and not short\_name) and a core benefit.
* **Intro paragraph** four to six sentences. Define the product and audience. Surface the key benefit and the problem it solves. Integrate primary and secondary keywords naturally within the first 100 words. Stay persuasive and compliant.
* Include **one buyer-outcome sentence** (emotional payoff) that stays factual and non-medical.
* Include **at least two LSI/semantic variants** of the primary concept across the H2 title and paragraphs.
* If the scenario sentence is not used in the Hook, **require it here** as a single sentence tied to a concrete feature.
* Avoid jargon and exaggeration. Keep the rest natural, using variations/synonyms.
* Use varied sentence lengths and active voice. Address the reader.

*Example (generic pattern):*
`Designed for daily routines at home or in clinic, it helps reduce strain and supports steady movement for a calmer day.`

### Features and Benefits (H2 with H3 groups + bullets)

**Logical Grouping (H3)**

* Divide into **two to four** related groups.
* Each group uses a clear, descriptive H3 that includes a secondary keyword.

**Bullet Format**

* Under each H3, list features as **single-line bullets** that follow this exact pattern.

  * `<strong>[feature name]</strong> – [concise function and user advantage]`
* Feature name is in `<strong>`. Follow with an **en dash (–)**. Then a one or two sentence benefit that merges why it matters with the user payoff.

**Write with Precision**

* State the **function**, **material**, or **advantage**.
* **No vague claims:** Do not use generic phrases such as "sturdy construction" unless paired with a concrete basis found in inputs (e.g., "steel frame," "reinforced joints," "tested to 250 lb"). If no basis exists, remove the generic phrase.
* Avoid vague adjectives. Be specific about what the feature does and how it helps.
* Avoid repeating the same benefit wording across groups. If "greaseless/clear/no dyes" appears in one group, vary phrasing in others or replace with a different factual benefit.
* **Omit unknowns:** If a spec value isn't present in inputs, omit that spec line rather than inserting a placeholder.

### Product Specifications (H2 with H3 groups + bullets)

**Logical Grouping (H3)**

* Divide specs into **two to four** thematic groups.
* Each group uses a clear H3 that includes a keyword variation.

**Bullet Format**

* Under each H3, list specs as **single-line bullets** that follow this exact pattern.

  * `<strong>[spec name]</strong>: [imperial measurement] ([metric equivalent])`
* Put the spec name in `<strong>`, followed by a colon, then imperial first with metric in parentheses.

**Write with Precision**

* Use **consistent phrasing** such as Length, Width, Height, Weight, Capacity.
* Avoid filler words. State exact values and units.
* Include unique technical details when applicable such as Max pressure, Load rating, Battery life.
* No 'Not provided' in core specs. Research and populate or omit/skip the specification.
* Always extract and include **quantity per pack or packaging count** when provided (e.g., "100/bx", "10 units/case"). Format as: `<strong>Quantity Per Pack</strong>: 100/bx` or `<strong>Packaging Count</strong>: 10 units/case`. If multiple forms exist (e.g., box and case), include both.
* **Packaging by Size:** When packaging differs by size, include a single parent‑level bullet summarizing the map, for example `<strong>Packaging by Size</strong>: XS–XL 100/bx, 10 boxes/case; 2XL 90/bx, 10 boxes/case`. Also include exact values per variant inside the `variants` objects.

**Placement Rule for Warranty**

* Warranty must be the final bullet of the most technical H3 group. If multiple terms exist, preserve each clause separated by commas.
* **Grounded Warranty Only:** Print the Warranty line ONLY when the inputs include an explicit warranty string. Do not normalize or invent terms. If no explicit text exists, omit the Warranty line. If multiple clauses exist, preserve each clause, if none exist, omit the Warranty line entirely. Never use filler phrases such as "warranty information not available
* Format exactly the same as other specs.

### Internal Linking

* Provide suggestions in the final JSON as an `internal_links` block.
* Placement is handled by these instructions, which inserts links before "Why Choose".
* Use site-relative URLs only. No placeholders or instructions about links in the body.

---

## WHY CHOOSE (H2)

* Dynamic H2 that mentions the most compelling benefit (no verbatim full name or short\_name). Do not always start with "Why Choose".
* **Lead paragraph** two to four sentences. Clear value proposition versus generic options. Address the reader directly. Include **one reassurance line** (comfort, stability, ease) that is **non-medical** and derived from real features. Implicitly compare against generic alternatives.
* **Bullets** three to six items. Each is a distinct competitive advantage, formatted as `<strong>Feature</strong> – why it matters – user payoff`. Include **at least two bullets** that state a **buyer outcome** (comfort, confidence, peace of mind) tied to a concrete feature.
* **One bullet must be a differentiator:** Highlight a specific edge (e.g., higher capacity vs typical models, longer warranty, ergonomic advantage). Do **not** name competitors.
* **Do not reuse any bullet label text** already used in Hook bullets or Features and Benefits.
* Keep scannable, benefit-focused, and conversational. Avoid repetition.

*Example bullet patterns (generic):*
* `<strong>Comfort Focus</strong> – Ergonomic contact points lower strain, supports relaxed use during longer sessions.`
* `<strong>Steady Performance</strong> – Frame and fit stay consistent, helps you move with confidence day after day.`

---

## MANUALS AND TROUBLESHOOTING GUIDES (H2) — conditional

**Trigger**
Render this section when **any** of the following fields is non‑empty:
- `pdf_docs` (any object with a .pdf URL)
- `pdfs` (any object with a .pdf URL)
- `documents` (any object with a .pdf URL)
- `pdf_text` (any text)
- `pdf_manual_urls` (any object with a .pdf URL)
- `manuals` (any object with a .pdf URL)
- `anchors` (any object with a .pdf URL)
- `links` (any object with a .pdf URL)

If only **all seven** are empty, the section is **forbidden**.

**Placement**
After "Why Choose" and **before** FAQs.

**H2 text**
Exactly: `Manuals and Troubleshooting Guides`.

**What to render**
- If one or more validated PDF URLs exist in `pdf_docs`, `pdfs`, `manuals`, `pdf_manual_urls`, `manuals`, `links` or `anchors`, list **all** of them (deduplicated).
  - **One manual:** render a single `<p>` with one `<a>` link.
  - **Multiple manuals:** render a single `<ul>` with one `<li>` link per document.

**Link text format:** `[short_name] – [Document Title]`
**Always precede each PDF label with the product's short name**, which is the product's **best_name** truncated before the first dash (–). Example: for "McKesson 3‑in‑1 Commode Chair – Small", the short name is "McKesson 3‑in‑1 Commode Chair".
A **Document Title or document name** is the PDF name of the document on the manufacturer's website in title case.
Do not insert truncated label displaying only just the document title without the short_name.
Each inserted manual must follow this format.

---

## FREQUENTLY ASKED QUESTIONS (FAQs) (H2)

* FAQs include **five to seven** Q\&A pairs.
* Each **question** uses `<h3>…</h3>`.
* Each **answer** is a paragraph of one or two sentences.
* Include long-tail keyword variants naturally.

**Example**
`<h3>How much weight does this model support?</h3>`
`This model supports up to 300 lb (136 kg) due to its reinforced aluminum frame.`

---

## SEO-OPTIMIZATION

Includes Search Keywords, Meta Title, Meta Description, URL Structure, and Smart Keyword Placement.

### Search Keywords [Not to be inserted in the description]

* Provide five to ten comma-separated, lowercase terms.
* Mix broad, product-specific, and long-tail.
* Reflect real buyer intent and spec-driven intent.
* No duplicates or special characters.
* Ready to paste into metadata or on-site search.

### Meta Title

* Target **60–65 characters**, **excluding** the store suffix.
* Apply a **hard cap of 68 characters** for the core title (before suffix).
* Every meta title must **end with** the store suffix.
* Structure: `[primary keyword] – [top feature or benefit] | STORE_NAME`
* If total (core + suffix) exceeds ~80 characters, truncate the core portion at a full word boundary to stay within limit.
* The suffix must always exist in the HTML, even if truncated visually.

### Meta Description

* Write meta descriptions between **150 and 160 characters** (soft range; hard cap 160).
* Must include the **primary keyword within the first 100 characters**.
* Must end with a **clear CTA**, e.g., "Shop now!", "Order today for fast delivery", or another approved phrase.
* Structure: benefit lead-in → 2–3 grounded features → CTA.
* Never exceed 160 characters total.
* If shorter than 140 characters, auto-expand using a grounded benefit + CTA ("Shop now!").
* Plain text only.

### URL Structure

* Generate from `name_best`, prefix with "/", then enforce **max 7 tokens** and **max 60 characters**.
* Drop weak trailing tokens until both caps are met. Prefer dropping descriptors before dropping the brand. If still over, drop the brand next, then continue trimming.
* Remove SKUs and non-essential stop-words. Preserve meaningful numbers and units.
* Do not re‑expand the slug during auto‑revise. Once trimmed, it remains trimmed for this run.
* If the raw slug does not match normalized output (enforceSlugPolicies), auto-revise and log resolution in `desc_audit.slug_resolution`.
* If a collision is detected, append one grounded differentiator, then re‑trim to caps. If still colliding, append a short hash and re‑trim.

### Smart Keyword Placement & Variation Control

* **Semantic Variations:** Use at least **two** LSI variants for the primary concept in headings or body (e.g., topical analgesic, cooling therapy gel, sports recovery gel). Do not repeat any one variant more than once in body copy.

* **Full Product Name (exact, long form):** Allowed **only in H1** (outside the description body). Do not use the full product name verbatim anywhere in the body.
* **short\_name (≤ 60 chars):** Verbatim `short_name` is allowed only twice in the **body copy** — once bolded in the first paragraph and optionally again in the Main Description or Why Choose. Mentions in metadata (`Meta Title`, `Meta Description`) are exempt from this limit.

  * Use **once** in the **first sentence of the intro-first paragraph**, and **bold it** there.
  * Optional one additional verbatim use in Main Description or Why-Choose.
  * **Body cap:** Verbatim `short_name` usage in body ≤ **2×** (intro + one optional repeat). Audit must flag and auto-revise excess.
  * Also include **short\_name** in **Meta Title** and **Meta Description** (metadata usage does not count toward body limits).
  * Exception for Manuals: Using the short_name in Manuals link text is allowed and does not count toward short_name caps or the "full name only in H1" rule.
* **No further verbatim uses** of the full product name or short\_name in the body. Use synonyms, brand + generic terms, or descriptive variations for all subsequent mentions.
* **Variation requirement:** After the first mention, **use at least two distinct variations** across the body, such as brand plus generic term or category synonyms. Auditor must flag if fewer than two variations appear.
* Use secondary synonyms in bullets, features, and FAQs.
* Add long-tails in H2s and FAQs to match intent.
* Integrate secondary/LSI keywords naturally every 100–150 words without forcing.
* **No invention:** Do not introduce new feature terms, measurements, or compatibility phrases for keyword variety. Variations must restate known facts only.

---

## REQUIRED SECTIONS AND THE MANUALS EXCEPTION

* Product Name (H1 — not part of the description body)
* Hook and Bullets
* Main Description (H2 with paragraph\[s])
* Features and Benefits (H2 with H3 groups plus bullets)
* Product Specifications (H2 with H3 groups plus bullets)
* Internal Links
* Why Choose (H2 with lead paragraph plus 3–6 bullets)
* Manuals and Troubleshooting Guides (H2) — if included, must appear after "Why Choose" and before FAQs.
* Frequently Asked Questions (FAQs) (H2 with 5–7 Q\&A)
* SEO-Optimization (Search Keywords, Meta Title, Meta Description, URL Structure)

---

## Internal Linking Suggestions (REQUIRED & pattern-based)

Return an `internal_links` array in the final JSON with up to two items (subcategory hub and brand hub; accessories if obvious). Insert exactly two links in the description body specifically after the "Product Specifications" section and before the "Why Choose" section.

**URL Patterns (no LinkMap present):**
- Subcategory hub: build using slug rules. `/{category-slug}/`
  Example: "Diagnostic Products \> Thermometers" → `/thermometers/`
- Brand hub: `/{brand-slug}/`
  Example: "Drive Medical" → `/drive-medical/`
- Accessories (only if clearly implied by leaf category): `/{full-category-path}/{leaf-slug}-accessories/`

**Slug rules (must be deterministic):**
- Lowercase, ASCII-folded (strip accents).
- `&` → ` and `
- Non-alphanumeric → single hyphen.
- Trim leading/trailing hyphens.

**Dynamic Anchors (Required – Use Based on Placement Context)**

Used for links embedded in the **body** of the product description or under **Explore More** when referring to **category/brand/accessory** hubs.

**Approved Formats**:

* `See all {Leaf}` → e.g., `See all Forearm Crutches`
* `Shop more {Brand} Products` → e.g., `Shop more Compass Products`
* `Browse {Leaf} accessories` → e.g., `Browse Rollator accessories`

**Rules**:

* Always short, factual, and lowercase-friendly.
* Insert only **after Product Specifications and before Why Choose**. Never place internal links earlier or later than this position.
* Do not use promotional CTAs here (no verbs like "Order," "Get," etc.).
* Must not link to current product page.

**Schema:**
"internal_links": [
  {
    "type": "subcategory", // or "brand" or "accessories"
    "anchor": "See all Thermometers",
    "url": "/diagnostic-products/thermometers/",
    "confidence": 0.9
  }
]

**Constraints:**
- Max 2 items.
- Never suggest a link to the current product page.
- Use only site-relative URLs (start with "/").
- Keep anchors neutral (no CTAs, no exclamation points).

**HTML Format Example**
<p class="explore-links"><strong>Explore More:</strong> <a href="/forearm-crutches/">See all Forearm Crutches</a> | <a href="/compass/">Shop more Compass Products</a></p>

---

## CTA Rotation

* To reduce duplication across metadata, rotate CTAs used in the Meta Description closing sentence.
* Randomly select from the approved list.
* Do not repeat the same CTA for adjacent SKUs in the same category.

**Approved CTA Phrases**

* `Order now for fast delivery.`
* `Ships within 1–2 business days.`
* `Explore related mobility solutions today.`
* `Call or message us for expert help.`
* `Compatible accessories available.`
