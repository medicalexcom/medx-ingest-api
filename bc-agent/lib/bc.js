import fetch from "node-fetch";

const BASE = (hash) => `https://api.bigcommerce.com/stores/${hash}/v3`;

const headers = () => ({
  "X-Auth-Client": process.env.BC_CLIENT_ID,
  "X-Auth-Token": process.env.BC_ACCESS_TOKEN,
  "Accept": "application/json",
  "Content-Type": "application/json"
});

const assertEnv = () => {
  ["BC_STORE_HASH","BC_CLIENT_ID","BC_ACCESS_TOKEN"].forEach(k=>{
    if(!process.env[k]) throw new Error(`Missing env ${k}`);
  });
};

export async function bcGetProducts({page=1, limit=50, include="images,custom_fields"}={}) {
  assertEnv();
  const url = `${BASE(process.env.BC_STORE_HASH)}/catalog/products?limit=${limit}&page=${page}&include=${encodeURIComponent(include)}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`GET products ${r.status}`);
  return r.json(); // { data, meta }
}

export async function bcUpdateProduct(productId, patch) {
  assertEnv();
  const url = `${BASE(process.env.BC_STORE_HASH)}/catalog/products/${productId}`;
  const r = await fetch(url, { method:"PUT", headers: headers(), body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`PUT product ${productId} ${r.status}`);
  return r.json();
}

export async function bcListImages(productId) {
  assertEnv();
  const url = `${BASE(process.env.BC_STORE_HASH)}/catalog/products/${productId}/images`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`GET images ${productId} ${r.status}`);
  return r.json(); // { data: [ { id, description, ... } ] }
}

export async function bcUpdateImageAlt(productId, imageId, altText) {
  assertEnv();
  const url = `${BASE(process.env.BC_STORE_HASH)}/catalog/products/${productId}/images/${imageId}`;
  const r = await fetch(url, { method:"PUT", headers: headers(), body: JSON.stringify({ description: altText }) });
  if (!r.ok) throw new Error(`PUT image ${imageId} ${r.status}`);
  return r.json();
}
