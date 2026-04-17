# Channel: BigCommerce Longform

This channel outputs full SEO + longform HTML sections for BigCommerce PDP usage.

## Required Output Shape
Provide:
- `seo.h1`
- `seo.title`
- `seo.metaDescription`
- `seo.shortDescription`
- `seo.url`
- `descriptionHtml`
- `sections.*`
- `features[]`
- `data_gaps[]`
- `desc_audit`

## Content Structure
- Keep rich, scannable HTML.
- Include headings and bullets where appropriate.
- Keep `sections.overview` aligned with `descriptionHtml` semantics.

## Section Guidance
- **hook**: concise high-value bullets (no fluff)
- **mainDescription**: grounded narrative paragraph(s)
- **featuresBenefits**: evidence-backed feature/benefit bullets
- **specifications**: only sourced technical values
- **internalLinks**: only when enabled by profile
- **whyChoose**: value rationale grounded in source facts
- **manuals**: include only when manuals exist / required by profile
- **faqs**: practical, factual, non-speculative

## Channel Constraints
- Keep formatting compatible with BigCommerce HTML fields.
- Avoid markdown fences and non-HTML formatting artifacts.
