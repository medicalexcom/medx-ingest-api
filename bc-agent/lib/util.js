export function pickBestDescription({ htmlDescription, fallback }) {
  return htmlDescription?.trim()?.length > 0 ? htmlDescription : fallback || "";
}

// Map clean SEO JSON → BigCommerce fields
export function toBcPatch(seoOut) {
  // BigCommerce fields: name, meta_description, page_title, search_keywords, custom_url
  return {
    name: seoOut.h1 || "",
    meta_description: seoOut.metaDescription || "",
    page_title: seoOut.title || "",
    search_keywords: (seoOut.keywords || []).join(", "),
    custom_url: { url: `/${seoOut.slug}`, is_customized: true },
    description: seoOut.htmlDescription || ""
  };
}
