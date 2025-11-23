// central-gpt-client.ts
// Small TypeScript wrapper to call your centralized GPT backend (HTTP).
// Place: medx-ingest-api/workers/gpt/central-gpt-client.ts
//
// Env:
//   CENTRAL_GPT_URL - e.g. https://gpt-backend.internal/api/generate
//   CENTRAL_GPT_KEY - secret or API key for calling centralized GPT (if required)
//
// The centralized backend is expected to accept POST { prompt, system, options } and return { ok: true, output: string, tokens?: number }

import fetch from "node-fetch";

const CENTRAL_GPT_URL = process.env.CENTRAL_GPT_URL;
const CENTRAL_GPT_KEY = process.env.CENTRAL_GPT_KEY || "";

if (!CENTRAL_GPT_URL) {
  // throw at import time to make missing config obvious during dev/deploy
  throw new Error("CENTRAL_GPT_URL is required");
}

export async function callCentralGpt(payload: { system?: string; prompt: string; max_tokens?: number; metadata?: any }) {
  const res = await fetch(CENTRAL_GPT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(CENTRAL_GPT_KEY ? { "x-api-key": CENTRAL_GPT_KEY } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Central GPT responded ${res.status}: ${text}`);
  }
  const data = await res.json();
  // expected: { ok: boolean, output: string, tokens?: number, raw?: any }
  return data;
}
