import { createModule } from '@ziee/framework'
import { ShellPage } from './pages/ShellPage'
import TxrLayout from './TxrLayout'

/**
 * txrshell — TxResBench's own shell: the top-nav layout (New analysis / Models /
 * History / Help, per the design boards) + the four routes it owns. The app
 * opens straight on `/` (New analysis). The analysis screens themselves are the
 * next build step; these routes render the shell page scaffold only.
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
  routes: [
    {
      path: '/',
      element: <ShellPage title="New analysis" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/models',
      element: <ShellPage title="Models" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/history',
      element: <ShellPage title="History" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/help',
      element: <ShellPage title="Help" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
