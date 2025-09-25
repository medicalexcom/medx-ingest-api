/* fallbackResolver.js
 *
 * Centralizes the logic for merging multiple sources of scraped data.
 */

export function resolveProductData({ dom, pdf_text, tab_html, json_ld, metadata } = {}) {
  const result = {
    name: '',
    description_raw: '',
    specs: {},
    images: [],
    manuals: []
  };

  // Prefer structured JSON-LD for name and description
  if (Array.isArray(json_ld)) {
    for (const obj of json_ld) {
      if (obj['@type'] && obj['@type'].toLowerCase().includes('product')) {
        result.name = result.name || obj.name || '';
        result.description_raw = result.description_raw || obj.description || '';
        if (obj.image) {
          const imgs = Array.isArray(obj.image) ? obj.image : [obj.image];
          result.images.push(...imgs.map(String));
        }
        break;
      }
    }
  }

  // Fallback to tab_html or dom for description if empty
  if (!result.description_raw) {
    const html = tab_html || dom || '';
    const tmp = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    result.description_raw = tmp.split(' ').slice(0, 200).join(' ');
  }

  // Extract manuals from metadata or PDF text (placeholder)
  if (pdf_text) {
    result.manuals.push('');
  }

  return result;
}
