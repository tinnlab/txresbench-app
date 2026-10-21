import { createModule } from '@ziee/framework'
// Side-effect import: `ConfigClient.store` self-registers via `registerLazyStore`
// AND sets the `@ziee/shell` ThemeProvider seam at module scope, so it must be
// evaluated before <AppShell> first renders.
import '@/modules/config-client/ConfigClient.store'

export default createModule({
  metadata: {
    name: 'config-client',
    version: '1.0.0',
    description: 'Client-side configuration management',
  },
  routes: [],
  stores: [],
  initialize: () => {
    console.log('Config-client module initialized')
  },
})
