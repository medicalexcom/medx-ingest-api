// injectVariables.mjs
export function injectVariables(template, variables = {}) {
  if (!template || typeof template !== "string") return template;
  let out = template;
  // Simple placeholder format: {{VAR_NAME}}
  for (const [key, value] of Object.entries(variables || {})) {
    const token = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, "g");
    out = out.replace(token, String(value ?? ""));
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
