import { createModule } from '@ziee/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { lazyWithPreload } from '@/utils/lazyWithPreload'

const HelpPage = lazyWithPreload(() =>
  import('./pages/HelpPage').then(m => ({ default: m.HelpPage })),
)

/**
 * txrhelp — the Help content screen of TxResBench: the `/help` page the
 * txrshell scaffold used to render (route handoff: the owner of the route
 * is this module; the shell's route block and its ShellPage use are
 * removed on the same branch). The page is driven by the typed content in
 * `content.ts` — the authored sections + the closed validator problem-code
 * entries — with a table of contents and anchor navigation; it renders in
 * light and dark and at phone width.
 *
 * The one cross-module seam: `helpPath(anchor)` through the barrel — the
 * intake module's validation problems list links each problem to its
 * matching code entry through the builder, never a URL literal. The module
 * owns no store, no slot and no event: the page is static content.
 */
export default createModule({
  metadata: {
    name: 'txrhelp',
    version: '1.0.0',
    description: 'TxResBench help — what the app does and how to use it.',
  },
  dependencies: ['router', 'txrshell'],
  stores: [],
  routes: [
    {
      path: '/help',
      element: HelpPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
