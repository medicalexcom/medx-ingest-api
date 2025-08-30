// publishGate.js
//
// This module implements a simple “publish gate” for cleaned product
// records.  The gate computes a completeness score based on the
// presence of critical fields and flags missing values.  It can be used
// by downstream processes to decide whether a scraped product is
// sufficiently complete to auto‑publish or should be routed for manual
// review.  The scoring logic is intentionally conservative: all
// required fields must be non‑empty and the overall score must meet a
// configurable threshold (default 95) before allowing publication.

/**
 * Compute the completeness of a cleaned product record.  Required
 * fields include the product name, brand, description, features and
 * specs.  The score is the percentage of present fields out of the
 * total required fields.  Empty arrays or empty strings count as
 * missing.  Additional fields can be included in the calculation via
 * the `options.requiredKeys` parameter.
 *
 * @param {Object} record A cleaned product record
 * @param {Object} options Optional settings (requiredKeys)
 * @returns {{completeness_score_0_100: number, missing: string[]}}
 */
export function computeCompleteness(record = {}, options = {}) {
  const defaultKeys = ['name', 'brand', 'description', 'features', 'specs'];
  const requiredKeys = options.requiredKeys || defaultKeys;
  let presentCount = 0;
  const missing = [];
  for (const key of requiredKeys) {
    const val = record[key];
    const isEmptyArray = Array.isArray(val) && val.length === 0;
    const isEmptyString = typeof val === 'string' && val.trim().length === 0;
    if (val === undefined || val === null || isEmptyArray || isEmptyString) {
      missing.push(key);
    } else {
      presentCount++;
    }
  }
  const completeness_score_0_100 = Math.round((presentCount / requiredKeys.length) * 100);
  return { completeness_score_0_100, missing };
}

/**
 * Determine whether a cleaned record meets the minimum criteria for
 * publishing.  A record is publishable only if no required fields
 * are missing and its completeness score meets or exceeds the given
 * threshold.
 *
 * @param {Object} record A cleaned product record
 * @param {Object} options Optional settings (threshold, requiredKeys)
 * @returns {{ok: boolean, missing: string[], score: number}}
 */
export function shouldPublish(record = {}, options = {}) {
  const threshold = options.threshold ?? 95;
  const { completeness_score_0_100: score, missing } = computeCompleteness(record, options);
  return { ok: missing.length === 0 && score >= threshold, missing, score }; 
}
