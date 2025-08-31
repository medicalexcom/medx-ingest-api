// browserCrawler.js
// Headless-browsing collector for product pages.
//
// This module uses Playwright to fetch and expand product pages.
// ... [header comments unchanged] ...

import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLICK_SELECTORS = [
  // ... all existing selectors ...
  'a[href^="#tab-"]',     // Spectra-style hash-link tabs
];

const WAITERS = [
  // ... unchanged ...
];

async function autoExpand(page) {
  // ... unchanged ...
}

async function collectVisibleText(page) {
  // ... unchanged ...
}

async function collectNetworkData(page) {
  // ... unchanged ...
}

async function collectSections(page) {
  return page.evaluate(() => {
    const sections = {};
    const map = {
      description: [
        '#description', '.product-description', '.description', 'section#description',
        '.desc', '#desc', '.product-desc'
      ],
      specifications: [
        '#specifications', '.specs', '.specifications', 'section#specifications',
        '.product-specs', '.tech-specs', '.spec-list', '.specification-list', '.spec-table'
      ],
      features: [
        '.features', '#features', 'section#features', '.feature-list',
        '.product-features', '#key-features', '#feature-highlights',
        '.benefits', '.feature-benefits', '.highlight-list'
      ],
      // **UPDATED**: include Spectra’s container ID plus any “container” suffixes
      included: [
        'text="What’s in the box"', 'text="Included Items"', 'text="Product Includes"',
        '.included', '.includes', '.in-the-box', '.box-contents',
        '#included-items', '#package-contents', '.accessories', '.accessory-list',
        '.item-included',
        '#tab-id-2-container', '[id$="-container"]'
      ]
    };

    const serialize = el => el ? el.innerText.replace(/\s+\n/g,'\n').trim() : '';
    function findFirst(arr) {
      for (const s of arr) {
        try {
          const e = document.querySelector(s);
          if (e) return e;
        } catch {}
      }
      return null;
    }

    // 1) Core grabs
    sections.description    = serialize(findFirst(map.description))
                             || document.querySelector('meta[name="description"]')?.content.trim() || '';
    sections.specifications = serialize(findFirst(map.specifications));
    sections.features       = serialize(findFirst(map.features));

    // 2) Primary included
    sections.included = serialize(findFirst(map.included));

    // 3) Fallback: any tab/panel by ID/class
    if (!sections.included) {
      const sel = [
        '[role="tabpanel"]',
        '.tab-content', '.tab-panel', '.accordion-content',
        '[id^="tab-"]', '[class*="tab-"]', '[class*="Tab"]',
        '[id$="-container"]'
      ].join(',');
      for (const p of document.querySelectorAll(sel)) {
        const txt = p.innerText.trim().toLowerCase();
        if (txt.includes("what’s in the box") ||
            txt.includes("included items") ||
            txt.includes("product includes")) {
          sections.included = p.innerText.replace(/\s+\n/g,'\n').trim();
          break;
        }
      }
    }

    // 4) Definition-list fallback
    const dls = [...document.querySelectorAll('dl')].map(dl => dl.innerText.trim());
    if (dls.length) sections.dl = dls.join('\n---\n');

    // 5) Capture all panels under sections.tabs
    const panels = document.querySelectorAll([
      '[role="tabpanel"]',
      '.tab-content', '.tab-panel', '.accordion-content',
      '[id^="tab-"]', '[class*="tab-"]', '[class*="Tab"]',
      '[id$="-container"]'
    ].join(','));
    sections.tabs = {};
    panels.forEach(p => {
      const key = p.getAttribute('aria-labelledby')
                || p.id
                || p.previousElementSibling?.innerText
                || 'tab';
      sections.tabs[key.trim().slice(0,30)] = p.innerText.trim();
    });

    return sections;
  });
}

async function collectLinks(page) { /* unchanged */ }
async function collectMicrodata(page) { /* unchanged */ }
async function collectLinkHints(page) { /* unchanged */ }
async function collectTemplates(page) { /* unchanged */ }
async function collectInlineData(page) { /* unchanged */ }
async function collectShadowText(page) { /* unchanged */ }
async function collectCssBackgrounds(page) { /* unchanged */ }
async function collectSeoMeta(page) { /* unchanged */ }
async function collectImagesWithAlt(page) { /* unchanged */ }

export async function browseProduct(url, opts = {}) {
  // ... unchanged browseProduct logic (autoExpand, scrolling, etc.) ...
}
