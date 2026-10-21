import { test, expect } from '@playwright/test'
import { trackErrors } from './_helpers'

// TEST-70 (oracle-backed GPU↔CPU numeric parity): the real test-integrity check for the
// visualization GPU kernels. Each viz-core GPU kernel exports a `verifyXParity(device)` that,
// on a live device, runs the GPU shader AND an INDEPENDENT in-browser CPU oracle over the same
// fixture and returns the max divergence between them plus an `ok` flag. The node "parity"
// tests only exercise the CPU path (CPU-vs-CPU) — they can never catch a wrong shader. This
// spec drives `src/gpu-parity.html` (which runs every `verifyXParity` in a REAL WebGL2 context
// under swiftshader, writing the report to `window.__PARITY__` and setting the title to
// `PARITY_DONE`) and fails the suite if ANY kernel's GPU output diverges from its CPU oracle
// beyond the kernel's own reported tolerance. Because it asserts each kernel's `ok === true`
// AND independently re-checks each reported error against its reported tolerance, a wrong GPU
// shader (which pushes maxError past tolerance → ok:false) FAILS this test — it is NOT a smoke
// test.

interface ParityKernel {
  readonly ok: boolean
  readonly [k: string]: unknown
}

interface ParityReport {
  readonly supported?: boolean
  readonly ok?: boolean
  readonly error?: string
  readonly reduce?: ParityKernel
  readonly aggregate?: ParityKernel
  readonly violin?: ParityKernel
  readonly densify?: ParityKernel
  readonly boxStats?: ParityKernel
  readonly significance?: ParityKernel
  readonly [k: string]: unknown
}

// Each kernel's error-field → tolerance-field pairing (mirrors the ParityReport interfaces in
// viz-core: groupReduce.ts, aggregateGpu.ts, densifyGpu.ts, groupStatsGpu.ts). We re-derive the
// pass condition from the raw numbers rather than trusting the `ok` flag alone, so a kernel that
// (hypothetically) reported ok:true with an out-of-tolerance error would still fail here.
const KERNEL_CHECKS: ReadonlyArray<{
  readonly key: 'reduce' | 'aggregate' | 'violin' | 'densify' | 'boxStats' | 'significance'
  // [error field, tolerance field] pairs — every one must satisfy error <= tolerance.
  readonly bounds: ReadonlyArray<readonly [string, string]>
}> = [
  { key: 'reduce', bounds: [['maxAbsError', 'tolerance']] },
  { key: 'aggregate', bounds: [['maxAbsError', 'tolerance']] },
  { key: 'densify', bounds: [['maxAbsError', 'tolerance']] },
  {
    key: 'violin',
    bounds: [
      ['maxShapeError', 'shapeTolerance'],
      ['maxPeakTickOffset', 'peakTickTolerance'],
    ],
  },
  {
    key: 'boxStats',
    bounds: [
      ['maxQuartileError', 'quartileTolerance'],
      ['maxMeanSdError', 'meanSdTolerance'],
    ],
  },
  {
    key: 'significance',
    bounds: [
      ['maxURelError', 'uTolerance'],
      ['maxPError', 'pTolerance'],
    ],
  },
]

test('TEST-70 GPU kernels match their CPU parity oracle in a real WebGL2 context', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const bag = trackErrors(page)

  await page.goto('/gpu-parity.html', { waitUntil: 'networkidle' })

  // The harness sets document.title once every verifyXParity has resolved (or it caught a
  // top-level error). Wait on that rather than a fixed delay.
  await page.waitForFunction(() => document.title === 'PARITY_DONE', undefined, {
    timeout: 90_000,
  })

  const report = (await page.evaluate(
    () => (window as unknown as { __PARITY__: unknown }).__PARITY__,
  )) as ParityReport

  // A top-level catch in the harness (device creation threw, etc.) surfaces as {ok:false,error}.
  expect(
    report,
    'window.__PARITY__ should be populated by the parity harness',
  ).toBeTruthy()
  expect(
    report.ok,
    `parity harness threw before running kernels: ${report.error ?? '(no message)'}`,
  ).not.toBe(false)

  // swiftshader MUST provide WebGL2 here (the blessed viz harness). If the device genuinely
  // can't run the GPU path we FAIL loudly — a skip would silently drop the only real coverage.
  expect(
    report.supported,
    'WebGL2/GPU group-reduce must be supported under swiftshader — a false here means the ' +
      'GPU parity path never ran (the CPU-fallback would make this a no-op smoke test)',
  ).toBe(true)

  // Per-kernel: the harness must have produced a report, its `ok` flag must be true, and every
  // reported error must independently be within its reported tolerance.
  for (const { key, bounds } of KERNEL_CHECKS) {
    const kernel = report[key] as ParityKernel | undefined
    expect(kernel, `parity report is missing the "${key}" kernel`).toBeTruthy()

    for (const [errField, tolField] of bounds) {
      const err = kernel![errField]
      const tol = kernel![tolField]
      expect(
        typeof err === 'number' && Number.isFinite(err),
        `${key}.${errField} should be a finite number, got ${JSON.stringify(err)}`,
      ).toBe(true)
      expect(
        typeof tol === 'number' && Number.isFinite(tol),
        `${key}.${tolField} should be a finite number, got ${JSON.stringify(tol)}`,
      ).toBe(true)
      expect(
        err as number,
        `GPU kernel "${key}" diverged from its CPU oracle: ${errField}=${err} exceeds ` +
          `${tolField}=${tol} (${JSON.stringify(kernel)})`,
      ).toBeLessThanOrEqual(tol as number)
    }

    expect(
      kernel!.ok,
      `GPU kernel "${key}" reported a parity FAILURE (ok:false): ${JSON.stringify(kernel)}`,
    ).toBe(true)
  }

  // The parity run itself must be clean — a shader-compile / WebGL / uncaught error during the
  // run would corrupt the oracle comparison and must fail the test.
  expect(
    bag.errors,
    `no console/page errors during the parity run: ${bag.errors.slice(0, 5).join(' | ')}`,
  ).toHaveLength(0)
})
