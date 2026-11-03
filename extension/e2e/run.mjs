// Full e2e on mainnet with the free Bitrefill test card (no float spent, ~0.0002 ZEC in fees):
// real extension build -> mock checkout page -> quote -> real shielded payment -> card issued -> auto-applied.
// Needs: watcher on :8788, `MAINNET_FREE_TEST=1 PORT=8793 npm start` in server/, `npm run e2e:build`.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const dir = path.dirname(new URL(import.meta.url).pathname);
const ext = path.resolve(dir, "../dist-e2e");
const SCRATCH = process.env.SCRATCH;
const DEVTOOL = `${SCRATCH}/devtool/bin/zcash-devtool`;
const WALLET = `${SCRATCH}/main-wallet`;
const chromePath = fs.readdirSync(`${os.homedir()}/Library/Caches/ms-playwright`).filter((d) => d.startsWith("chromium-")).sort().pop();
const exe = `${os.homedir()}/Library/Caches/ms-playwright/${chromePath}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const page_html = fs.readFileSync(path.join(dir, "checkout.html"));
const srv = http.createServer((_, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(page_html); }).listen(8090);

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "sc-")), {
  executablePath: exe,
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--host-resolver-rules=MAP test.shieldcheckout.local 127.0.0.1", "--headless=new"],
});
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("page error:", m.text()));
const step = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
let ok = false;
try {
  await page.goto("http://test.shieldcheckout.local:8090/checkout");
  const pay = page.locator("#shieldcheckout-root >> button#pay");
  await pay.waitFor({ timeout: 15000 });
  step("button: " + (await pay.textContent()));
  await pay.click();
  // The popup normally opens by itself; headless Chrome can't show it, so open it as a tab for the same tab id.
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  await page.waitForFunction(() => document.querySelector("#shieldcheckout-root").shadowRoot.querySelector("#box").textContent.includes("popup"), null, { timeout: 15000 });
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/index.html?tab=${tabId}`);
  await popup.locator("#go").waitFor({ timeout: 20000 });
  step("popup shows: " + (await popup.locator("main").innerText()).replace(/\n/g, " | ").slice(0, 200));
  await popup.locator("#go").click();
  await popup.locator("canvas").waitFor({ timeout: 20000 });
  step("popup payment screen: " + (await popup.locator("h1").innerText()));
  await page.bringToFront();

  // The order the extension just created is the newest one in the test server's store.
  const store = JSON.parse(fs.readFileSync(path.resolve(dir, "../../server/orders-freetest.json"), "utf8"));
  const o = store.recs.map((r) => r.order).filter((x) => x.status === "awaiting_payment").pop();
  step(`paying ${o.zecAmount} ZEC to ${o.address.slice(0, 12)}…`);
  const run = (args) => execFileSync(DEVTOOL, ["wallet", "-w", WALLET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["sync"]);
  const txid = run(["send", "--identity", `${WALLET}/identity.txt`, "--address", o.address, "--value", String(Math.round(o.zecAmount * 1e8))]).trim().split("\n").pop();
  step("sent, txid " + txid);

  await page.waitForFunction(() => window.__applied, null, { timeout: 8 * 60_000, polling: 2000 });
  const applied = await page.evaluate(() => window.__applied);
  step("page state after auto-apply: " + JSON.stringify({ code: applied.code.replace(/.(?=.{4})/g, "*"), pin: !!applied.pin }));
  step("total now: " + (await page.locator("#tot").textContent()) + "; message: " + (await page.locator("#msg").textContent()).replace(/:.*/, ""));
  ok = true;
} catch (e) {
  step("FAILED: " + e.message.split("\n")[0]);
  await page.screenshot({ path: path.join(dir, "fail.png") }).catch(() => {});
} finally {
  await ctx.close();
  srv.close();
}
process.exit(ok ? 0 : 1);
