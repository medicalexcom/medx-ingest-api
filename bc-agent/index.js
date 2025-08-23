import "dotenv/config";
import ora from "ora";
import pLimit from "p-limit";
import { bcGetProducts, bcUpdateProduct, bcListImages, bcUpdateImageAlt } from "./lib/bc.js";
import { generateSEO } from "./lib/seo.js";
import { toBcPatch } from "./lib/util.js";
import { auditSpeed } from "./lib/speed.js";

const limit = pLimit(3); // polite concurrency

async function fetchAllProducts(max = 200) {
  const pageSize = 50;
  let page = 1, all = [];
  while (all.length < max) {
    const { data, meta } = await bcGetProducts({ page, limit: pageSize, include: "images,custom_fields" });
    if (!data?.length) break;
    all = all.concat(data);
    const total = meta?.pagination?.total || 0;
    if (page * pageSize >= total) break;
    page++;
  }
  return all.slice(0, max);
}

async function runSeoBatch() {
  const spinner = ora("Loading products…").start();
  const products = await fetchAllProducts(100); // adjust batch size
  spinner.succeed(`Loaded ${products.length} products`);

  const jobs = products.map(p => limit(async () => {
    const context = {
      productName: p.name,
      brand: p.brand_name,
      categories: p.categories, // may be undefined unless included; fine for prompt
      features: [],             // plug your scraper outputs here
      specs: [],                // plug your scraper outputs here
      warranty: "",
      currentDescription: p.description || "",
      imageHints: (p.images || []).map(img => img.url_standard)
    };

    const seo = await generateSEO(context);
    const patch = toBcPatch(seo);

    await bcUpdateProduct(p.id, patch);

    // Update image alt text
    if (seo.imageAlt && seo.imageAlt.length) {
      const imgs = await bcListImages(p.id);
      const arr = imgs.data || [];
      await Promise.all(arr.map((img, i) => limit(() =>
        bcUpdateImageAlt(p.id, img.id, seo.imageAlt[i] || `${p.name}`)
      )));
    }

    return { id: p.id, name: p.name, slug: patch.custom_url.url };
  }));

  const results = [];
  for (const j of jobs) {
    try {
      results.push(await j);
    } catch (e) {
      console.error("SEO update failed:", e.message);
    }
  }
  console.table(results);
}

async function runSeoOne() {
  // Edit this ID to test a single product quickly
  const testId = Number(process.env.TEST_PRODUCT_ID || 0);
  if (!testId) throw new Error("Set TEST_PRODUCT_ID in .env");

  const { data } = await bcGetProducts({ page: 1, limit: 1, include: "images,custom_fields" });
  const product = data.find(p => p.id === testId) || data[0];

  const ctx = {
    productName: product.name,
    brand: product.brand_name,
    categories: product.categories,
    features: [],
    specs: [],
    warranty: "",
    currentDescription: product.description || "",
    imageHints: (product.images || []).map(img => img.url_standard)
  };

  const seo = await generateSEO(ctx);
  const patch = toBcPatch(seo);

  await bcUpdateProduct(product.id, patch);

  if (seo.imageAlt && seo.imageAlt.length) {
    const imgs = await bcListImages(product.id);
    await Promise.all((imgs.data || []).map((img, i) =>
      bcUpdateImageAlt(product.id, img.id, seo.imageAlt[i] || product.name)
    ));
  }
import "dotenv/config.js";
import ora from "ora";
import pLimit from "p-limit";
import { bcGetProducts, bcUpdateProduct, bcListImages, bcUpdateImageAlt } from "./lib/bc.js";
import { generateSEO } from "./lib/seo.js";
import { toBcPatch } from "./lib/util.js";
import { auditSpeed } from "./lib/speed.js";

const limit = pLimit(3); // polite concurrency

async function fetchAllProducts(max = 200) {
  const pageSize = 50;
  let page = 1, all = [];
  while (all.length < max) {
    const { data, meta } = await bcGetProducts({ page, limit: pageSize, include: "images,custom_fields" });
    if (!data?.length) break;
    all = all.concat(data);
    const total = meta?.pagination?.total || 0;
    if (page * pageSize >= total) break;
    page++;
  }
  return all.slice(0, max);
}

async function runSeoBatch() {
  const spinner = ora("Loading products…").start();
  const products = await fetchAllProducts(100); // adjust batch size
  spinner.succeed(`Loaded ${products.length} products`);

  const jobs = products.map(p => limit(async () => {
    const context = {
      productName: p.name,
      brand: p.brand_name,
      categories: p.categories, // may be undefined unless included; fine for prompt
      features: [],             // plug your scraper outputs here
      specs: [],                // plug your scraper outputs here
      warranty: "",
      currentDescription: p.description || "",
      imageHints: (p.images || []).map(img => img.url_standard)
    };

    const seo = await generateSEO(context);
    const patch = toBcPatch(seo);

    await bcUpdateProduct(p.id, patch);

    // Update image alt text
    if (seo.imageAlt && seo.imageAlt.length) {
      const imgs = await bcListImages(p.id);
      const arr = imgs.data || [];
      await Promise.all(arr.map((img, i) => limit(() =>
        bcUpdateImageAlt(p.id, img.id, seo.imageAlt[i] || `${p.name}`)
      )));
    }

    return { id: p.id, name: p.name, slug: patch.custom_url.url };
  }));

  const results = [];
  for (const j of jobs) {
    try {
      results.push(await j);
    } catch (e) {
      console.error("SEO update failed:", e.message);
    }
  }
  console.table(results);
}

async function runSeoOne() {
  // Edit this ID to test a single product quickly
  const testId = Number(process.env.TEST_PRODUCT_ID || 0);
  if (!testId) throw new Error("Set TEST_PRODUCT_ID in .env");

  const { data } = await bcGetProducts({ page: 1, limit: 1, include: "images,custom_fields" });
  const product = data.find(p => p.id === testId) || data[0];

  const ctx = {
    productName: product.name,
    brand: product.brand_name,
    categories: product.categories,
    features: [],
    specs: [],
    warranty: "",
    currentDescription: product.description || "",
    imageHints: (product.images || []).map(img => img.url_standard)
  };

  const seo = await generateSEO(ctx);
  const patch = toBcPatch(seo);

  await bcUpdateProduct(product.id, patch);

  if (seo.imageAlt && seo.imageAlt.length) {
    const imgs = await bcListImages(product.id);
    await Promise.all((imgs.data || []).map((img, i) =>
      bcUpdateImageAlt(product.id, img.id, seo.imageAlt[i] || product.name)
    ));
  }

  console.log("Updated", product.id, patch.custom_url.url);
}

async function runSpeedAudit() {
  const origin = process.env.STORE_ORIGIN;
  if (!origin) throw new Error("Set STORE_ORIGIN in .env");
  const res = await auditSpeed({ url: origin, strategy: "mobile" });
  console.log("Metrics:", res.metrics);
  console.log("Actions:", res.actions);
  console.table(res.opportunities || []);
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === "seo-batch") await runSeoBatch();
    else if (cmd === "seo-one") await runSeoOne();
    else if (cmd === "speed-audit") await runSpeedAudit();
    else {
      console.log("Commands:");
      console.log("  npm run seo:batch   # optimize first 100 products");
      console.log("  npm run seo:one     # optimize a single product (TEST_PRODUCT_ID)");
      console.log("  npm run speed:audit # PageSpeed audit for STORE_ORIGIN");
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
  console.log("Updated", product.id, patch.custom_url.url);
}

async function runSpeedAudit() {
  const origin = process.env.STORE_ORIGIN;
  if (!origin) throw new Error("Set STORE_ORIGIN in .env");
  const res = await auditSpeed({ url: origin, strategy: "mobile" });
  console.log("Metrics:", res.metrics);
  console.log("Actions:", res.actions);
  console.table(res.opportunities || []);
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === "seo-batch") await runSeoBatch();
    else if (cmd === "seo-one") await runSeoOne();
    else if (cmd === "speed-audit") await runSpeedAudit();
    else {
      console.log("Commands:");
      console.log("  npm run seo:batch   # optimize first 100 products");
      console.log("  npm run seo:one     # optimize a single product (TEST_PRODUCT_ID)");
      console.log("  npm run speed:audit # PageSpeed audit for STORE_ORIGIN");
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
