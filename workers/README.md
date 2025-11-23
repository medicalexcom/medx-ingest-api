```markdown
# medx-ingest-api/workers README

This folder contains a minimal BullMQ + worker scaffold and a GPT_SEO worker that calls your centralized GPT backend.

Files
- queue.js : BullMQ queue and worker factory. Requires REDIS_URL.
- gpt/central-gpt-client.ts : wrapper to call centralized GPT backend (CENTRAL_GPT_URL).
- gpt/schemas/seo-schema.ts : zod schema for SEO module output.
- seo/seo-worker.ts : the SEO module worker (listens on queue 'seo').

Environment variables (minimum for local testing)
- REDIS_URL (redis://...)
- CENTRAL_GPT_URL (http endpoint that runs prompts)
- CENTRAL_GPT_KEY (optional, for centralized GPT auth)
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY

Quick start (local)
1. Install deps:
   - npm install bullmq ioredis node-fetch @supabase/supabase-js zod
   (or yarn add ...)

2. Start Redis (local or remote). Example using Docker:
   docker run -p 6379:6379 -d redis

3. Start an SEO worker:
   node workers/seo/seo-worker.ts

4. Queue a job (example Node snippet):
   const { getQueue } = require('./workers/queue');
   const q = getQueue('seo');
   q.add('run-seo', { jobId: '<uuid>', tenant_id: '<tenant>', raw_payload: { title:'Test', description:'...' } });

Notes
- Currently seo-worker merges the SEO result into product_ingestions.normalized_payload. For scale/consistency consider:
  - per-module result table (ingestion_job_modules) and a final assembly step
  - transactional upserts or row-level locks to avoid race conditions
- Replace central-gpt-client.ts with your real centralized-GPT client if you have a richer protocol.
```
