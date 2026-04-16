# Medical Store Domain Rules

This file contains tone, compliance, and domain-specific rules for medical equipment and healthcare product stores.

---

## TONE & READABILITY

* Professional, factual, and medically accurate.
* Regulatory-conscious. No unverified claims. Align with FDA, CE, or ISO if applicable.
* Customer-focused. Benefits for clinicians, caregivers, and patients.
* Clear and engaging. Short paragraphs. Varied sentence length.
* Compliant persuasion. Prefer terms such as supports, facilitates, ensures, designed for.
* Never mention HCPCS codes, Medicare, or Insurance.

**Do not use** em dashes, semicolons, hashtags, asterisks, or Markdown in the final store output.
**Avoid words and phrases** listed in your banned-terms list.

---

## Medical-Specific Compliance Requirements

### Authority & Trust Signals (0–0.5 pt)
* Credit references to brand credibility, certifications, or compliance (e.g., FDA Class I, ISO certified).
* Deduct for missing or ungrounded authority cues.

### Factual Alignment (0–1 pt)
* Checks consistency between body text and Specs JSON (dimensions, capacity, materials, warranty).
* Deduct if numeric or factual values differ or lack traceable evidence.

### Accessibility & Readability Compliance (0–0.25 pt)
* Deduct for jargon, undefined abbreviations, or missing `alt` text in Images JSON.
* Reward simple, inclusive phrasing and clear hierarchy.

### Grammar & Passive Voice (0–0.25 pt)
* Deduct if passive voice > 10% or redundant adjectives remain.
* Reward natural rhythm and active phrasing.

---

## Medical Domain Language Guidelines

### Approved Medical Terms (when grounded in inputs)
* FDA Class I/II (when explicitly stated)
* ISO certified (when explicitly stated)  
* CE marked (when explicitly stated)
* Latex-free (when explicitly stated)
* Non-sterile/sterile (when explicitly stated)
* Single-use/reusable (when explicitly stated)
* Healthcare professional use
* Clinical setting
* Patient care
* Medical facility

### Medical Compliance Restrictions
* Never claim to diagnose, treat, cure, or prevent any medical condition
* Never make unsubstantiated health claims
* Never suggest FDA approval unless explicitly stated in source materials
* Never imply Medicare/insurance coverage
* Never use medical outcome promises (e.g., "reduces pain," "improves circulation")
* Always ground medical claims in manufacturer specifications

### Audience-Specific Language
* **For Clinicians:** "Healthcare professionals," "clinical staff," "medical practitioners"
* **For Caregivers:** "Caregivers," "family members," "care providers"  
* **For Patients:** "Patients," "users," "individuals requiring assistance"
* **For Facilities:** "Healthcare facilities," "medical institutions," "care facilities"

---

## Medical Equipment Categories & Terminology

### Mobility & Ambulation
* Mobility aids, ambulation assistance, walking support
* Patient transport, wheelchair navigation, transfer assistance
* Fall prevention, stability enhancement, safe mobility

### Diagnostic & Monitoring
* Diagnostic equipment, monitoring devices, measurement tools
* Clinical assessment, patient evaluation, health monitoring
* Vital signs monitoring, diagnostic testing, clinical measurement

### Patient Care & Comfort
* Patient comfort, care enhancement, comfort solutions
* Pressure relief, positioning aids, comfort support
* Patient safety, care efficiency, comfort optimization

### Clinical Supplies & Consumables
* Clinical supplies, medical consumables, healthcare products
* Single-use devices, disposable medical products, clinical consumables
* Infection control, sterile products, clinical safety

---

## Medical Scenarios & Use Cases

### Healthcare Professional Scenarios
* "Designed for busy healthcare professionals who need reliable equipment"
* "Supports clinical staff in providing efficient patient care"
* "Helps medical practitioners maintain workflow efficiency"

### Patient Care Scenarios  
* "Supports patients who require mobility assistance"
* "Designed for individuals recovering from surgery or injury"
* "Helps patients maintain independence in daily activities"

### Facility & Institution Scenarios
* "Suitable for hospitals, clinics, and long-term care facilities"
* "Designed for high-volume clinical environments"
* "Supports infection control protocols in healthcare settings"

---

## Medical Regulatory Language

### When Regulatory Claims Are Grounded
* "FDA-cleared for medical use" (only if explicitly stated)
* "Meets FDA Class [I/II] requirements" (only if explicitly stated)
* "ISO [specific standard] certified" (only if explicitly stated)
* "CE marked for European compliance" (only if explicitly stated)

### When Regulatory Claims Are NOT Available
* "Designed for healthcare applications"
* "Intended for clinical use"
* "Manufactured to medical device standards"
* "Quality-tested for healthcare environments"

---

## Medical Emotional Resonance Guidelines

### Approved Medical Emotional Outcomes
* Clinical confidence, care assurance, professional reliability
* Patient comfort, user safety, care effectiveness  
* Workflow efficiency, clinical productivity, care quality
* Peace of mind for caregivers, confidence in patient safety

### Medical Benefit Language
* "Supports patient safety and comfort"
* "Enhances care quality and efficiency"  
* "Provides clinical reliability and performance"
* "Designed for optimal patient outcomes"

### Prohibited Medical Language
* Any language suggesting medical treatment or therapeutic benefits
* Outcome guarantees or medical promises
* Unsubstantiated clinical claims
* Insurance or reimbursement implications

---

## Medical Product Categories Recognition

### High-Regulation Categories (Extra Compliance Required)
* Diagnostic equipment, monitoring devices
* Surgical instruments, medical implants  
* Pharmaceutical products, controlled substances
* Life-support equipment, critical care devices

### Standard Medical Equipment (Standard Compliance)
* Mobility aids, patient positioning equipment
* Clinical supplies, wound care products
* Basic diagnostic tools, measurement devices
* Patient comfort and safety equipment

### Healthcare Accessories (Moderate Compliance)
* Medical furniture, clinical storage
* Healthcare textiles, protective equipment
* Facility management, cleaning supplies
* Administrative and office medical supplies

When writing for high-regulation categories, apply extra scrutiny to all claims and ensure all statements are directly grounded in manufacturer specifications.
