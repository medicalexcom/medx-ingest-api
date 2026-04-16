# MedicalEx Tenant-Specific Rules

This file contains tenant-specific branding, integration, and operational rules specific to MedicalEx.

---

## Meta Title Branding

* Target **60–65 characters**, **excluding** the suffix `" | MedicalEx"`.
* Apply a **hard cap of 68 characters** for the core title (before suffix).
* Every meta title must **end with** `" | MedicalEx"`.
* Structure: `[primary keyword] – [top feature or benefit] | MedicalEx`
* If total (core + suffix) exceeds ~80 characters, truncate the core portion at a full word boundary to stay within limit.
* The suffix must always exist in the HTML, even if truncated visually.

**Example**
`ProBasics shower chair – adjustable height, 300 lb | MedicalEx`

---

## Google Apps Script Runtime Integration

When these instructions run within Google Apps Script (`Code.gs`):
* Treat missing or malformed GPT responses as recoverable warnings.
* Retry the same payload once automatically.
* If the retry fails, mark `QA Status = FAIL` and populate the `Error` column with the GPT response text for operator review.
* If QA notes or sync feedback contain a directive equivalent to **"failed sync and fix"**, treat it as a recoverable auto-remediation request:
  * Parse the failure reason / QA note.
  * Apply targeted fixes to the affected fields only (do not rewrite unrelated sections).
  * Re-run the audit once.
  * Re-attempt sync once with the corrected payload.
* If the second sync attempt fails, mark `QA Status = FAIL` and write the final failure reason to the `Error` column for operator review.

This prevents silent failures in batch or wizard modes.

---

## Internal Linking Patterns

Insert exactly two internal links (subcategory hub + brand hub, or accessories if obvious) **after Product Specifications and before Why Choose**. Anchors must be neutral, and links must vary dynamically.

**URL Pattern Examples:**
- Brand hub: `/drive-medical/` (for Drive Medical brand products)
- Subcategory hub: `/mobility-aids/wheelchairs/` (category-based)

**Dynamic Anchor Examples:**
* `Shop more Drive Medical Products` → `/drive-medical/`
* `See all Wheelchairs` → `/mobility-aids/wheelchairs/`
* `Browse Wheelchair accessories` → `/mobility-aids/wheelchairs/accessories/`

---

## BigCommerce Sync Integration

After GPT completes the `auditResult` and returns JSON, a separate Google Apps Script module (`medx_autoHealRowFull`) performs final compliance and data hygiene passes.
This layer ensures every product row meets H1, manuals conditional insertion, slug, metadata, and placeholder rules before sync to BigCommerce.
It does not change grounded content — it only enforces formatting, length, and structural compliance.

**Sync Rules:**
* H1 length enforcement (90–110 characters)
* Meta title suffix validation (`| MedicalEx` presence)
* Internal links placement verification
* Manual section conditional insertion
* Placeholder phrase removal
* Slug normalization and collision detection

---

## MedicalEx-Specific CTA Preferences

**Approved CTA Phrases for Meta Descriptions:**
* `Order now for fast delivery.`
* `Ships within 1–2 business days.`
* `Explore related mobility solutions today.`
* `Call or message us for expert help.`
* `Compatible accessories available.`

Rotate these CTAs to avoid repetition across similar products.

---

## MedicalEx Content Standards

### Brand Voice & Messaging
* Authoritative yet accessible medical equipment expertise
* Focus on clinical reliability and patient safety
* Emphasize healthcare professional needs and requirements
* Balance technical accuracy with user-friendly language

### Quality Indicators
* FDA classifications when applicable
* ISO certifications when available
* Healthcare facility compatibility
* Clinical validation references

### Target Audiences
1. **Healthcare Professionals** - Clinicians, nurses, therapists
2. **Healthcare Facilities** - Hospitals, clinics, long-term care
3. **Home Healthcare** - Patients, caregivers, family members
4. **DME Dealers** - Medical equipment resellers and distributors

---

## MedicalEx Workflow Integration

### Content Generation Workflow
1. **Source Analysis** - PDF manuals, manufacturer specs, clinical documentation
2. **Content Generation** - GPT processing with medical compliance checks
3. **Auto-Heal Layer** - `medx_autoHealRowFull` compliance enforcement
4. **BigCommerce Sync** - Direct platform integration
5. **QA Validation** - Post-sync quality verification

### Error Handling
* Automatic retry for transient GPT failures
* Structured error logging for operator review
* Graceful degradation for partial content generation
* Sync failure recovery with targeted fixes

### Performance Optimization
* Batch processing for bulk uploads
* Incremental updates for existing products
* Selective field updates to minimize API calls
* Cached prompt compilation for efficiency

---

## MedicalEx Compliance Framework

### Medical Device Compliance
* FDA Class I/II device categorization
* Medical device establishment registration requirements
* Labeling and marketing compliance for medical devices
* Clinical evidence and validation requirements

### Healthcare Marketing Compliance
* HIPAA compliance for patient-related content
* FDA advertising and promotion guidelines
* Medical claim substantiation requirements
* Healthcare professional communication standards

### E-commerce Platform Compliance
* BigCommerce medical device category requirements
* Payment processing for medical equipment
* Shipping and handling for clinical devices
* Customer verification for restricted products

---

## MedicalEx Data Integration

### Source Prioritization
1. **FDA Documentation** - Official device listings and approvals
2. **Manufacturer Clinical Data** - Validated technical specifications
3. **Healthcare Standards** - ISO, AAMI, and other medical standards
4. **Clinical Literature** - Peer-reviewed validation when available

### Content Validation Pipeline
* Medical accuracy verification against manufacturer data
* Regulatory compliance checking for marketing claims
* Clinical terminology validation and standardization
* Cross-reference verification with existing product database

This tenant-specific configuration ensures all content generated for MedicalEx maintains the brand's medical authority while complying with healthcare industry regulations and BigCommerce platform requirements.
