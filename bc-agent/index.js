import 'dotenv/config';
import pLimit from 'p-limit';
import { bcGetProducts, bcUpdateProduct, bcListImages, bcUpdateImageAlt } from './lib/bc.js';
import { generateSEO } from './lib/seo.js';
import { auditSpeed } from './lib/speed.js';
import { toBcPatch } from './lib/util.js';

async function fetchAllProducts(page = 1, products = []) {
  const { data, meta } = await bcGetProducts(page);
  products.push(...(data || []));
  if (meta && meta.pagination && meta.pagination.current_page < meta.pagination.total_pages) {
    return fetchAllProducts(page + 1, products);
  }
  return products;
}

async function runSeoBatch() {
  let page = 1;
  // Process products page by page to avoid loading all products into memory at once.
  while (true) {
    const { data: products = [], meta } = await bcGetProducts(page);
    if (!products.length) {
      break;
    }
    const limit = pLimit(3);
    // For each product in the current page, generate SEO and update asynchronously with concurrency limit.
    await Promise.all(products.map(product =>
      limit(async () => {
        const seo = await generateSEO(product);
        const patch = toBcPatch(seo);
        await bcUpdateProduct(product.id, patch);
        const imgs = await bcListImages(product.id);
        await Promise.all((imgs.data || []).map((img, i) =>
          bcUpdateImageAlt(product.id, img.id, seo.imageAlt[i], product.name)
        ));
        console.log('Updated', product.id, patch.custom_url.url);
      })
    ));
    // If there are no more pages, exit loop.
    if (!meta || !meta.pagination || page >= meta.pagination.total_pages) {
      break;
    }
    page++;
  }
}

async function runSeoOne(productId) {
  const id = productId || process.env.PRODUCT_ID;
  if (!id) throw new Error('Provide productId or set PRODUCT_ID env');
  const allProducts = await fetchAllProducts();
  const product = allProducts.find(p => String(p.id) === String(id));
  if (!product) throw new Error(`Product ${id} not found`);
  const seo = await generateSEO(product);
  const patch = toBcPatch(seo);
  await bcUpdateProduct(product.id, patch);
  const imgs = await bcListImages(product.id);
  await Promise.all((imgs.data || []).map((img, i) =>
    bcUpdateImageAlt(product.id, img.id, seo.imageAlt[i], product.name)
  ));
  console.log('Updated', product.id, patch.custom_url.url);
}

async function runSpeedAudit() {
  const origin = process.env.STORE_ORIGIN;
  if (!origin) throw new Error('Set STORE_ORIGIN in .env');
  const res = await auditSpeed({ url: origin, strategy: 'mobile' });
  console.log('Metrics:', res.metrics);
  console.log('Actions:', res.actions);
  console.table(res.opportunities || []);
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === 'seo-batch') {
      await runSeoBatch();
    } else if (cmd === 'seo-one') {
      const productId = process.argv[3];
      await runSeoOne(productId);
    } else if (cmd === 'speed-audit') {
      await runSpeedAudit();
    } else {
      console.log('Commands:');
      console.log('  npm run seo:batch      # optimize SEO for all products');
      console.log('  npm run seo:one [PRODUCT_ID]   # optimize SEO for a single product');
      console.log('  npm run speed:audit    # PageSpeed audit');
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
