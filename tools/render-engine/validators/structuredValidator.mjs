// tools/render-engine/validators/structuredValidator.mjs
// Resilient AJV validator: dynamically imports ajv to avoid top-level ERR_MODULE_NOT_FOUND crashes.
// If ajv is missing, the validator returns a clear violation explaining that AJV must be installed.

import fs from 'fs/promises';
import path from 'path';

let validateFn = null;
let ajvLoaded = false;
let ajvLoadError = null;

async function initValidator() {
  if (validateFn !== null || ajvLoadError) return;
  try {
    // Dynamically import AJV to avoid failing at module import time if ajv isn't installed
    const AjvModule = await import('ajv').catch(err => { throw err; });
    const Ajv = AjvModule.default || AjvModule;
    const schemaPath = path.resolve(process.cwd(), 'tools', 'render-engine', 'schema', 'describeSchema.json');
    const schemaText = await fs.readFile(schemaPath, 'utf8');
    const schema = JSON.parse(schemaText);
    const ajv = new Ajv({ allErrors: true, strict: false });
    validateFn = ajv.compile(schema);
    ajvLoaded = true;
  } catch (err) {
    // Do NOT rethrow — record the error so we can return a structured violation later
    ajvLoaded = false;
    ajvLoadError = err;
    // Log a friendly warning (server logs only)
    console.warn('structuredValidator: AJV failed to load:', String(err?.message || err));
  }
}

// Synchronous wrapper used by the server (server will call this on each model response)
export function validateStructuredResponse(parsed) {
  // Ensure validator initialization has been attempted.
  // We call initValidator() asynchronously but do not await here to preserve sync API.
  // If initValidator hasn't run yet, kick it off (best-effort).
  initValidator().catch(() => { /* already captured in ajvLoadError */ });

  // If AJV failed to load, return a clear violation rather than crashing
  if (!ajvLoaded) {
    const loadMsg = ajvLoadError ? String(ajvLoadError.message || ajvLoadError) : 'AJV not loaded';
    const violation = {
      section: 'validators',
      issue: 'AJV dependency missing or failed to load',
      fix_hint: 'Install ajv (e.g., npm install ajv --save) and redeploy. Error: ' + loadMsg
    };
    return { valid: false, violations: [violation] };
  }

  // If validateFn is not yet compiled (race), conservatively return a violation
  if (typeof validateFn !== 'function') {
    return {
      valid: false,
      violations: [
        { section: 'validators', issue: 'Validator initializing', fix_hint: 'Retry after a moment; validator not yet ready' }
      ]
    };
  }

  const valid = validateFn(parsed);
  if (valid) {
    return { valid: true, violations: [] };
  } else {
    const errors = validateFn.errors || [];
    const violations = errors.map(e => ({
      section: 'schema',
      issue: `${e.instancePath || '/'} ${e.message || 'validation error'}`,
      fix_hint: e.keyword ? `schema keyword: ${e.keyword}` : undefined
    }));
    return { valid: false, violations };
  }
}

export default validateStructuredResponse;
