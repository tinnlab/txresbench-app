/**
 * Auto-discovery of project extensions. Eagerly imports every sibling module's
 * `project-extension/extension.tsx`, whose top-level
 * `projectExtensionRegistry.register(...)` side-effect runs at app boot — so a new
 * project sub-module appears in the nav / card / detail with ZERO project-core edits.
 * Bootstrapped by a side-effect import in `project/module.tsx`.
 */
import.meta.glob('../../*/project-extension/extension.tsx', { eager: true })
