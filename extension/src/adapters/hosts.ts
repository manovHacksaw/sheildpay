// Keep in sync with MERCHANTS in server/src/bitrefill.ts (and manifest.json content_scripts.matches).
// Only Flipkart is verified end to end. More hosts must also be enabled in the manifest and ENABLED_MERCHANTS (server).
export const HOSTS: string[] = [
  "www.flipkart.com",
  "test.shieldcheckout.local", // only reachable through the e2e build; the server only sells the free test card here
];
