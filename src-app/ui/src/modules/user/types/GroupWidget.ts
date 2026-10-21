import type { Group } from '@/api-client/types'
import type { PermissionExpr } from '@/core/permissions'

/**
 * Props for group widget components.
 */
export interface GroupWidgetProps {
  group: Group
}

/**
 * Interface for widgets that appear in group list items.
 * Each module can register a widget to display resource assignments.
 *
 * Widgets are declared in module metadata and automatically registered
 * by the module system during initialization.
 *
 * @example
 * ```typescript
 * // In widgets/LLMProviderGroupWidget.tsx
 * export function LLMProviderGroupWidget({ group }: GroupWidgetProps) {
 *   return <div>...</div>
 * }
 *
 * // In module.tsx
 * const LLMProviderGroupWidgetComponent = lazyWithPreload(() => import('./widgets/LLMProviderGroupWidget').then(m => ({ default: m.LLMProviderGroupWidget })))
 *
 * export default createModule({
 *   slots: {
 *     userGroup: [
 *       { order: 10, component: LLMProviderGroupWidgetComponent }
 *     ]
 *   }
 * })
 * ```
 */
export interface GroupWidget {
  /**
   * Display order for multiple widgets.
   * Lower numbers appear first.
   * @example 10, 20, 30, ...
   */
  order: number

  /**
   * Component function that renders the widget.
   * Should be a lazy-loaded component created with lazyWithPreload.
   */
  component:
    | React.ComponentType<GroupWidgetProps>
    | (() => Promise<{ default: React.ComponentType<GroupWidgetProps> }>)

  /**
   * Optional permission gate. When set, the consumer (`GroupListItem`) drops
   * the widget for users who don't satisfy it — so a groups::read-only admin
   * without the resource's own read/assign perm never sees an (empty) widget
   * shell whose data endpoint would 403. Set it to the SAME perm the widget's
   * load endpoint requires (e.g. mcp → mcp_servers_admin::read, skills/
   * workflows → *::assign_to_groups, llm-providers → llm_providers::read).
   */
  permission?: PermissionExpr
}

/**
 * Register the 'userGroup' slot.
 * Other modules can register widgets for this slot to display in group list items.
 */
declare module '@ziee/framework/module-system/types' {
  interface Slots {
    userGroup: GroupWidget[]
  }
}
