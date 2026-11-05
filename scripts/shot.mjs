// Screenshot harness: node scripts/shot.mjs <outDir> <w>x<h> t1 t2 ... [--js "code"]
// Launches Edge with the real GPU, freezes the film at each time, lets TRAA settle, saves a PNG.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const out = args.shift();
const [w, h] = args.shift().split("x").map(Number);
let js = null;
const jsi = args.indexOf("--js");
if (jsi >= 0) { js = args[jsi + 1]; args.splice(jsi, 2); }
const times = args.map(Number);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-features=Vulkan,WebGPU"],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const seen = new Set();
const report = (k, s) => { const key = s.slice(0, 200); if (seen.has(key)) return; seen.add(key); console.log(k, s.slice(0, 2600)); };
page.on("pageerror", (e) => report("PAGEERROR", e.stack ?? String(e)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") report(m.type().toUpperCase(), m.text()); });

const started = Date.now();
await page.goto(`http://127.0.0.1:5317/?freeze&t=${times[0] ?? 0}`);
await page.waitForFunction(() => window.UNBROKEN?.ready || window.UNBROKEN_ERROR, null, { timeout: 180000 });
const err = await page.evaluate(() => window.UNBROKEN_ERROR);
if (err) { console.log("BOOT ERROR", err); await browser.close(); process.exit(1); }
console.log("booted in", Date.now() - started, "ms");
console.log("adapter", await page.evaluate(async () => { const a = await navigator.gpu.requestAdapter(); return a.info.vendor + " " + a.info.architecture; }));
if (js) console.log("js:", await page.evaluate(js));

const settle = () => page.evaluate(() => new Promise((res) => {
  let n = 0; const go = () => (++n >= 18 ? res() : requestAnimationFrame(go)); requestAnimationFrame(go);
}));
for (const t of times) {
  await page.evaluate((v) => window.UNBROKEN.seek(v), t);
  const a = Date.now();
  await settle();
  const ms = (Date.now() - a) / 14;
  const name = `${out}/t${String(t.toFixed(2)).padStart(6, "0")}.png`;
  await page.screenshot({ path: name });
  console.log(name, `~${ms.toFixed(1)} ms/frame`);
}
await browser.close();
