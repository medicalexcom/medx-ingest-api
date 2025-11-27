import { loadPrompt } from "../utils/loadPrompt.mjs";
import { injectVariables } from "../utils/injectVariables.mjs";

export function buildPrompt(moduleName = "describe", vars = {}) {
  const master = loadPrompt("masterPrompt.md");
  const wrapperFile = `${moduleName}Prompt.md`;
  let wrapper = "";
  try {
    wrapper = loadPrompt(wrapperFile);
  } catch (e) {
    wrapper = `# ${moduleName} wrapper\nUse the master prompt for rules; produce module-specific output.`;
  }
  const combined = `${wrapper}\n\n${master}`;
  const filled = injectVariables(combined, vars);
  return filled;
}
