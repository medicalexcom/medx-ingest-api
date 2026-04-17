# Core Formatting Rules

## 1) Section Ordering (when HTML output is required)
Use stable section ordering expected by downstream lint/repair:
1. overview
2. hook
3. mainDescription
4. featuresBenefits
5. specifications
6. internalLinks (if enabled)
7. whyChoose
8. manuals (if enabled)
9. faqs

## 2) HTML Hygiene
- Use valid HTML tags and nesting.
- Keep bullets in `<ul><li>` blocks.
- Avoid malformed tag fragments or mixed markdown/html.
- Keep paragraphs concise and scannable.

## 3) Redundancy Control
- Avoid repeating identical claims across sections.
- Merge near-duplicate bullets.
- Keep each bullet unique and evidence-backed.

## 4) Metadata Limits
Follow profile/channel limits for:
- H1
- title
- meta description
- short description

## 5) Output Completeness
Return all required schema keys every time.
If an optional section has no grounded data, return safe empty content per schema and record the gap.
