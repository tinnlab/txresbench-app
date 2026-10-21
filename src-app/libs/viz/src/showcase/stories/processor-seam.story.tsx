// processor-seam.story.tsx (ITEM-15, P2) — the ITEM-8/9 mock-processor fixture. A ~40-line
// `runMockProcessor` consumes ONLY the public `ProcessorPort` (importing just the seam is itself
// proof the boundary is clean): read the active gesture → `setPending("Segmenting…")` → synthesize a
// canned `makeLabelMaskFixture` result → `commitLabelMask` → clear pending. The committed mask is
// then a REAL editor mask (rendered via `LabelMaskView`, correctable). A "large result" knob scales
// the raster (256² → 1024²) as the perf harness. NO AI / onnxruntime / network (INV-3). Desktop + 390px.

import { useMemo, useRef, useState } from 'react'
import { createProcessorPort } from '../../adapter/createProcessorPort'
import { createAnnotateStore } from '../../viz-core/annotate/Annotate.store'
import { makeLabelMaskFixture } from '../../viz-core/spatial/labelMaskFixture'
import { LabelMaskView } from '../../viz-core/spatial/LabelMaskView'
import type { Gesture, LabelMaskResult, ProcessorPort } from '../../viz-core/annotate/processorPort'
import { WidthKnob } from './annotateStoryKit'
import { registerStory } from '../registry'

const IMAGE_SIZE = 4096

// ── the MOCK PROCESSOR (consumes ONLY the ProcessorPort) ────────────────────────────────────
async function runMockProcessor(port: ProcessorPort, opts: { size: number }): Promise<void> {
  const gesture = port.getActiveGesture()
  if (!gesture) return
  port.setPending({ message: 'Segmenting…', progress: 0.4, region: port.getViewState().bounds })
  // (a real processor would run a model here — the mock just sleeps, deterministic + AI-free)
  await new Promise(r => setTimeout(r, 350))
  const fx = makeLabelMaskFixture({
    seed: 7,
    width: opts.size,
    height: opts.size,
    labelCount: opts.size >= 512 ? 400 : 60,
  })
  port.commitLabelMask(
    {
      data: fx.labelMask,
      width: fx.width,
      height: fx.height,
      categoryForId: Array.from(fx.categoryForId),
      bounds: [0, 0, fx.width, fx.height],
    },
    { origin: 'mock-processor', groupId: 'segmentation' },
  )
  port.setPending(null)
}

interface CommittedMask {
  data: Uint16Array | Uint32Array
  width: number
  height: number
  categoryForId: Uint16Array
}

function ProcessorSeamStory() {
  const store = useMemo(() => createAnnotateStore(), [])
  const gestureRef = useRef<Gesture | null>(null)
  const [size, setSize] = useState(256)
  const [pending, setPending] = useState<string | null>(null)
  const [mask, setMask] = useState<CommittedMask | null>(null)

  // Mint ONE ProcessorPort for this cell (mirrors the per-instance handle idiom). The READ
  // getters read the seeded gesture + a static image/camera; the WRITE sinks paint this story.
  const port = useMemo<ProcessorPort>(
    () =>
      createProcessorPort({
        store,
        getImageRef: () => ({
          sourceId: 'processor-seam-fixture',
          width: IMAGE_SIZE,
          height: IMAGE_SIZE,
          levelCount: 3,
          channelCount: 3,
          pixelSize: [0.5, 0.5],
        }),
        getViewState: () => ({ center: [IMAGE_SIZE / 2, IMAGE_SIZE / 2], zoom: -3, bounds: [0, 0, IMAGE_SIZE, IMAGE_SIZE] }),
        getActiveGesture: () => gestureRef.current,
        onMask: (result: LabelMaskResult | null) => {
          if (!result) return setMask(null)
          setMask({
            data: result.data,
            width: result.width,
            height: result.height,
            categoryForId: Uint16Array.from(result.categoryForId ?? []),
          })
        },
        onPending: p => setPending(p?.message ?? null),
      }),
    [store],
  )

  const run = () => {
    // Seed a deterministic lasso gesture (a headless gallery can't drag), then drive the mock.
    gestureRef.current = { kind: 'lasso', ring: new Float64Array([100, 100, 900, 100, 900, 900, 100, 900]) }
    void runMockProcessor(port, { size })
  }
  const reset = () => {
    gestureRef.current = null
    setMask(null)
    setPending(null)
  }

  return (
    <div
      data-testid="viz-processor-seam"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <button type="button" data-testid="processor-seam-run" onClick={run} disabled={pending != null}>
          {pending != null ? pending : 'Run processor (gesture → mask)'}
        </button>
        <button type="button" data-testid="processor-seam-reset" onClick={reset}>
          Reset
        </button>
        <span style={{ opacity: 0.7 }}>Result size:</span>
        {[256, 1024].map(s => (
          <button
            key={s}
            type="button"
            data-testid={`processor-seam-size-${s}`}
            aria-pressed={size === s}
            onClick={() => setSize(s)}
            style={{ fontWeight: size === s ? 700 : 400 }}
          >
            {s}² {s >= 512 ? '(large)' : ''}
          </button>
        ))}
        <span style={{ opacity: 0.55 }}>
          The committed mask is a real editor mask — indistinguishable from hand-drawn (correctable / undoable).
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="processor-seam">
          <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
            {mask ? (
              <LabelMaskView
                labelMask={mask.data as never}
                width={mask.width}
                height={mask.height}
                categoryForId={mask.categoryForId}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgb(120,120,120)' }}>
                No mask yet — hit “Run processor”.
              </div>
            )}
            {pending != null && (
              <div
                data-testid="processor-seam-pending"
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  padding: '4px 10px',
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.75)',
                  color: 'white',
                  fontSize: 12,
                }}
              >
                {pending}
              </div>
            )}
          </div>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'processor-seam',
  category: 'Overlays',
  title: 'Processor seam — mock processor: gesture → “processing…” → committed editable mask',
  covers: 'processor-seam',
  Component: ProcessorSeamStory,
})
