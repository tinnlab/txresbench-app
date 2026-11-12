import { luma } from '@luma.gl/core'
import { webgl2Adapter } from '@luma.gl/webgl'
import {
  verifyGroupReduceParity,
  deviceSupportsGroupReduce,
  verifyAggregateParity,
  verifyViolinParity,
  verifyDensifyParity,
  verifyBoxStatsParity,
  verifySignificanceParity,
} from '@txresbench/viz'

async function run() {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
  document.body.appendChild(canvas)
  let out: Record<string, unknown>
  try {
    const device = await luma.createDevice({ type: 'webgl', adapters: [webgl2Adapter], createCanvasContext: { canvas } })
    const supported = deviceSupportsGroupReduce(device)
    out = {
      supported,
      reduce: await verifyGroupReduceParity(device),
      aggregate: await verifyAggregateParity(device),
      violin: await verifyViolinParity(device),
      densify: await verifyDensifyParity(device),
      boxStats: await verifyBoxStatsParity(device),
      significance: await verifySignificanceParity(device),
    }
  } catch (e) { out = { ok: false, error: String((e as Error)?.message ?? e) } }
  ;(window as unknown as { __PARITY__: unknown }).__PARITY__ = out
  document.title = 'PARITY_DONE'
}
void run()
