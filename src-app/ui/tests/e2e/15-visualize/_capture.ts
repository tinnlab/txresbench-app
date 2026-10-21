// SAVING A SCREENSHOT SO THAT IT ACTUALLY EXISTS.
//
// ── The defect this module is the fix for ─────────────────────────────────────────────────────
//
// Six captures in this suite were written as `test.info().attach(name, { body })`. Every one of
// them PASSED, and every one of them produced NO FILE: `attach({body})` keeps the bytes in the
// REPORT, and this project's Playwright config runs `list` + a watchdog reporter — no HTML and
// no JSON — so the bytes were discarded at the end of the run. Six green tests, proving nothing,
// and the only reason it was noticed is that somebody asked for the images rather than the tally.
//
// It is the worst shape of test failure because it is invisible by construction: nothing goes
// red, the suite gets greener, and the artifact silently does not exist. So the fix is not just
// "write it to a path" — it is write to a path AND ASSERT THE FILE IS THERE. A future reporter
// change, or a `path` that quietly resolves somewhere unwritable, then fails loudly instead of
// reproducing this exactly.

import { expect, type Locator, type TestInfo } from '@playwright/test'
import { statSync } from 'node:fs'

/**
 * Screenshot `target` into the test's own output directory, attach it, and PROVE it landed.
 *
 * Returns the absolute path, so a caller (or a human reading the run) can go straight to it.
 */
export async function capture(testInfo: TestInfo, target: Locator, name: string): Promise<string> {
  const path = testInfo.outputPath(name)
  await target.screenshot({ path })

  // THE ASSERTION THAT MAKES THIS MODULE WORTH HAVING. `existsSync` alone is not enough: a
  // truncated or zero-byte PNG is a file that exists and an image that does not, and it would
  // read as success on every check that only asks whether the path is there.
  const size = statSync(path).size
  expect(size, `the capture "${name}" wrote no bytes to ${path}`).toBeGreaterThan(0)

  // Attached BY PATH rather than by body, so the reporter records a reference to the file that
  // exists rather than a copy that only lives as long as the reporter does.
  await testInfo.attach(name, { path, contentType: 'image/png' })
  return path
}
