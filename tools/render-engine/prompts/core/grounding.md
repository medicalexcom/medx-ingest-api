# Core Grounding Rules (All Profiles)

These rules are mandatory for every tenant, domain, and channel profile.

## 1) Allowed Evidence Sources
Use only the provided packet inputs as evidence:
- `dom`
- `pdf_text`
- `pdf_docs`
- `browsed_text`
- `variantOptions` / `variants` (when present)

If a claim cannot be traced to these sources, omit it.

## 2) Source Priority
When sources conflict, resolve in this order:
1. `pdf_text` and `pdf_docs`
2. `dom`
3. `browsed_text`

Record conflicts in machine fields (`desc_audit.conflicts`).

## 3) No-Guessing Policy
Never infer or estimate:
- dimensions, weight, capacities, material composition
- compatibility or fitment
- warranty terms
- certification/compliance details
- package quantity or included accessories

If absent, omit from customer-facing text and add to `desc_audit.data_gaps`.

## 4) Placeholder Prohibition
Do not output placeholder language in customer-facing copy such as:
- "not available", "not provided", "unknown", "N/A", "TBD"

If information is missing, omit the line/bullet instead.

## 5) Deterministic Naming & Consistency
- Keep product identity consistent across H1/title/body.
- Avoid renaming product families between sections.
- Keep URLs/slugs deterministic and clean.

## 6) Repair Loop Contract
If required fields are missing or blockers are detected, revise before final output.
Return complete output, not partial patches.
