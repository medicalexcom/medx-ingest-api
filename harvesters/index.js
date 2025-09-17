export { extractWordPressTabs } from './wordpress.js';
export { extractSalesforceTabs } from './salesforce.js';
export { extractShopifyTabs } from './shopify.js';
export { extractBigCommerceTabs } from './bigcommerce.js';
export { extractMagentoTabs } from './magento.js';
export { extractSquarespaceTabs } from './squarespace.js';
export { extractWixTabs } from './wix.js';

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
    case 'magento':
      return extractMagentoTabs;
    case 'squarespace':
      return extractSquarespaceTabs;
    case 'wix':
      return extractWixTabs;
    default:
      return null;
  }
}
