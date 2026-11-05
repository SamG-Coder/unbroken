import { chromium } from "playwright";
const [out, t, ...keys] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on("pageerror", (e) => console.log("PAGEERR", (e.stack ?? String(e)).slice(0, 1500)));
page.on("console", (m) => { if (m.type() === "error") console.log("ERR", m.text().slice(0, 1800)); });
await page.goto(`http://127.0.0.1:5317/?freeze&t=${t}`);
await page.waitForFunction(() => window.UNBROKEN?.ready || window.UNBROKEN_ERROR, null, { timeout: 120000 });
await page.evaluate(() => UNBROKEN.renderer.backend.device.addEventListener("uncapturederror", (e) => console.error("GPU", e.error.message)));
for (const k of keys) {
  await page.evaluate((k) => { const U = UNBROKEN, d = U.post.dbg; U.post.pipeline.outputNode = eval(k); U.post.pipeline.needsUpdate = true; }, k);
  await page.waitForTimeout(1500);
  const name = `${out}/dbg-${keys.indexOf(k)}.png`;
  await page.screenshot({ path: name });
  console.log(k, "->", name);
}
await browser.close();
