// ESM: loadPrompt.mjs
import fs from "fs";
import path from "path";

export function loadPrompt(filename) {
  const base = path.join(process.cwd(), "tools", "render-engine", "prompts");
  const full = path.join(base, filename);
  if (!fs.existsSync(full)) {
    throw new Error(`Prompt file not found: ${full}`);
  }
  return fs.readFileSync(full, "utf8");
}
