#!/usr/bin/env node
// novnc-shot.mjs — ITEM-5 (node qa-hardening): capture the virtual X display
// to a PNG by loading the noVNC page (served by websockify from run.sh) into
// headless chromium and screenshotting the RFB canvas — the canvas IS the live
// framebuffer of the Xvfb screen, so the pixels are exactly what x11vnc
// streams, not a re-render of the page DOM.
//
// No `import`/`xwd`/`ffmpeg` exists on this box; playwright chromium is the
// host tool the dev-desktop harness may rely on (the repo's gallery/e2e tiers
// already ship it). The capture is used by screenshot.sh and by TEST-QA-5.
//
// Usage:
//   node scripts/dev-desktop/novnc-shot.mjs --out shot.png [--url U] [--timeout 60]
import { chromium } from "playwright";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const outPath = argValue("--out", "");
const url = argValue("--url", "http://127.0.0.1:6080/vnc.html?autoconnect=1");
const timeoutMs = Number(argValue("--timeout", "90")) * 1000;

if (!outPath) {
  console.error("novnc-shot: --out FILE is required");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (process.env.NOVNC_SHOT_DEBUG) {
    page.on("console", (m) => console.error("novnc-shot console:", m.type(), m.text().slice(0, 200)));
    page.on("pageerror", (e) => console.error("novnc-shot pageerror:", e.message.slice(0, 300)));
    console.error("novnc-shot: url", url);
  }

  // Wait for the noVNC status line to report an established connection.
  const deadline = Date.now() + timeoutMs;
  let status = "";
  for (;;) {
    status = await page
      .locator("#noVNC_status")
      .textContent()
      .catch(() => "")
      .then((s) => s.trim());
    if (process.env.NOVNC_SHOT_DEBUG) console.error("novnc-shot: status:", JSON.stringify(status));
    if (/connected|failed|disconnected/i.test(status)) break;
    if (Date.now() > deadline) {
      console.error(`novnc-shot: noVNC status never resolved (last: "${status}")`);
      process.exit(1);
    }
    await page.waitForTimeout(500);
  }
  if (!/connected/i.test(status)) {
    console.error(`novnc-shot: noVNC is not connected (status: "${status}")`);
    process.exit(1);
  }

  // The RFB canvas carries the framebuffer; wait until it has real size.
  const canvas = page.locator("#noVNC_container canvas");
  await canvas.waitFor({ state: "visible", timeout: timeoutMs });
  for (;;) {
    const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
    if (size.w > 0 && size.h > 0) break;
    if (Date.now() > deadline) {
      console.error("novnc-shot: the RFB canvas never got a framebuffer size");
      process.exit(1);
    }
    await page.waitForTimeout(500);
  }

  // Render-settle: one extra frame after the last status change.
  await page.waitForTimeout(1500);

  // Sample the canvas pixels (downsampled) and report statistical proof the
  // screen is not blank; then save the screenshot.
  const stats = await canvas.evaluate((c) => {
    const ctx = c.getContext("2d");
    const { width: w, height: h } = c;
    const data = ctx.getImageData(0, 0, w, h).data;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
    const seen = new Set();
    let samples = 0;
    let lit = 0;
    let luminance = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const q = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        seen.add(q);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        luminance += lum;
        if (lum > 0.02) lit++;
        samples++;
      }
    }
    return {
      width: w,
      height: h,
      samples,
      distinctColors: seen.size,
      litFraction: lit / samples,
      meanLuminance: luminance / samples,
    };
  });

  await canvas.screenshot({ path: outPath });
  console.log(JSON.stringify({ png: outPath, noVncStatus: status, ...stats }));
  const blank =
    stats.distinctColors < 8 || stats.litFraction < 0.01;
  if (blank) {
    console.error(
      `novnc-shot: screen looks blank (${stats.distinctColors} distinct colors, ` +
        `${(stats.litFraction * 100).toFixed(1)}% lit) — nothing is rendering`,
    );
    process.exit(1);
  }
} finally {
  await browser.close();
}
