import fetch from "node-fetch";
import slugify from "slugify";

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function generateSEO(payload) {
  if(!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // lightweight guardrails
  const safeSlug = slugify(
    [payload.brand, payload.productName].filter(Boolean).join(" "),
    { lower: true, strict: true }
  ).slice(0, 60);

  const fs = await import('node:fs');
  const system = fs.readFileSync("prompts/seo.md", "utf8")
    .replaceAll("{{STORE_ORIGIN}}", process.env.STORE_ORIGIN || "https://example.com");

  const user = {
    productName: payload.productName,
    brand: payload.brand,
    categories: payload.categories,
    features: payload.features,
    specs: payload.specs,
    warranty: payload.warranty,
    currentDescription: payload.currentDescription,
    imageHints: payload.imageHints
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ],
      response_format: { type: "json_object" }
    })
  });

  if(!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${t}`);
  }

  const data = await r.json();
  const out = JSON.parse(data.choices[0].message.content);

  // clamp lengths
  out.title = (out.title || "").slice(0, 60);
  out.metaDescription = (out.metaDescription || "").slice(0, 155);
  out.slug = (out.slug && out.slug.length <= 80) ? out.slug : safeSlug;

  return out;
}
