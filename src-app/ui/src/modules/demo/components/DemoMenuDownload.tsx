import { MenubarItem } from '@txresbench/kit'
import { useAppMode } from '../useAppMode'
import { DEMO_HEADER_DOWNLOAD } from '../copy'

/**
 * DemoMenuDownload — the "Download the app" link inside the mobile menu
 * (ITEM-5; the header-link byte below 700 px — the header's ONE-row rule
 * wins, so the link yields into the menu exactly like the nav destinations
 * do, and the connection stays reachable at 390).
 *
 * Same no-flash rule as every demo piece: absent while the boot read is
 * pending, in desktop mode, and (like the header link) when a deployment
 * left `download_url` empty.
 */
export function DemoMenuDownload() {
  const { ready, isDemo, downloadUrl } = useAppMode()

  if (!ready || !isDemo || !downloadUrl) return null

  return (
    <MenubarItem
      data-testid="txr-demo-menu-download"
      render={
        <a href={downloadUrl} target="_blank" rel="noopener noreferrer" />
      }
    >
      {DEMO_HEADER_DOWNLOAD}
    </MenubarItem>
  )
}
