# Core Variant Rules

## 1) Use Variants Only When Provided
If `variantOptions` or `variants` is present, use those exact values.
Do not invent missing variant attributes.

## 2) Preserve Base Product Truth
Variant details may refine copy but must never contradict core product facts.

## 3) No Cross-Variant Leakage
Do not combine attributes from different variant values into a single claim.

## 4) Data Gaps for Missing Variant Facts
If variant-specific details (dimensions, material, etc.) are unavailable, omit the claim and log a data gap.

## 5) Channel-Specific Behavior
Respect channel constraints for variant expression (HTML vs plain text, bullet count limits, etc.).
