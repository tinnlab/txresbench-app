import { useState, type JSX } from 'react'
import { cn } from '@/lib/utils'
import { reservedImageBox } from '@/components/common/reservedImageBox'

/**
 * Height-reserving wrapper for an already-permitted inline markdown image
 * (message-scroll-perf ITEM-3, DEC-3/DEC-4).
 *
 * A bare `<img>` has ~0 height until its bytes arrive, so under row
 * virtualization the row measures short, the image loads async, the row grows,
 * and the `measureElement` ResizeObserver fires — shifting scroll geometry and
 * jumping the viewport (symptom 3). Reserving space up front keeps the row
 * height stable from first paint:
 *
 * - intrinsic `width`+`height` present → an exact `aspect-ratio` box (zero
 *   post-load shift);
 * - dimensions unknown (the common `![](src)` case) → a stable `min-height`
 *   (matching the estimator's image term) that is released on `onLoad`, so the
 *   final layout equals the natural height and the only residual delta is
 *   absorbed by the virtualizer's above-viewport adjustment.
 *
 * SECURITY: this component performs NO origin/src validation — it is reached
 * ONLY from the `img` override's already-permitted (same-origin / root-relative)
 * branch. The exfil guard stays upstream and unchanged (DEC-3).
 *
 * A `<span>` (not a `<div>`) wrapper: markdown images render inside a `<p>`, and
 * a block-level `<div>` there is invalid nesting (a hydration/runtime-health
 * failure). The span is set to `inline-block` so it still reserves box height.
 */

export function ReservedImage(props: JSX.IntrinsicElements['img']) {
  const { className, width, height, onLoad, onError, style, ...rest } = props
  const [loaded, setLoaded] = useState(false)

  const { hasDims, style: wrapperStyle } = reservedImageBox(width, height, loaded)

  return (
    <span
      data-testid="reserved-image"
      data-loaded={loaded ? '' : undefined}
      className={cn('inline-block max-w-full align-middle', hasDims && 'w-full')}
      style={wrapperStyle}
    >
      <img
        {...rest}
        width={width}
        height={height}
        decoding="async"
        className={cn('max-w-full', hasDims ? 'h-full w-full object-contain' : '', className)}
        style={style}
        onLoad={e => {
          setLoaded(true)
          onLoad?.(e)
        }}
        onError={e => {
          // Release the reservation on a broken/404 image too — otherwise a
          // dimensionless image that errors keeps its 240px min-height forever,
          // leaving a permanent phantom gap in the message (FIX_ROUND-2).
          setLoaded(true)
          onError?.(e)
        }}
      />
    </span>
  )
}
