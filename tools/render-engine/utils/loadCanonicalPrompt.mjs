import fs from 'fs/promises';
import path from 'path';

export async function loadCanonicalPrompt(filename = 'custom_gpt_instructions-32.md') {
  const p = path.resolve(process.cwd(), 'tools', 'render-engine', 'prompts', filename);
  const txt = await fs.readFile(p, { encoding: 'utf8' });
  return txt;
}

export default loadCanonicalPrompt;
