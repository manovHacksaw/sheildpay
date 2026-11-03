import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

// E2E=1 builds a test variant for e2e/run.mjs: also runs on the local mock checkout, talks to the
// free-test server on :8793, and leaves the overlay's shadow DOM open so Playwright can reach it.
const e2e = process.env.E2E === "1";
const m = structuredClone(manifest) as typeof manifest;
if (e2e) {
  m.content_scripts[0].matches.push("http://test.shieldcheckout.local/*");
  m.host_permissions.push("http://localhost:8793/*");
}

export default defineConfig({
  plugins: [crx({ manifest: m })],
  define: { __E2E__: JSON.stringify(e2e) },
  build: e2e ? { outDir: "dist-e2e" } : undefined,
  test: { environment: "jsdom" },
});
