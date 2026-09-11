import { chromium } from "playwright";
const BASE = "https://web-production-986c56.up.railway.app";
const browser = await chromium.launch();

for (const path of ["/en", "/en/stats", "/en/council", "/en/agents", "/en/revenue"]) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(3000);
    const text = (await page.innerText("body")).replace(/\n{2,}/g, "\n");
    const body = text.split("\n").filter((l) => l.trim()).slice(6, 22).join(" | ");
    console.log(`\n===== ${path} =====`);
    console.log(body.slice(0, 520));
    if (errs.length) console.log("  PAGE ERRORS:", errs.slice(0, 2).join(" ; "));
  } catch (e) {
    console.log(`\n===== ${path} ===== FAILED: ${String(e).slice(0, 100)}`);
  }
  await page.close();
}
process.exit(0);
