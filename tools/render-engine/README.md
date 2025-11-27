# Avidia Render Engine (minimal)

This folder contains a minimal Render engine that exposes POST /describe.
The engine validates `x-engine-key` against `RENDER_ENGINE_SECRET` and either:
- calls OpenAI (if `OPENAI_API_KEY` is set) to produce normalized JSON, or
- returns a deterministic mock response.

Files:
- server.js
- package.json
- .env.example

Environment variables (set in Render and match Vercel):
- RENDER_ENGINE_SECRET (required) — must match Vercel's value
- OPENAI_API_KEY (optional) — if set, the engine will call OpenAI
- PORT (optional)

Deploying to Render.com:
1. Push this folder to a GitHub repo or your monorepo.
2. Create a new Web Service on Render, link the repo/path to this folder.
3. Build command: `npm install`
4. Start command: `npm start`
5. Set environment variables in Render: `RENDER_ENGINE_SECRET` (and `OPENAI_API_KEY` if you want GPT output).
6. Test:
   curl -v -X POST "https://<your-render-host>/describe" \
     -H "Content-Type: application/json" \
     -H "x-engine-key: <RENDER_ENGINE_SECRET>" \
     -d '{"name":"Test","shortDescription":"Short"}'
