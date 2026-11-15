import { useAppMode } from '../useAppMode'
import { DEMO_HEADER_DOWNLOAD } from '../copy'

/**
 * DemoHeaderDownload — the header's "Download the app" link (ITEM-5, the
 * audit table's "(all) header" row: "add 'Download the app' link",
 * visible in demo mode only).
 *
 * Same no-flash rule as every demo piece: absent while the boot read is
 * pending and in desktop mode. The link points at the configured download
 * URL in a new tab (the kit's `rel` gives the `noopener noreferrer` pair);
 * a deployment that left `download_url` empty shows no link — the notice
 * bar's own primary action is hidden the same way.
 */
export function DemoHeaderDownload() {
  const { ready, isDemo, downloadUrl } = useAppMode()

  if (!ready || !isDemo || !downloadUrl) return null

  return (
    <a
      className="txr-demo-header-download"
      data-testid="txr-demo-header-download"
      href={downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      {DEMO_HEADER_DOWNLOAD}
    </a>
  )
}
