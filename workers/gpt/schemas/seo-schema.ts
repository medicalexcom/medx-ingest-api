// seo-schema.ts (zod)
// Place: medx-ingest-api/workers/gpt/schemas/seo-schema.ts
//
// This file defines a zod schema for the SEO module output.
// If you're not using TypeScript in the repo, port this to a JSON Schema and validate with ajv.

import { z } from "zod";

export const SeoSchema = z.object({
  h1: z.string().min(1).max(200),
  title: z.string().min(1).max(100),
  meta_description: z.string().min(0).max(320),
  seo_short_description: z.string().optional(),
});

export type SeoOutput = z.infer<typeof SeoSchema>;
