import { ImageOff } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Placeholder shown in place of a markdown image whose `src` was blocked by the
 * renderers' exfil guard (any non-same-origin URL, or a `data:` URI) — instead
 * of rendering nothing (which left a broken-looking stray period next to the
 * caption). An external http(s) image links out so the user can still open it
 * on an explicit click (Referer stripped, so no session leak, and nothing loads
 * until they act); a `data:` URI just shows the chip (browsers block navigating
 * to `data:` from a link).
 */
export function BlockedImage({ src, alt }: { src?: string; alt?: string }) {
  const label = alt?.trim() || 'external image'
  const isHttp = typeof src === 'string' && /^https?:\/\//i.test(src)

  const chip = (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted',
        'px-1.5 py-0.5 align-middle text-xs text-muted-foreground',
      )}
      data-testid="blocked-image"
    >
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  )

  if (isHttp) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer noopener"
        className="no-underline"
        title={`External image (click to open): ${src}`}
      >
        {chip}
      </a>
    )
  }
  return chip
}
