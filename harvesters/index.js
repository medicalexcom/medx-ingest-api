export { extractWordPressTabs } from './wordpress.js';
export { extractSalesforceTabs } from './salesforce.js';
export { extractShopifyTabs } from './shopify.js';
export { extractBigCommerceTabs } from './bigcommerce.js';

export function getTabHarvester(siteType) {
  switch (siteType) {
    case 'wordpress':
      return extractWordPressTabs;
    case 'salesforce':
      return extractSalesforceTabs;
    case 'shopify':
      return extractShopifyTabs;
    case 'bigcommerce':
      return extractBigCommerceTabs;
    default:
      return null;
  }
}
