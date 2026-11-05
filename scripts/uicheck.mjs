// Exercises the live page as a visitor would: node scripts/uicheck.mjs outDir [baseUrl]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const out = process.argv[2];
const base = process.argv[3] ?? "http://127.0.0.1:5317/";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] });

async function visit(name, viewport, script) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const problems = [];
  const bytes = { total: 0, list: [] };
  page.on("pageerror", (e) => problems.push("PAGEERROR " + String(e).slice(0, 400)));
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !m.text().includes("powerPreference") && !m.text().includes("favicon")) problems.push(m.type() + ": " + m.text().slice(0, 300)); });
  page.on("response", async (r) => { try { const b = await r.body(); bytes.total += b.length; bytes.list.push(`${r.url().replace(base, "/").slice(0, 70)} ${(b.length / 1024).toFixed(0)}KB`); } catch {} });
  const t0 = Date.now();
  await page.goto(base);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}-loader.png` });
  await page.waitForFunction(() => window.UNBROKEN?.ready || window.UNBROKEN_ERROR, null, { timeout: 240000 });
  console.log(`[${name}] ready in ${Date.now() - t0} ms, error: ${await page.evaluate(() => window.UNBROKEN_ERROR ?? "none")}`);
  await script(page);
  console.log(`[${name}] requests: ${bytes.list.length}, bytes: ${(bytes.total / 1024).toFixed(0)} KB`);
  if (process.env.LIST) console.log(bytes.list.join("\n"));
  console.log(`[${name}] console problems: ${problems.length ? "\n  " + [...new Set(problems)].join("\n  ") : "none"}`);
  await ctx.close();
}

await visit("desktop", { width: 1600, height: 900 }, async (page) => {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/desktop-hud.png` });
  // Scrub with the real track, then keyboard.
  const track = page.locator(".track");
  const box = await track.boundingBox();
  await page.mouse.click(box.x + box.width * (24 / 56), box.y + box.height / 2);
  await page.waitForTimeout(1800);
  console.log("[desktop] t after scrub", await page.evaluate(() => UNBROKEN.state.t.toFixed(1)));
  await page.screenshot({ path: `${out}/desktop-ocean.png` });
  await page.keyboard.press("Space");
  const a = await page.evaluate(() => UNBROKEN.state.t);
  await page.waitForTimeout(400);
  const b = await page.evaluate(() => UNBROKEN.state.t);
  console.log("[desktop] paused holds time:", a === b);
  await page.keyboard.press("Space");
  await page.keyboard.press("i");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/desktop-index.png` });
  console.log("[desktop] index rows", await page.locator(".row").count());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  console.log("[desktop] index closed:", !(await page.locator(".index.open").count()));
  await page.keyboard.press("h");
  console.log("[desktop] UI hides:", await page.evaluate(() => document.body.classList.contains("ui-hidden")));
  await page.keyboard.press("h");
  await page.locator(".snd").click();
  await page.waitForTimeout(3500);
  console.log("[desktop] sound label:", await page.locator(".snd").textContent());
  console.log("[desktop] stats:", (await page.locator(".stats").innerText()).replace(/\n/g, " | "));
});

await visit("phone", { width: 390, height: 844 }, async (page) => {
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/phone-hud.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log("[phone] horizontal overflow:", overflow);
  await page.locator(".idx").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/phone-index.png` });
});
await browser.close();
