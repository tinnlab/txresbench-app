import { expect, test, type Page } from '@playwright/test'

/**
 * TXRINTERNAL — the qa-fixes4 ITEM-1 internal-text browser guard
 * (results-r3 R3-results-2, help-r3's location section, DEC-2): a web demo
 * of the app shows these screens to the public, so no rendered text node
 * may carry an absolute path, the `<app_data>` placeholder or an internal
 * tool name.
 *
 * The server's API-boundary sanitiser (`modules/err_sanitiser`, server
 * crate) is the first line — it makes reason/message fields plain before
 * they reach the browser. THIS spec is the UI-half proof, backend-free
 * and deliberately WORST-CASE: the gallery fixtures feed the leaked
 * wording (tool name + absolute path + the placeholder shape, EXACTLY the
 * report's screenshot text) straight into the real pages, as if the
 * server sanitiser were absent — and the pages' `safeText` guard (and the
 * removed path lines) must still keep every text node clean.
 *
 * Stories under test (one failed-run fixture per route family):
 *   · `txr-results-g-leak` — the RESULTS page (`/analysis/:id/results`)
 *     terminal-failed state (the report's defect page);
 *   · `txr-results-h-leak` — the one-method H frame (the method/compare
 *     pages of the report; also proves the aside's saved-in line is gone);
 *   · `txr-run-f-leak` — the RUNNING page's terminal snapshot (a failed
 *     row's detail line);
 *   · `txr-history-leak` — HISTORY (the failed row's reason line + the
 *     usage footer with no data dir).
 *
 * Every leg asserts:
 *   (a) NO text node matches the path pattern, the placeholder or the
 *       whole-word tool name (the report's own leak set);
 *   (b) the page DID render the guarded generic sentence (the guard is
 *       live, not the page simply being empty);
 *   (c) the run's own machine directory never renders (the `dir` fact’s
 *       removal — no "/txr-live" anywhere).
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-internal-text.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server pays the whole graph's transform —
// minutes on a loaded box. Same budget idiom as the other backend-free
// dev-only specs.
test.setTimeout(600_000)

/** Collect every leaking text node of the page's visible text (the
 *  `<script>`/`<style>` tags are skipped — their text is CSS/JS, not a
 *  drawn text node). The patterns are the UI guard's own (`safeText` +
 *  the plan's pinned set) — the same three the report searched for. */
function leakingTextNodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hits: string[] = []
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement
        if (parent !== null && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) return
        const text = node.textContent ?? ''
        if (text.trim().length === 0) return
        const path = /(^|\s)\/(data|home|usr|var|tmp|opt)\//i
        const placeholder = /<app_data>/i
        const tool = /\boras\b/i
        if (path.test(text) || placeholder.test(text) || tool.test(text)) {
          hits.push(text.trim())
        }
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return
      for (const child of Array.from(node.childNodes)) walk(child)
    }
    walk(document.body)
    return hits
  })
}

/** The guarded generic sentence (the safeText constant, rendered with the
 *  formatters' sentence-ending period on the reason lines). */
const GENERIC = 'This information is not available'

async function assertNoInternalText(page: Page): Promise<void> {
  // The positive control first: the guards DID fire.
  const body = await page.locator('body').innerText()
  expect(body).toContain(GENERIC)

  const hits = await leakingTextNodes(page)
  expect(hits, `leaking text nodes: ${JSON.stringify(hits)}`).toEqual([])
}

for (const surface of [
  'txr-results-g-leak',
  'txr-results-h-leak',
  'txr-run-f-leak',
  'txr-history-leak',
]) {
  test(`${surface} — no internal path, placeholder or tool name in any text node`, async ({ page }) => {
    await page.goto(`${GALLERY}${surface}`)
    const frame = page.locator('main, [data-testid="txr-results"], [data-testid="txr-history"]').first()
    await expect(frame).toBeVisible()
    // The store's load settles (the leak story's run/row renders).
    await expect(page.getByText(GENERIC).first()).toBeVisible()
    await assertNoInternalText(page)

    // The run's own machine directory never renders anywhere.
    await expect(page.locator('body')).not.toContainText('/txr-live')
    await expect(page.locator('body')).not.toContainText('/data/')
  })
}
