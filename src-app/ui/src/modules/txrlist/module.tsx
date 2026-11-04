import { createModule } from '@ziee/framework'

/**
 * txrlist — TxResBench's shared model/method selection list.
 *
 * The module is a component library + hooks + pure logic, not a screen: it
 * registers NO route, NO store, NO slot and NO component (DEC-2). The screens
 * E (`ui-run`), D and I (`ui-models`) route and own their chrome; this module
 * is pulled in by importing its barrel. The loader auto-discovers the module
 * (its glob over module.tsx files in the modules tree) and its dependency
 * list is empty — it needs no framework module before it.
 */
export default createModule({
  metadata: {
    name: 'txrlist',
    version: '1.0.0',
    description:
      'Shared model/method selection list for the TxResBench run screens (E, D, I)',
  },
  dependencies: [],
})
