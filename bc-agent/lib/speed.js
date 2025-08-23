import fetch from "node-fetch";

export async function auditSpeed({ url, strategy = "mobile" }) {
  if(!process.env.PAGESPEED_API_KEY) {
    return { note: "PAGESPEED_API_KEY not set; skipping audit." };
  }
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=PERFORMANCE&key=${process.env.PAGESPEED_API_KEY}`;
  const r = await fetch(endpoint);
  if(!r.ok) throw new Error(`PageSpeed ${r.status}`);
  const data = await r.json();

  const L = data.lighthouseResult;
  const audits = L?.audits || {};
  const metrics = {
    performance: L?.categories?.performance?.score ?? null,
    LCP: audits["largest-contentful-paint"]?.displayValue,
    TBT: audits["total-blocking-time"]?.displayValue,
    CLS: audits["cumulative-layout-shift"]?.displayValue
  };
  const opps = (audits["diagnostics"]?.details?.items?.length ? [] : [])
    .concat(
      Object.values(audits)
        .filter(a => a?.details?.type === "opportunity")
        .map(a => ({ id: a.id, title: a.title, savings: a.details.overallSavingsMs }))
    );

  // High-impact heuristics
  const actions = [];
  if (audits["modern-image-formats"]?.score < 1) actions.push("Serve images in WebP/AVIF.");
  if (audits["unused-javascript"]?.score < 1) actions.push("Reduce/defers unused JS (apps, trackers).");
  if (audits["render-blocking-resources"]?.score < 1) actions.push("Inline critical CSS; defer non-critical CSS/JS.");
  if (audits["offscreen-images"]?.score < 1) actions.push("Add loading=lazy to below-the-fold images.");
  if (audits["uses-responsive-images"]?.score < 1) actions.push("Provide responsive srcset/sizes.");
  if (audits["uses-rel-preconnect"]?.score < 1) actions.push("Preconnect CDN/origin and critical third parties.");

  return { metrics, opportunities: opps, actions };
}
