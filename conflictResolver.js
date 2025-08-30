// medx-ingest-api/conflictResolver.js
//
// Simple conflict resolver for merging scraped data from multiple sources.
// Given product data extracted from the DOM (A), PDF manuals (B), and a live
// page scrape (C), this module chooses a winner for each field and records
// conflicts for auditability.  The resolver prefers DOM values first,
// falling back to PDF and then to the live page.  When values disagree,
// it records the discarded value along with the source.
//
// Exported functions:
//   resolveData(A, B, C) -> { output: { ...fields }, conflicts: [...] }
//

/**
 * Resolve a single field from three possible sources.  Prefers A over B,
 * and B over C.  If multiple sources disagree, returns the chosen value
 * and a conflict record.
 *
 * @param {string} field The field name
 * @param {*} a Value from DOM scrape (source A)
 * @param {*} b Value from PDF/manuals (source B)
 * @param {*} c Value from live URL (source C)
 * @returns {{ value: any, conflict: object|null }}
 */
function resolveField(field, a, b, c) {
  // Determine the preferred value
  let value = a ?? (b ?? c ?? null);
  let conflict = null;
  // Collect all non-null values
  const values = { A: a, B: b, C: c };
  // Identify if there is a disagreement
  const differentSources = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .reduce((acc, [src, val]) => {
      acc[val] = (acc[val] || []);
      acc[val].push(src);
      return acc;
    }, {});
  // If more than one unique value exists, record a conflict
  if (Object.keys(differentSources).length > 1) {
    // Determine which source provided the chosen value
    const chosenSource =
      a === value ? 'A' : b === value ? 'B' : c === value ? 'C' : '';
    // Capture other values
    const discarded = Object.entries(differentSources)
      .filter(([val]) => val !== value)
      .map(([val, srcs]) => ({ srcs, val }));
    conflict = {
      field,
      choice: chosenSource,
      discarded_value: discarded.map(d => `${d.val} (from ${d.srcs.join('+')})`).join('; '),
      reason: 'Values differ between sources',
    };
  }
  return { value, conflict };
}

/**
 * Resolve multiple fields across three source objects.
 *
 * @param {object} A Data extracted from DOM scrape
 * @param {object} B Data extracted from PDF/manuals
 * @param {object} C Data extracted from live URL
 * @returns {{ output: object, conflicts: object[] }}
 */
function resolveData(A = {}, B = {}, C = {}) {
  const output = {};
  const conflicts = [];
  // Create a unified set of all keys
  const allFields = new Set([
    ...Object.keys(A || {}),
    ...Object.keys(B || {}),
    ...Object.keys(C || {}),
  ]);
  allFields.forEach(field => {
    const { value, conflict } = resolveField(
      field,
      A ? A[field] : undefined,
      B ? B[field] : undefined,
      C ? C[field] : undefined
    );
    output[field] = value;
    if (conflict) conflicts.push(conflict);
  });
  return { output, conflicts };
}

export { resolveField, resolveData };
