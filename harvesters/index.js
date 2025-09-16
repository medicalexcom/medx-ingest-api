export { extractWordPressTabs } from './wordpress.js';
export { extractSalesforceTabs } from './salesforce.js';

export function getTabHarvester(siteType) {
  switch (siteType) {
    case 'wordpress':
      return extractWordPressTabs;
    case 'salesforce':
      return extractSalesforceTabs;
    default:
      return null;
  }
}
