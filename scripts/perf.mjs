// GPU frame cost across the film: node scripts/perf.mjs 1920x1080 [q]
import { chromium } from "playwright";
const [w, h] = (process.argv[2] ?? "1920x1080").split("x").map(Number);
const q = process.argv[3] ?? "high";
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 600)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:5317/?capture&q=${q}`);
await page.waitForFunction(() => window.UNBROKEN?.ready || window.UNBROKEN_ERROR, null, { timeout: 300000 });
console.log("load + warm ms", Date.now() - t0, "| trees", await page.evaluate(() => UNBROKEN.forest.counts.trees), "| leaf+bark tris", await page.evaluate(() => UNBROKEN.forest.counts.tris));
const results = await page.evaluate(async () => {
  const out = [];
  for (let t = 0.5; t < 56; t += 3.5) {
    await UNBROKEN.renderAt(t);
    await UNBROKEN.renderAt(t + 1 / 60);
    const s = performance.now();
    for (let i = 2; i < 8; i++) await UNBROKEN.renderAt(t + i / 60);
    out.push([t, (performance.now() - s) / 6]);
  }
  return out;
});
for (const [t, ms] of results) console.log(`t=${t.toFixed(1).padStart(5)}  ${ms.toFixed(1).padStart(6)} ms  ${"#".repeat(Math.min(70, Math.round(ms)))}`);
await browser.close();
