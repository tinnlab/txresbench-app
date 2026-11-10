import { useEffect } from 'react'

/**
 * The per-route document titles (help-r2.md R2-G1): every route used to
 * leave `document.title` at the static "TxResBench" of `index.html`, so
 * browser tabs, history entries and bookmarks could not tell Help from
 * Results from History. One source renames all of them:
 *
 *   useDocumentTitle('Help')      → "Help — TxResBench"
 *   useDocumentTitle('History')   → "History — TxResBench"
 *   useDocumentTitle('Predictions for 94 patients') → …
 *
 * The subtitle is ALWAYS the page's own words — the same byte its `<h1>`
 * renders — never an invented label, so the tab and the page cannot
 * disagree. `R2-G1`'s example for the results screen is "Results —
 * <run name>", but a run record carries no name field (the F/G headings
 * derive from what the provider records: "Predictions for N patients",
 * "Running N methods"); the title uses those, matching the report's own
 * "Predictions - TxResBench" example and the page.
 *
 * The hook restores the PREVIOUS title on unmount, so two routes drawn in
 * sequence can not fight each other: the one leaving restores, then the one
 * arriving sets — the tab always ends with the page that is on screen (the
 * same stacked behaviour the SDK's lazy route boundary already has).
 */
export const APP_TITLE = 'TxResBench'

/** The separator the boards use (an em dash with spaces), never a hyphen. */
const TITLE_SEPARATOR = ' \u2014 '

/** The full title for one page; an empty subtitle falls back to the app name. */
export function documentTitleFor(subtitle: string): string {
  const trimmed = subtitle.trim()
  return trimmed.length === 0 ? APP_TITLE : `${trimmed}${TITLE_SEPARATOR}${APP_TITLE}`
}

/** Set `document.title` to "«subtitle» — TxResBench" for the mounted page,
 *  restoring the previous title on unmount. */
export function useDocumentTitle(subtitle: string): void {
  useEffect(() => {
    const previous = document.title
    document.title = documentTitleFor(subtitle)
    return () => {
      document.title = previous
    }
  }, [subtitle])
}
