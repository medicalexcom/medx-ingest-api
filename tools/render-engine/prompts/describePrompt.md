# Describe prompt wrapper

This wrapper is combined with masterPrompt.md to create the final prompt used by the Describe module.

Use this file to specify the Describe-specific constraints (e.g., what sections to always produce, HTML formatting, SEO length rules).

Example:
- Enforce sections: overview, features, specsSummary, includedItems, manualsSectionHtml
- Enforce seo object keys and max lengths
- Provide example JSON output (small example not required here — master contains full schema)

Note: buildPrompt will load masterPrompt.md then this wrapper, then inject variables.
