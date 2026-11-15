import { Link } from 'react-router-dom'
import { Button } from '@txresbench/kit'
import { FiInfo, FiX } from 'react-icons/fi'
import { useAppMode } from '../useAppMode'
import {
  DEMO_BANNER_CLOSE,
  DEMO_BANNER_PRIMARY_ACTION,
  DEMO_BANNER_SECONDARY_ACTION,
  DEMO_BANNER_TEXT,
} from '../copy'

/**
 * DemoNoticeBar — the demo announcement directly under the header
 * (ITEM-5, the spec's requirement 2 + the audit table's "(all) header" row).
 *
 * Renders ONLY in demo mode (and only after the boot read settled — the
 * no-flash rule: while the mode is unknown the bar is absent, so a demo boot
 * never shows it, then hides it; a desktop boot never flashes it).
 * "Directly under the header" is structural: the shell renders the bar as a
 * flex child BETWEEN the header and the routed area, and the bar is
 * `flex: none`, so the routed area shrinks by the bar's height and the two
 * never overlap — the layout leaves its height (the plan's byte).
 *
 * The bar's closes are remembered per browser session (`sessionStorage`
 * through the DemoMode store — "closing hides it for the browser session and
 * it returns in a new session").
 *
 * The copy is the plan's exact text; the primary action is the configured
 * download URL (omitted when a deployment left it empty — the banner's text
 * and the secondary link still stand); the secondary link lands on the
 * Help page's `#demo` section (ITEM-7 owns that content).
 */
export function DemoNoticeBar() {
  const { ready, isDemo, downloadUrl, noticeDismissed, dismissNotice } = useAppMode()

  if (!ready || !isDemo || noticeDismissed) return null

  return (
    <section
      className="txr-demo-notice"
      role="region"
      aria-label="Demo notice"
      data-testid="txr-demo-notice"
    >
      <FiInfo className="txr-demo-notice-icon" aria-hidden />
      <p className="txr-demo-notice-text">{DEMO_BANNER_TEXT}</p>
      <div className="txr-demo-notice-actions">
        {downloadUrl ? (
          <Button
            className="txr-demo-notice-download"
            data-testid="txr-demo-notice-download"
            href={downloadUrl}
            target="_blank"
          >
            {DEMO_BANNER_PRIMARY_ACTION}
          </Button>
        ) : null}
        <Link
          className="txr-demo-notice-help"
          to="/help#demo"
          data-testid="txr-demo-notice-help"
        >
          {DEMO_BANNER_SECONDARY_ACTION}
        </Link>
        <Button
          className="txr-demo-notice-close"
          data-testid="txr-demo-notice-close"
          variant="ghost"
          aria-label={DEMO_BANNER_CLOSE}
          tooltip={DEMO_BANNER_CLOSE}
          icon={<FiX aria-hidden />}
          onClick={dismissNotice}
        />
      </div>
    </section>
  )
}
