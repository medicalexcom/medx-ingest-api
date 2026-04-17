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

If a section is disabled by profile, omit or return empty according to schema expectations.
