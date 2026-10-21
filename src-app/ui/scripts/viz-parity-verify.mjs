// Drive src/gpu-parity.html under headless software-WebGL and read back window.__PARITY__.
// Every GPU kernel exports verifyXParity(device) that reproduces its CPU oracle; this asserts
// they all agree in a real WebGL2 context (swiftshader). Exit non-zero on any parity failure.
import { chromium } from 'playwright-core'

const URL = 'http://localhost:1421/gpu-parity.html'
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push('PAGEERR: ' + e.message))
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForFunction(() => document.title === 'PARITY_DONE', { timeout: 60000 })
const out = await page.evaluate(() => window.__PARITY__)
await browser.close()

console.log(JSON.stringify(out, null, 2))
if (errors.length) console.log('CONSOLE ERRORS:', errors.slice(0, 5))

// Walk the report: any {ok:false} or maxError over the reported tolerance is a fail. Each
// verifyXParity returns an object with an `ok` boolean (and diagnostics); trust that flag.
const fails = []
function walk(key, v) {
  if (v && typeof v === 'object') {
    if ('ok' in v && v.ok === false) fails.push(`${key}: ${JSON.stringify(v)}`)
    else for (const [k, val] of Object.entries(v)) if (typeof val === 'object') walk(`${key}.${k}`, val)
  }
}
if (out && out.ok === false) fails.push(`top: ${JSON.stringify(out)}`)
else walk('parity', out)
if (fails.length) { console.log('\nPARITY FAILURES:\n' + fails.join('\n')); process.exit(1) }
console.log('\nRESULT: all parity checks OK')
process.exit(0)
