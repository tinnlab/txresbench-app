import { createModule } from '@ziee/framework'
// Side-effect import: `AppLayout.store` self-registers via `registerLazyStore`
// AND sets the `@ziee/shell` AppLayout seam at module scope.
import '@/modules/layouts/app-layout/AppLayout.store'
import '@/modules/layouts/app-layout/types'

export default createModule({
  metadata: {
    name: 'layout',
    version: '1.0.0',
    description: 'Core layout and UI state management',
  },
  routes: [],
  stores: [],
  initialize: () => {
    console.log('Layout module initialized')
  },
})
