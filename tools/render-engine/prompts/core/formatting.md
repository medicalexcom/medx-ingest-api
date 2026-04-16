# Core Formatting Rules

## OUTPUT SCOPE & GLOBAL RULES

* The H1 product name and the Search Keywords list must **not** appear inside the description body.
* Always generate Meta Title, Meta Description, and product URL structure.
* If data is missing, **omit the specific bullet/spec/FAQ** from the customer-facing description. Record gaps in `desc_audit.data_gaps` (machine field) when useful.
* **Manuals** remains conditional (omit section when none exist).
* Do not reorder required sections.
* No Markdown in the final store output. Use HTML only where specified.

---

## GLOBAL FORMATTING RULES

Markdown is permitted **only in this instruction file** for clarity. The **final output must use HTML formatting only** and must never contain Markdown syntax.

### Product Name Highlighting

* Bold the **short\_name** in the **first sentence of the first paragraph** using `<strong>…</strong>`.
* Optional second bold in the "Main Description".
* Do not bold repeatedly. Use pronouns or descriptive alternatives after first mention.

### Bullet Formatting

* In all bullet lists:

* **Labels are Title Case** in all sections (Hook & Bullets, Features and Benefits, Product Specificcations and Why Choose).
* The **explanation after the en dash starts with a capital** and ends with a period.
* Specs remain the only section where a **colon** after the label is allowed.
* Each bullet follows Feature → Why it matters → Real-world user benefit.
* Every bullet explanation must end with a period. One or two sentences max. No duplicates.
* Example: `<strong>Gentle Bristles</strong> – Designed to safely clean delicate pump parts without causing scratches.`

### General Writing Rules

* Main Description must contain one explicit buyer-outcome sentence tied to a concrete feature.
* Natural, human-readable language optimized for SEO.
* Avoid repetition across sections. If a concept repeats, vary phrasing and highlight a different benefit.
* Keep keyword use natural.
* **No em dashes (—). No semicolons (;).** Use **en dashes (–)** only for two patterns: (1) the H1 separator between product core and specs, and (2) the bullet label–explanation pattern. Do not use en dashes elsewhere.

### Capitalization Scope — updated

* **Product Name (H1): Title Case.** Capitalize major words. Lowercase short articles, coordinating conjunctions, and prepositions of four letters or fewer (a, an, the, and, but, for, nor, or, so, yet, at, by, for, in, of, on, to, as, per, via, with) unless first or last.
  * Preserve brand stylization and acronyms: BD, EZ, CO₂.
  * Capitalize both parts of hyphenated compounds.
  * If a colon appears in H1, capitalize the first word after it.
* **Headings (H2/H3):** Title Case.
* **Bullet labels and spec names:** Title Case.
* **Meta Title:** Title Case.
* **Meta Description:** Standard sentence capitalization.
* **Search Keywords list:** lowercase, comma-separated.
* **URL slug:** lowercase.

---

## Writing Style

SHOULD use clear, simple language.
SHOULD be spartan and informative.
SHOULD use short, impactful sentences.
SHOULD use active voice; avoid passive voice.
SHOULD focus on practical, actionable insights.
SHOULD use bullet point lists in social media posts.
SHOULD use data and examples to support claims when possible.
SHOULD use "you" and "your" to directly address the reader.
AVOID em dashes (—) and semicolons (;). When connecting ideas, use a period. En dashes (–) are allowed only for the H1 separator and the bullet label–explanation pattern.
AVOID constructions like "...not just this, but also this".
AVOID metaphors and clichés.
AVOID generalizations.
AVOID common setup language in any sentence, including: in conclusion, in closing, etc.
AVOID output warnings or notes, just the output requested.
AVOID unnecessary adjectives and adverbs.
AVOID hashtags.
AVOID semicolons.
AVOID markdown.
AVOID asterisks.
AVOID these words: "can, may, just, that, very, really, literally, actually, certainly, probably, basically, could, maybe, delve, embark, enlightening, esteemed, shed light, craft, crafting, imagine, realm, game-changer, unlock, discover, skyrocket, abyss, not alone, in a world where, revolutionize, disruptive, utilize, utilizing, dive deep, tapestry, illuminate, unveil, pivotal, intricate, elucidate, hence, furthermore, realm, however, harness, exciting, groundbreaking, cutting-edge, remarkable, it, remains to be seen, glimpse into, navigating, landscape, stark, testament, in summary, in conclusion, moreover, boost, skyrocketing, opened up, powerful, inquiries, ever-evolving".
IMPORTANT: Review your response and ensure no em dashes!

---

## Product Name (H1) [Not to be inserted in the description]

**Length requirement** 90–110 characters total. Count spaces.
**Structure** `[brand & primary keyword] – [1–2 high-value specs or features]` : Frontload the brand  
**Revision order** add one spec, shorten units, remove least-value trailing spec, then de-duplicate.
**Brand & primary keyword first** exact phrase buyers search.  
**High-value specs** include one or two details such as capacity, material, adjustability, comfort. Separate with commas.
**Concise & unique** no filler adjectives, no SKUs or IDs. Do not repeat terms from bullets or meta title. No trademark symbols.
**Punctuation & spacing** use an en dash between the first part of the name and the specs. Single spaces around punctuation. Commas only between specs.

**Final QA**

1. 90–110 characters.
2. Starts with brand plus primary keyword.
3. Includes one or two high-value specs.
4. No SKUs, IDs, trademarks, or redundant words.
5. Does not end with a comma or dangling preposition/incomplete phrase.
6. Does not contain SKU OR GTIN values.
7. Includes no more than one packaging form/count phrase.
8. No duplicated words, repeated brand tokens, or duplicated opening phrase fragments.

**Example template**
`[brand & product] – [top spec], [secondary spec]`

**Filled example**
`Motif roam breast pump with breast milk collection cups – hands-free wearable pump, 4 pump modes, leak-proof`
`BD GasPak EZ Small Incubation Container – Nonbreakable, Chemical-Resistant Anaerobic Jar, 18 Capacity`

---

**Compliance Addendum — H1 Sanitization Rules**

* Product Name (H1) **must not contain**:
  * SKUs, model numbers, part numbers, or product codes (e.g., "ST-630-B-2R", "50-66160", "SKU: 12345").
  * GTIN labels or GTIN values (e.g., "GTIN", "GTIN: 12345678901234", "GTIN Number 123…").
  * Country of manufacture phrases such as "Made in USA" or "Manufactured in China".
  * Trademark, service mark, or copyright symbols ("™", "®", "℠", "©").
  * More than one packaging form/count phrase in the same H1 (e.g., "case of 100, box of 10"). If multiple packaging formats exist in inputs, keep only the most buyer-relevant single packaging expression in H1 and move full packaging detail to Product Specifications / variants.
* Product Name (H1) **must not end with**:
  * A comma.
  * A dangling preposition or incomplete packaging phrase (e.g., endings like "of", "for", "with", "case of", "box of").
* If any invalid ending is detected, GPT must auto-trim or rewrite the trailing segment and re-check H1 length compliance (90–110).
* When any of these elements appear in the source title or manufacturer data, GPT must remove them automatically.
* H1 revisions must retain all meaningful descriptive parts while excluding regulatory or internal identifiers.
* Example transformation:
  * ❌ `McKesson Exam Table ST-630-B-2R™ – Made in USA`
  * ✅ `McKesson Exam Table – Durable Steel Frame, Four Storage Drawers`

---

## Passive Voice & Grammar Audit

* Descriptions must:

  * Use **less than 10% passive voice**.
  * Avoid redundant adjectives (e.g., "durable and strong").
  * Exclude incomplete or run-on sentences.

* Optionally include a `grammar_audit` block in the payload:

**Example**

```json
"grammar_audit": {
  "passive_ratio": 0.15,
  "issues": [
    { "section": "Main Description", "issue": "Redundant phrase", "fix_hint": "Remove 'durable and strong'" }
  ]
}
```
