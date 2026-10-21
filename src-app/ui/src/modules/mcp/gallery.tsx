import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import { useMcpConnectStore } from '@/modules/mcp/stores/McpConnect.store'

/**
 * Gallery seed for the "AI Assistant Access" connect page (PLAN.md
 * ITEM-19). The default (not-yet-paired) render is reachable via the
 * shared crawl base, but the post-connect (code issued) and error states
 * are transient store state reached only after a successful/failed
 * `startPairing()` call — seeded here so they're covered by the
 * runtime-health + visual-regression gates (incl. the 390px mobile
 * viewport, applied automatically across the shared theme/viewport
 * matrix for every seeded surface).
 */

const AiAccessPage = lazy(() => import('@/modules/mcp/AiAccessPage'))

type ConnectState = ReturnType<typeof useMcpConnectStore.getState>

const DEFAULTS = {
  code: null as string | null,
  mcpUrl: null as string | null,
  starting: false,
  error: null as string | null,
}

function seed(partial: Partial<ConnectState>) {
  return () => {
    useMcpConnectStore.setState({ ...DEFAULTS, ...partial } as ConnectState)
  }
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'ai-access-disconnected',
      title: 'AI Assistant Access — not connected',
      note: 'Default state before pairing is started.',
      path: '/settings/ai-access',
      initialPath: '/settings/ai-access',
      component: AiAccessPage,
      setup: seed({}),
    },
    {
      slug: 'ai-access-paired',
      title: 'AI Assistant Access — pairing code issued',
      note: 'A one-time code + MCP server URL minted, ready to copy (or deep-link) into ziee.',
      path: '/settings/ai-access',
      initialPath: '/settings/ai-access',
      component: AiAccessPage,
      setup: seed({
        code: 'AB12-CD34',
        mcpUrl: 'https://cyto.example.com/api/mcp',
      }),
    },
    {
      slug: 'ai-access-error',
      title: 'AI Assistant Access — pairing failed',
      note: '`startPairing` failed; the error banner replaces the connect button.',
      path: '/settings/ai-access',
      initialPath: '/settings/ai-access',
      component: AiAccessPage,
      setup: seed({ error: 'Failed to start pairing' }),
    },
  ],
}
