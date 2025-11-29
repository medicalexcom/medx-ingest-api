import Ajv from "ajv";
import addFormats from "ajv-formats";
import fs from "fs";
import path from "path";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemaPath = path.resolve(process.cwd(), "tools/render-engine/schema/describeSchema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const validate = ajv.compile(schema);

export function validateStructuredResponse(obj) {
  const ok = validate(obj);
  if (ok) return { valid: true, violations: [] };
  const violations = (validate.errors || []).map(err => {
    const field = err.instancePath ? err.instancePath.replace(/^\//, "") : err.schemaPath;
    return {
      section: "Schema",
      issue: `${err.message}${err.params && err.params.allowedValues ? `: ${err.params.allowedValues.join(", ")}` : ""}`,
      field,
      fix_hint: "Return the required structured field in the exact schema format"
    };
  });
  return { valid: false, violations };
}
