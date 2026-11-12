import type { LayoutDefinition } from '@txresbench/framework/router'
import { BlankLayout as BlankLayoutComponent } from '@txresbench/shell'

/**
 * BlankLayout - Simple layout with no chrome
 *
 * This layout has no layout options, just renders children.
 */
export const BlankLayout: LayoutDefinition = {
  component: BlankLayoutComponent as any,
}

// Re-export component
export { BlankLayoutComponent }
