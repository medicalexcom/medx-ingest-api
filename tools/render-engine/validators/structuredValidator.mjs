// tools/render-engine/validators/structuredValidator.mjs
// AJV-based structured validator with ajv-formats support and resilient dynamic import.

import fs from "fs/promises";
import path from "path";

let validateFn = null;
let ajvLoaded = false;
let ajvLoadError = null;

async function initValidator() {
  if (validateFn !== null || ajvLoadError) return;
  try {
    // Dynamically import AJV and ajv-formats to avoid crash at module import time
    const AjvModule = await import("ajv").catch(err => { throw err; });
    const Ajv = AjvModule.default || AjvModule;

    // import ajv-formats
    const addFormatsModule = await import("ajv-formats").catch(err => { throw err; });
    const addFormats = addFormatsModule.default || addFormatsModule;

    const schemaPath = path.resolve(process.cwd(), "tools", "render-engine", "schema", "describeSchema.json");
    const schemaText = await fs.readFile(schemaPath, "utf8");
    const schema = JSON.parse(schemaText);

    // create AJV with reasonable options
    const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    // add formats (uri, email, date-time, etc.)
    addFormats(ajv);

    validateFn = ajv.compile(schema);
    ajvLoaded = true;
  } catch (err) {
    ajvLoaded = false;
    ajvLoadError = err;
    console.warn("structuredValidator: failed to initialize AJV/ajv-formats:", String(err?.message || err));
  }
}

export function validateStructuredResponse(parsed) {
  // ensure init was attempted (best-effort)
  initValidator().catch(() => { /* already captured in ajvLoadError */ });

  if (!ajvLoaded) {
    const loadMsg = ajvLoadError ? String(ajvLoadError.message || ajvLoadError) : "AJV not loaded";
    const violation = {
      section: "validators",
      issue: "AJV dependency missing or failed to load",
      fix_hint: "Install ajv and ajv-formats (e.g., npm install ajv ajv-formats --save) and redeploy. Error: " + loadMsg
    };
    return { valid: false, violations: [violation] };
  }

  if (typeof validateFn !== "function") {
    return {
      valid: false,
      violations: [
        { section: "validators", issue: "Validator initializing", fix_hint: "Retry after a moment; validator not yet ready" }
      ]
    };
  }

  const valid = validateFn(parsed);
  if (valid) {
    return { valid: true, violations: [] };
  } else {
    const errors = validateFn.errors || [];
    const violations = errors.map(e => ({
      section: "schema",
      issue: `${e.instancePath || '/'} ${e.message || 'validation error'}`,
      fix_hint: e.keyword ? `schema keyword: ${e.keyword}` : undefined
    }));
    return { valid: false, violations };
  }
}

export default validateStructuredResponse;
