# MedicalEx MASTER PROMPT (wrapper)

This file is a small wrapper. At runtime the server should read the canonical instructions
from tools/render-engine/prompts/custom_gpt_instructions-32.md and use them as the system instruction.

Usage guidance for integrators (include in runtime docs):
- Load the canonical text (tools/render-engine/prompts/custom_gpt_instructions-32.md)
- Prepend any environment/runtime notes if necessary (e.g., tenant hints)
- Pass the loaded canonical text to the model as the "system" message.

Example (not part of the model prompt, for integrators):
1. const systemPrompt = loadCanonicalPrompt('custom_gpt_instructions.md')
2. messages = [{ role: 'system', content: systemPrompt }, ...user grounding messages...]
