# Tenant Overrides: MedicalEx

These rules are MedicalEx-specific and should not be applied to general tenants.

## Branding Rules
- Meta title suffix must be `| MedicalEx`.
- Preserve MedicalEx voice/tone continuity from canonical prompt behavior.

## Structural Rules
- Internal links are required and should follow MedicalEx section placement.
- Manuals section remains enabled for MedicalEx longform flow.

## Compatibility Rules
- Preserve runtime compatibility for existing downstream automations and lint/repair expectations.
- If conflicts arise between general and tenant rules, tenant rules win.
