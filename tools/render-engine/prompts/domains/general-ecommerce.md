# General Ecommerce Domain Rules

This file contains tone, compliance, and domain-specific rules for general ecommerce stores across all verticals (non-medical).

---

## TONE & READABILITY

* Professional, factual, and accurate.
* Customer-focused. Benefits for buyers and end users.
* Clear and engaging. Short paragraphs. Varied sentence length.
* Persuasive and helpful. Prefer terms such as supports, enhances, provides, designed for.
* Avoid industry jargon unless the target audience expects it.

**Do not use** em dashes, semicolons, hashtags, asterisks, or Markdown in the final store output.
**Avoid words and phrases** listed in your banned-terms list.

---

## General Ecommerce Compliance Requirements

### Authority & Trust Signals (0–0.5 pt)
* Credit references to brand credibility, certifications, or quality standards when available.
* Deduct for missing or ungrounded authority cues.

### Factual Alignment (0–1 pt)
* Checks consistency between body text and Specs JSON (dimensions, capacity, materials, warranty).
* Deduct if numeric or factual values differ or lack traceable evidence.

### Accessibility & Readability Compliance (0–0.25 pt)
* Deduct for excessive jargon, undefined abbreviations, or missing `alt` text in Images JSON.
* Reward simple, inclusive phrasing and clear hierarchy.

### Grammar & Passive Voice (0–0.25 pt)
* Deduct if passive voice > 10% or redundant adjectives remain.
* Reward natural rhythm and active phrasing.

---

## General Ecommerce Language Guidelines

### Approved Quality & Certification Terms (when grounded in inputs)
* Quality tested, performance verified
* Industry certified, standards compliant
* Manufacturer warranty, quality assurance
* Safety tested, durability verified
* Performance rated, quality controlled

### General Compliance Restrictions
* Never make unsubstantiated performance claims
* Never suggest benefits not supported by product specifications
* Never imply results or outcomes not documented in source materials
* Never make comparative claims without specific grounding
* Always base claims on manufacturer specifications or verified testing

### Audience-Specific Language
* **For Professionals:** "Industry professionals," "professional users," "commercial applications"
* **For Home Users:** "Home users," "families," "personal use," "everyday applications"
* **For Hobbyists:** "Enthusiasts," "hobbyists," "DIY projects," "creative applications"
* **For Businesses:** "Business users," "commercial operations," "workplace applications"

---

## General Product Categories & Terminology

### Consumer Electronics & Technology
* Technology solutions, digital devices, electronic equipment
* User experience, performance optimization, connectivity solutions
* Smart features, intelligent design, advanced functionality

### Home & Garden
* Home improvement, household solutions, outdoor equipment
* Comfort enhancement, convenience features, lifestyle products
* Durability, weather resistance, long-lasting performance

### Sports & Fitness
* Performance equipment, training gear, fitness solutions
* Athletic performance, workout enhancement, training support
* Endurance, strength building, fitness goals achievement

### Tools & Industrial
* Professional tools, industrial equipment, precision instruments
* Reliability, efficiency, heavy-duty performance
* Precision engineering, robust construction, professional results

### Fashion & Lifestyle
* Style solutions, comfort features, quality materials
* Fashion-forward design, versatile styling, premium quality
* Comfort, durability, timeless appeal

---

## General Ecommerce Scenarios & Use Cases

### Professional & Commercial Scenarios
* "Designed for professionals who need reliable performance"
* "Supports business operations with consistent results"
* "Helps teams achieve their project goals efficiently"

### Home & Personal Use Scenarios
* "Perfect for families who want quality and convenience"
* "Designed for everyday use in busy households"
* "Helps you get more done with less effort"

### Hobby & Recreation Scenarios
* "Ideal for enthusiasts who demand quality results"
* "Supports creative projects with precision and reliability"
* "Designed for hobbyists who appreciate attention to detail"

---

## Quality & Standards Language

### When Certifications Are Available
* "Industry certified for quality and performance"
* "Meets [specific standard] requirements" (only if explicitly stated)
* "Quality tested to [specific standard]" (only if explicitly stated)
* "Certified for [specific application]" (only if explicitly stated)

### When Certifications Are NOT Available
* "Designed for reliable performance"
* "Built to quality standards"
* "Engineered for long-lasting use"
* "Tested for consistent performance"

---

## General Ecommerce Emotional Resonance Guidelines

### Approved Emotional Outcomes
* Confidence, satisfaction, peace of mind
* Convenience, efficiency, time savings
* Quality results, professional outcomes
* Enjoyment, satisfaction, accomplishment

### General Benefit Language
* "Enhances your daily routine with reliable performance"
* "Provides the quality and convenience you deserve"
* "Designed to exceed your expectations"
* "Supports your goals with dependable results"

### Prohibited General Claims
* Any language suggesting guaranteed outcomes without basis
* Superlative claims without comparative grounding ("best," "ultimate," "perfect")
* Unsubstantiated performance promises
* Benefits not supported by product specifications

---

## Product Category Adaptations

### Technology Products
* Focus on performance, compatibility, ease of use
* Emphasize innovation, efficiency, and user experience
* Highlight connectivity, smart features, and advanced functionality

### Home & Lifestyle Products
* Focus on comfort, convenience, and everyday utility
* Emphasize quality of life improvements and family benefits
* Highlight durability, style, and practical value

### Professional & Industrial Products
* Focus on performance, reliability, and efficiency
* Emphasize productivity gains and professional results
* Highlight precision, durability, and return on investment

### Recreation & Hobby Products
* Focus on enjoyment, creativity, and personal achievement
* Emphasize quality, precision, and satisfying results
* Highlight features that enhance the user experience

---

## Adaptable Compliance Framework

### High-Performance Categories (Extra Scrutiny)
* Professional tools, precision instruments
* Safety equipment, protective gear
* High-value electronics, complex machinery
* Performance-critical applications

### Standard Consumer Categories (Standard Compliance)
* Home goods, lifestyle products
* General electronics, everyday tools
* Apparel, accessories, basic equipment
* Entertainment and hobby products

### Decorative & Aesthetic Categories (Moderate Compliance)
* Home decor, artistic products
* Fashion accessories, style items
* Gifts, novelty items
* Aesthetic enhancements

When writing for high-performance categories, apply extra scrutiny to performance claims and ensure all technical statements are directly grounded in manufacturer specifications.

---

## Store Name Variable Integration

Throughout all content generation, use `{{STORE_NAME}}` as a placeholder that will be replaced with the actual store name at runtime. This appears in:

* Meta title suffix: `| {{STORE_NAME}}`
* Authority references: "Available exclusively at {{STORE_NAME}}"
* Trust signals: "{{STORE_NAME}} quality guarantee"

The store name variable allows the same prompt to work across different store brands while maintaining brand consistency.
