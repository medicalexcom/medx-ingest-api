# Describe prompt (wrapper)

This file points model authors and the runtime to the canonical instruction file.

Short instructions for model runs:
- Use the canonical instructions in tools/render-engine/prompts/custom_gpt_instructions.md as the authoritative system prompt.
- Return ONLY the structured JSON object defined in the canonical schema (tools/render-engine/schema/describeSchema.json).
- The server will handle schema validation, repair loops, and assembly.

Integrator note:
- The server should call the helper `loadCanonicalPrompt()` to build the system message for /describe model calls.
