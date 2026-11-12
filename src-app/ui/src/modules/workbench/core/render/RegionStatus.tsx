// RegionStatus (shared) — the ONE failure/lifecycle surface a fanned declarative region
// renders when its declared data is not `ready` (declarative-rendering-hardening Slice 2,
// F3 / ITEM-4).
//
// Before this, `viewData.ts` swallowed a failed fetch into a `console.error` + `undefined`
// and `DeclarativeRegion` "rendered structure" — so a backend-down / permission-denied
// region was PIXEL-IDENTICAL to a project that simply hasn't produced anything yet, and to
// a fetch still in flight. Three completely different situations, one blank form.
//
// Each gets its own surface, built on the kit primitives (so tone, contrast, dark mode and
// a11y come from the design system):
//
//   loading    → `Skeleton` bars  — the SHAPE that is coming, not a bare spinner.
//   error      → kit `ErrorState` — names the resource, a HUMAN one-liner, a Try-again
//                                   action, and the raw resolver text behind a Details
//                                   disclosure (never inline — the kit's stated contract).
//   empty      → kit `Empty`      — "no data yet", explicitly not a fault.
//   unreadable → kit `ErrorState` — the sources ARE there and none of them could be read.
//                                   Same shape as `error` (it is a fault, and a re-read is
//                                   a real move) with its OWN sentence: the `empty` copy
//                                   tells the user to go and produce an input that already
//                                   exists, which is the one thing that would not help.
//   ready      → `null`           — the region paints its widgets alone.
//
// PLACEMENT (FIX-1.2): it renders ABOVE the region's widgets, never INSTEAD of them. The
// first cut replaced the whole fanned form, which deadlocked every single-region processor:
// `qc.yaml`'s only region is `right`, that region holds the RUN button, and the datatype it
// declares (`report/qc`) is produced BY that run — so a fresh project showed "No data yet.
// Run the analysis that produces its input" with the Run button hidden behind the very
// message telling the user to run it. Rendering above also means a PARTIAL failure still
// shows the slices that did resolve.
//
// Presentational + pure (status/message/onRetry in, markup out), so it is directly
// unit-testable without a store, a host, or a network.

import * as React from 'react'
import { Empty, ErrorState, Skeleton } from '@txresbench/kit'
import type { DataStatus } from '@/modules/workbench/core/runtime/dataStatus'

export interface RegionStatusProps {
  status: DataStatus
  /** The resolver's RAW message — shown behind the kit `ErrorState`'s Details disclosure,
   *  never as the human-facing description (the kit's contract). */
  error?: string
  /**
   * The SERVER's own user-facing sentence for this failure, shown INLINE as the description
   * (ITEM-41 / INV-9).
   *
   * The kit puts `details` behind a "Details" disclosure on purpose — raw error text is not a
   * description. But a refusal the server wrote FOR A PERSON carries the one fact the reader
   * needs (which source went missing, and that deleting is not the fix), and behind a
   * disclosure that fact reached nobody: the same bargain the listing half already refuses
   * ("not in a `title` a pointer has to find and a touch device never will").
   *
   * So when a hint is present it REPLACES the generic description, and the wrapped technical
   * string stays in `details` where it belongs. Absent ⇒ the generic sentence, unchanged.
   */
  hint?: string
  /** The owning view id — used to build stable, per-view test ids. */
  viewId: string
  /** The view's human title, so the error NAMES the resource that failed rather than
   *  saying "something". Falls back to a generic noun. */
  resource?: string
  /** Re-run the resolver (the error state's Try-again). Omitted ⇒ no retry is offered. */
  onRetry?: () => void
}

// The `region` + `announce` props are GONE with the region fan (INV-3). They existed only
// because one view mounted as up to three components sharing a `view_id`: `region`
// disambiguated the per-region loading skeleton's test id, and `announce` elected exactly
// one of them to speak, so a single shared fetch was not announced three times. One view
// is now one pane, so the status is single by construction — carrying an `announce` gate
// would leave a prop whose only reachable value is `true`, and an id suffix that never
// disambiguates anything.

/** Copy is centralized here (not inlined per branch) so a future i18n pass has one target.
 *  Straight quotes only — a curly apostrophe breaks straight-quote test assertions and
 *  diverges from the kit's own copy. */
export const REGION_STATUS_COPY = {
  errorResourceFallback: "this view's data",
  errorDescription:
    'The server may be unavailable, or you may not have access to it. Nothing has been changed.',
  retry: 'Try again',
  emptyTitle: 'No data yet',
  emptyDescription:
    'Nothing has been produced for this view yet. Run the analysis that produces its input, then come back.',
  loadingLabel: 'Loading data',
  // Deliberately says the inputs EXIST — that is the entire difference from `emptyDescription`,
  // and getting it wrong sends the user off to re-produce data they already have.
  unreadableDescription:
    'The inputs for this view are here, but none of them could be read. They may still be uploading, or stored somewhere this session cannot reach.',
  // Says the fault is in THIS BUILD, not in the data or the server — which is the entire
  // difference from `errorDescription` ("the server may be unavailable"), and getting it wrong
  // sends the user to check a backend that is working. Deliberately offers no retry: the
  // condition is deterministic and retrying cannot clear it.
  unsupportedTitle: 'This view needs a newer version of the app',
  unsupportedDescription:
    'Part of this view asks for data in a way this version of the app does not understand, so that part is empty. Everything else on this view still works. Updating the app should resolve it.',
  // The MIXED state. Deliberately does NOT say "everything else still works" — that is the
  // false sentence the single-winner fold used to show over a live backend outage. It names
  // both causes and KEEPS the retry, because one half is retryable; the other half is stated
  // so the user is not left retrying a build mismatch forever.
  degradedDescription:
    'Two things went wrong at once: part of this view failed to load and can be retried, and another part asks for data this version of the app does not understand — that part needs an update, and retrying will not clear it.',
  // Incremental landing (ITEM-1): rows ARE on screen and more are still arriving. A non-blocking
  // strip, NOT a skeleton — the whole point of progressive paint is that the already-landed rows
  // stay visible while the rest fills in, so this renders ABOVE the widgets (like empty/error) and
  // never replaces them (only `loading` does that).
  partialLabel: 'Loading more data',
} as const

export function RegionStatus({
  status,
  error,
  hint,
  viewId,
  resource,
  onRetry,
}: RegionStatusProps): React.ReactElement | null {
  switch (status) {
    case 'ready':
      return null

    case 'loading':
      return (
        <div
          className="flex w-full flex-col gap-2"
          data-testid={`declarative-status-loading-${viewId}`}
          role="status"
        >
          {/* The live region needs TEXT to announce; the skeleton bars are decorative. */}
          <span className="sr-only">{REGION_STATUS_COPY.loadingLabel}</span>
          <Skeleton className="h-4 w-1/3" aria-hidden />
          <Skeleton className="h-8 w-full" aria-hidden />
        </div>
      )

    case 'error':
      return (
        <ErrorState
          data-testid={`declarative-status-error-${viewId}`}
          resource={resource && resource.trim() !== '' ? resource : REGION_STATUS_COPY.errorResourceFallback}
          description={REGION_STATUS_COPY.errorDescription}
          // Raw resolver text (slice key, datatype id, exception message) is TECHNICAL
          // detail: it belongs behind the disclosure, not in the user-facing line.
          details={error && error.trim() !== '' ? error : undefined}
          onRetry={onRetry}
          retryLabel={REGION_STATUS_COPY.retry}
          className="w-full"
        />
      )

    case 'unreadable':
      // The sources were found and none of them yielded anything. A fault, so it wears the
      // error surface — but its own sentence, and its own test id, because the whole reason
      // this value exists is that `empty`'s advice ("run the analysis that produces its
      // input") is wrong here and `error`'s ("the server may be unavailable") is vaguer than
      // what is actually known.
      return (
        <ErrorState
          data-testid={`declarative-status-unreadable-${viewId}`}
          resource={resource && resource.trim() !== '' ? resource : REGION_STATUS_COPY.errorResourceFallback}
          description={hint && hint.trim() !== '' ? hint : REGION_STATUS_COPY.unreadableDescription}
          details={error && error.trim() !== '' ? error : undefined}
          onRetry={onRetry}
          retryLabel={REGION_STATUS_COPY.retry}
          className="w-full"
        />
      )

    case 'degraded':
      // Rendered as the ERROR surface, not as `Empty`, and that is the whole point: the
      // retryable half must keep its Try-again. The description names the unsupported half too,
      // so the retry is not offered under a promise it can fix everything.
      return (
        <ErrorState
          data-testid={`declarative-status-degraded-${viewId}`}
          resource={resource && resource.trim() !== '' ? resource : REGION_STATUS_COPY.errorResourceFallback}
          description={REGION_STATUS_COPY.degradedDescription}
          // Both slices' sentences, behind the same disclosure every other fault uses.
          details={error && error.trim() !== '' ? error : undefined}
          onRetry={onRetry}
          retryLabel={REGION_STATUS_COPY.retry}
          className="w-full"
        />
      )

    case 'unsupported':
      // The app is older than the spec it was handed (or the spec names a source that does
      // not exist). Rendered as `Empty`, NOT as `ErrorState`, and the choice is deliberate:
      // an error surface with a Try-again button invites an action that cannot possibly help,
      // and this is not a fault of the user's data or of the server. The widgets still render
      // below — only `loading` suppresses them — so the view keeps working and simply says
      // which part of it it cannot fill.
      return (
        <Empty
          data-testid={`declarative-status-unsupported-${viewId}`}
          title={REGION_STATUS_COPY.unsupportedTitle}
          description={
            error && error.trim() !== ''
              ? `${REGION_STATUS_COPY.unsupportedDescription} (${error})`
              : REGION_STATUS_COPY.unsupportedDescription
          }
          className="w-full"
        />
      )

    case 'partial':
      // Data is arriving incrementally (ITEM-1 / DEC-2). A slim, non-blocking "loading more" strip
      // rendered ABOVE the widgets — the widgets stay mounted and paint the rows that HAVE landed
      // (unlike `loading`, which is "nothing to paint yet" and unmounts the form). A live region so
      // the arrival is announced; a pulsing bar as the visual affordance.
      return (
        <div
          className="flex w-full items-center gap-2 text-sm text-muted-foreground"
          data-testid={`declarative-status-partial-${viewId}`}
          role="status"
        >
          <span
            className="h-1.5 w-16 shrink-0 animate-pulse rounded-full bg-muted-foreground/40"
            aria-hidden
          />
          <span>{REGION_STATUS_COPY.partialLabel}</span>
        </div>
      )

    case 'empty':
      // A genuine no-data result. Deliberately NOT an error tone: it is the expected state
      // of an untouched project. The region's own widgets (e.g. a Run button) render below.
      return (
        <Empty
          data-testid={`declarative-status-empty-${viewId}`}
          title={REGION_STATUS_COPY.emptyTitle}
          description={REGION_STATUS_COPY.emptyDescription}
          className="w-full"
        />
      )

    default: {
      // Exhaustiveness: a new `DataStatus` member must not silently fall through to a wrong
      // surface — it fails to COMPILE here. At RUNTIME (an out-of-band value deserialized
      // from persisted state) it must render NOTHING, never the raw status string.
      const exhaustive: never = status
      void exhaustive
      return null
    }
  }
}
