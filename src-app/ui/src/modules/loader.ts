import type { AppModule } from '@ziee/framework/module-system/types'
import { useModuleSystemStore } from '@ziee/framework'

/**
 * Auto-discovers and registers all modules from the modules directory.
 *
 * To add a new module:
 * 1. Create a new directory under src/modules/
 * 2. Create a module.tsx file that exports a default module
 * 3. The module will be automatically discovered and registered
 *
 * Example module structure:
 * src/modules/mymodule/module.tsx:
 *
 * export default createModule({
 *   metadata: { name: 'mymodule', version: '1.0.0' },
 *   routes: [...],
 *   stores: [...],
 *   dependencies: ['router', 'auth'],  // Optional: modules to load first
 * })
 */

/**
 * Phase 1: Meta-Framework - Dependency resolution
 * Sorts modules in dependency order using topological sort
 */
function resolveDependencies(modules: AppModule[]): AppModule[] {
  const graph = new Map<string, string[]>()
  const moduleMap = new Map<string, AppModule>()

  // Build dependency graph
  modules.forEach(module => {
    const deps = module.registerDependencies?.() || []
    graph.set(module.metadata.name, deps)
    moduleMap.set(module.metadata.name, module)
  })

  // Topological sort using DFS
  const sorted: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>() // For cycle detection

  function visit(name: string, path: string[] = []) {
    if (visited.has(name)) return

    // Detect circular dependencies
    if (visiting.has(name)) {
      const cycle = [...path, name].join(' -> ')
      throw new Error(`Circular dependency detected: ${cycle}`)
    }

    visiting.add(name)

    const deps = graph.get(name) || []
    deps.forEach(dep => {
      if (!moduleMap.has(dep)) {
        console.warn(
          `Module "${name}" depends on "${dep}" which is not loaded. Skipping dependency.`,
        )
        return
      }
      visit(dep, [...path, name])
    })

    visiting.delete(name)
    visited.add(name)
    sorted.push(name)
  }

  // Visit all modules
  graph.forEach((_, name) => visit(name))

  // Return modules in dependency order
  return sorted.map(name => moduleMap.get(name)!)
}

export function loadModules(): void {
  const { registerModule, initializeModules } = useModuleSystemStore.getState()

  // Auto-discover all module.tsx files in the modules directory
  const moduleFiles = import.meta.glob<{ default: AppModule }>(
    './**/module.tsx',
    { eager: true },
  )

  // Also discover core modules from components directory
  const coreModuleFiles = import.meta.glob<{ default: AppModule }>(
    '../components/**/module.tsx',
    { eager: true },
  )

  // Collect all modules
  const allModules: AppModule[] = []

  // Phase 2: Router module is now in modules/router, so it will be discovered automatically
  for (const [_path, moduleExports] of Object.entries(moduleFiles)) {
    const module = moduleExports.default
    if (module) {
      allModules.push(module)
    }
  }

  for (const [_path, moduleExports] of Object.entries(coreModuleFiles)) {
    const module = moduleExports.default
    if (module) {
      allModules.push(module)
    }
  }

  // Phase 1: Meta-Framework - Sort by dependencies
  const sortedModules = resolveDependencies(allModules)

  // Register modules in dependency order
  for (const module of sortedModules) {
    registerModule(module)

    // Phase 1: Meta-Framework - Call onModuleRegister hooks on all previously registered modules
    const { modules: registeredModules } = useModuleSystemStore.getState()
    registeredModules.forEach(registeredModule => {
      if (
        registeredModule.metadata.name !== module.metadata.name &&
        registeredModule.onModuleRegister
      ) {
        registeredModule.onModuleRegister(module)
      }
    })

    // Also call the new module's hook for all previously registered modules
    if (module.onModuleRegister) {
      registeredModules.forEach(registeredModule => {
        if (registeredModule.metadata.name !== module.metadata.name) {
          module.onModuleRegister!(registeredModule)
        }
      })
    }
  }

  // Initialize all modules after registration
  initializeModules()
}
