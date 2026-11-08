import { createModule } from '@ziee/framework'
import TxrLayout from './TxrLayout'

/**
 * txrshell — TxResBench's own shell: the top-nav layout (New analysis / Models /
 * History / Help, per the design boards). The shell owns no screen route —
 * the `/` route is handed to the `txrintake` module (screen A Start — the
 * analysis-flow home the "New analysis" nav link opens); `/models` is handed
 * to the `txrmodels` module (screen J — the Your-models inventory, which owns
 * it now); `/history` is handed to the `txrhistory` module (screen K — the
 * run history, which owns it now); `/help` is handed to the `txrhelp` module
 * (the Help content page, which owns it now). Every one of the four shell
 * routes is a sibling module's; this module only provides the layout every
 * route uses.
 */

export const TxrLayoutDef = {
  id: 'txr-layout',
  component: TxrLayout,
}

export default createModule({
  metadata: {
    name: 'txrshell',
    version: '1.0.0',
    description: 'TxResBench shell — top navigation + the four app routes.',
  },
  dependencies: ['router'],
  routes: [],
})
