# Core Variants Rules

**Variant Awareness.** In addition to `pdf_text`, `pdf_docs`, `dom`, and `browsed_text`, the ingestion layer now provides a `variantOptions` array (or `variants`) containing all detected variant combinations. Each option is an object with `label` (e.g., "Size") and `value` (e.g., "Medium"). Use this array to generate a **variant copy** for each combination. Do **not** infer or guess options—only use the provided values. Do not include the variant copy in the customer-facing body.

---

## Variant Binding & Validation Additions

* **Variant detection check:** If any source contains an optionable attribute list or a Sizes/Ordering table, attempt to auto-populate options and variants. If population is skipped or only partial, do not fail QA. Emit warnings with precise codes and record details under desc_audit.variant_detection and desc_audit.variant_summary. Keep desc_audit.passed = true and allow_sync = true.
* **Size order check:** When Size is present, enforce XS, S, M, L, XL, 2XL. If inputs use non-standard labels, normalize silently and add a VAR_NON_NORMALIZED_SIZE_LABELS warning with the original labels.
* **SKU mapping check:** When a Sizes/Ordering table includes Item No. values, map each variant sku. If any size lacks a SKU in sources, omit sku for that variant and add a VAR_SIZES_PRESENT_NO_SKUS warning. Do not fail QA.
* **Per-variant packaging check:** If pack counts differ by size, include per-variant packaging when present. If packaging exists in sources but is missing at variant level, add a VAR_PACKAGING_MISSING warning. Do not fail QA.
* **Grounding check for variants:** Values included in variants must be traceable to inputs. If a value is ungrounded, remove it and log a VAR_UNGROUNDED_VARIANT_VALUE warning. Do not fail QA unless ungrounded claims remain in the customer-facing body.
* **Notification behavior:** If variants were detected but options or variants were omitted or only partially built, emit one of:
  - VAR_DETECTED_BUT_SKIPPED
  - VAR_PARTIAL_BUILD
Include a short reason and the source that triggered detection. Never set desc_audit.passed = false based on these conditions.
* For each auto-populated variant, add an evidence entry in desc_audit.evidence with {field:"variant", value:"Size=Large, SKU=XXXX", source, snippet_or_key}. If SKU is omitted due to missing data, record a data_gaps entry instead and add VAR_SIZES_PRESENT_NO_SKUS.
* When variant detection occurs but options/variants are not emitted, add data_gaps.variants with a short reason and include a VAR_DETECTED_BUT_SKIPPED warning.

```
Warning codes:
- VAR_DETECTED_BUT_SKIPPED: Variant attributes detected in sources but options/variants not emitted.
- VAR_PARTIAL_BUILD: Some options or variants emitted, others skipped due to missing data.
- VAR_SIZES_PRESENT_NO_SKUS: Size list found without SKUs, variants emitted without sku fields.
- VAR_PACKAGING_MISSING: Packaging present in sources but not mapped at variant level.
- VAR_NON_NORMALIZED_SIZE_LABELS: Input size labels normalized to the standard order.
- VAR_UNGROUNDED_VARIANT_VALUE: A variant field was removed because it lacked a traceable source.
- VAR_IMAGE_NOT_MAPPED: Variant-level image not assigned when distinct images exist.
```

---

## VARIANTS & OPTIONS (REQUIRED WHEN PRESENT)

### When to Populate

Populate `options` and `variants` whenever any input includes:

* A Sizes line or list, or
* A table that pairs *Item No.* or *SKU* with Size, and optionally Packaging.
* If detection occurs, auto-build the Size option and variants using normalized labels. Proceed even when SKUs or packaging are missing. Record gaps and warnings as defined. Do not block output or sync.

Also,

* If the ingestion payload contains a `variantOptions` or `variants` field, produce a `variant_copy` entry in the final JSON output. If no variants are provided, omit the `variant_copy` field or return an empty array.
* Variant copy belongs only in the JSON output. Do not generate variant copy if the ingestion payload does not include variant data.
* All variant values must be traceable to `dom`, `pdf_text`, or other inputs.
* Each item in `variant_copy` corresponds to a single variant combination, preserving the order of `variantOptions`. For example, if the variant combination is `{Size: 'Medium', Dimensions: '1‑1/5 × 2‑3/5 in'}`, the variant copy might be "Medium · 1‑1/5 × 2‑3/5 in" followed by a brief benefit or packing detail if provided in the specs. Use the *exact* labels and values from the `variantOptions` array; do not invent or infer other attributes.

### Source Priority

Use the global authority order: `pdf_text` and `pdf_docs` above `dom`, above `browsed_text`. When values disagree, use the higher‑authority value and log a conflict entry.

### Size Normalization

Normalize Size values as follows:

* **Abbreviation → Display label**

  * XS → X‑Small
  * S or SM → Small
  * M or MD → Medium
  * L or LG → Large
  * XL → X‑Large
  * 2XL → 2X‑Large
* **Order:** XS, S, M, L, XL, 2XL.
* **Display:** Use the full labels above in `options.values` and in each variant's `option_values.value`. Store abbreviations only in the `options.order` array or `option_values.abbr`.

### Options Object

Return a single Size option when detected.

```json
"options": [
  {
    "name": "Size",
    "display_name": "Size",
    "values": ["X-Small","Small","Medium","Large","X-Large","2X-Large"],
    "order": ["XS","S","M","L","XL","2XL"]
  }
]
```

Rules:

* `name` and `display_name` are Title Case.
* `values` use the normalized display labels.
* `order` uses abbreviations for stable sort.

### Variants Object

If sku is absent in sources, omit sku on that variant and emit VAR_SIZES_PRESENT_NO_SKUS. Do not compose or guess identifiers.
Create one variant per size value detected. Map `sku` from *Item No.* or *SKU* columns when present.

```json
"variants": [
  {
    "sku": "MNE5051",
    "option_values": [
      {"option_name":"Size","value":"X-Small","abbr":"XS"}
    ],
    "packaging": {"per_box":"100/box","per_case":"10 boxes/case"},
    "variant_image_index": 0
  }
]
```

Rules:

* **Required per variant:** `option_values` with `option_name` and `value`.
* **SKU:** Include only when present in sources. Do not compose SKUs.
* **Packaging:** Include `per_box` and `per_case` when present. If uniform across all sizes, you may omit at variant level and keep a single parent‑level spec instead.
* **Images:** If a distinct image corresponds to a size, set `variant_image_index` to the zero‑based index from the `images[]` array.
* **Optional IDs:** If UPC, GTIN, or MPN appear in inputs for a size, include them on the variant as separate fields.

### Gaps and Conflicts

* If a size appears without a matching SKU in sources, omit `sku` for that variant and add a `data_gaps` note.
* If two sources disagree on a size label or packaging, choose the higher‑authority source and add a `conflicts` entry with both values and a short note.

### Auto‑Revision for Variants

If variantable attributes are detected but `options` or `variants` are missing, trigger auto‑revision. Populate the missing structures, then re‑run the audit. Stop when `desc_audit.passed === true` or after three passes.

### Formatting Rules for Variant Text in Body

* Do not print SKUs in the customer‑facing body.
* Mention Size ranges in copy only when useful for fit clarity.
* Keep per‑variant technicals out of the body unless all variants share the same value.

---

## Variant-Level Alt Text (Optional Schema)

* If product variants have distinct images, provide alt text grouped by variant.
* Default alt text applies when no variant is specified.

**Example**

```json
"image_alts": {
  "default": ["Main image of ProBasics Steel Rollator"],
  "variant_blue": ["Blue frame rollator with seat and wheels"],
  "variant_black": ["Black finish rollator with hand brakes"]
}
```
