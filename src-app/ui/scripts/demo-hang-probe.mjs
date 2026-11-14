// One-off probe (NOT committed): open several gallery URLs and report settle time.
import { chromium } from '@playwright/test'
const browser = await chromium.launch()
for (const url of [
  '/gallery.html?surface=txr-shell-route-start',
  '/gallery.html?surface=txr-shell-route-start&demo=1',
  '/gallery.html',
]) {
  const page = await browser.newPage()
  const t0 = Date.now()
  page.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 160)) })
  const r = await page.goto('http://localhost:19472' + url, { waitUntil: 'domcontentloaded', timeout: 150000 }).catch(e => null)
  console.log(url, '->', r?.status(), ((Date.now() - t0) / 1000).toFixed(1) + 's')
  await page.waitForTimeout(5000)
  const state = await page.evaluate(() => ({
    root: document.getElementById('root')?.children.length,
    notice: !!document.querySelector('[data-testid="txr-demo-notice"]'),
  })).catch(() => null)
  console.log('   state', JSON.stringify(state))
  await page.close()
}
await browser.close()
process.exit(0)
