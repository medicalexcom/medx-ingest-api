// buildPrompt.mjs
import { loadPrompt } from "../utils/loadPrompt.mjs";
import { injectVariables } from "../utils/injectVariables.mjs";

/**
 * buildPrompt(moduleName, vars)
 * - moduleName: "describe", "seo", "extract", "specsSummary", "variants", "audit"
 * - vars: object map for placeholders (see your list)
 *
 * Returns a string with module wrapper + master prompt + injected variables.
 */
export function buildPrompt(moduleName = "describe", vars = {}) {
  // Load master first (authoritative)
  const master = loadPrompt("masterPrompt.md");
  // Module wrapper fallback
  const wrapperFile = `${moduleName}Prompt.md`;
  let wrapper = "";
  try {
    wrapper = loadPrompt(wrapperFile);
  } catch (e) {
    // Not found — fall back to a minimal wrapper
    wrapper = `# ${moduleName} wrapper\nUse the master prompt for rules; produce module-specific output.`;
  }

  // Final combined template: wrapper then master (module rules override or callouts first)
  const combined = `${wrapper}\n\n${master}`;

  // Inject variables into combined template
  const filled = injectVariables(combined, vars);

  return filled;
}
