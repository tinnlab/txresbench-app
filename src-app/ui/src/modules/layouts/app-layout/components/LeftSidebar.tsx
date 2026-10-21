import { useNavigate, useLocation } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import { Menu, Separator } from '@ziee/kit'
import type { MenuItem } from '@ziee/kit'
import { useWindowMinSize } from '@ziee/shell'
import { SidebarHeaderSpacer } from '@/modules/layouts/app-layout/components/SidebarHeaderSpacer'
import { ModuleSystem } from '@ziee/framework/stores'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout.store'
import { Auth } from '@/modules/auth/Auth.store'
import { LazyComponentRenderer } from '@ziee/shell'
import { evaluatePermission } from '@/core/permissions'
import type {
  SidebarNavItem,
  SidebarToolItem,
  SidebarActionItem,
} from '@/modules/layouts/app-layout/types'

/**
 * Split a group's active state into the EXACT current page vs. a broader
 * ANCESTOR section. `exact` is the item whose `path` equals the pathname (the
 * strong selected pill); `ancestor` is the most-specific item whose `path` is a
 * proper prefix (a subtle "you're in this section" treatment, e.g.
 * `/settings/profile` softly marks "Settings", and a project conversation softly
 * marks "Projects" while the Recent-chats list owns the strong current mark).
 * Never returns both — an exact match wins outright.
 */
function selectionForGroup(
  pathname: string,
  items: { id: string; path: string }[],
): { exact?: string; ancestor?: string } {
  let exact: string | undefined
  let ancestor: { id: string; pathLen: number } | undefined
  for (const it of items) {
    if (pathname === it.path) {
      exact = it.id
    } else if (pathname.startsWith(it.path + '/')) {
      // A broader section you're within (e.g. "Projects" while viewing a project
      // conversation at /projects/:id/chat/:id). Keep the most-specific one.
      if (!ancestor || it.path.length > ancestor.pathLen) {
        ancestor = { id: it.id, pathLen: it.path.length }
      }
    }
  }
  // Only the EXACT current page gets the strong selected pill. When the page is a
  // sub-route (a conversation the Recent-chats list already marks current, a
  // settings subpage, …) the section item is a subtle ancestor, not a second
  // "current". Exact wins outright — no ancestor is surfaced alongside it.
  return { exact, ancestor: exact ? undefined : ancestor?.id }
}

/**
 * Optional shape that lets an outer wrapper (typically a platform-
 * specific build override) tweak the sidebar's outer chrome without
 * forking the whole component. Default values come from theme tokens.
 *
 * Both `rootStyle` and `rootClassName` are spread / appended AFTER
 * the defaults so the override always wins.
 */
interface LeftSidebarProps {
  rootStyle?: CSSProperties
  rootClassName?: string
}

export function LeftSidebar({ rootStyle, rootClassName }: LeftSidebarProps = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const windowMinSize = useWindowMinSize()
  const { slots } = ModuleSystem
  const { isSidebarCollapsed } = AppLayout
  const { user, permissions } = Auth

  const isAllowed = (item: { permission?: SidebarNavItem['permission'] }) =>
    !item.permission || evaluatePermission(user, permissions, item.permission)

  // Get and sort items from slots
  const primaryActions = (slots.get('sidebarPrimaryActions') ||
    []) as SidebarActionItem[]
  const navigation = (slots.get('sidebarNavigation') || []) as SidebarNavItem[]
  const tools = (slots.get('sidebarTools') || []) as SidebarToolItem[]
  // Widget slots carry an optional `permission` (like nav/tool items).
  // Filter here so a widget backed by permission-restricted data (recent
  // conversations, download indicator) never mounts — and never fires its
  // on-mount fetch — for a user who lacks the grant. Widgets with no
  // `permission` render unconditionally (they self-gate internally if
  // needed). Reactive via the `user`/`permissions` read above.
  // Header-region widgets (A4: the account switcher). Permission-filtered like the
  // other widget slots, so a user lacking `account::read` never mounts the switcher
  // (the slot gating layer — TEST-13 negative-perm).
  const headerWidgets = (slots.get('sidebarHeader') || []).filter(isAllowed)
  const contentWidgets = (slots.get('sidebarContent') || []).filter(isAllowed)
  const bottomWidgets = (slots.get('sidebarBottom') || []).filter(isAllowed)
  const footerWidgets = (slots.get('sidebarFooter') || []).filter(isAllowed)

  const sortedPrimaryActions = useMemo(
    () => [...primaryActions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [primaryActions],
  )
  const sortedNavigation = useMemo(
    () =>
      [...navigation]
        .filter(isAllowed)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigation, user, permissions],
  )
  const sortedTools = useMemo(
    () =>
      [...tools]
        .filter(isAllowed)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tools, user, permissions],
  )

  // On desktop, collapsed means icon-only mode (not fully hidden)
  const isIconOnly = isSidebarCollapsed && !windowMinSize.xs

  // Build kit Menu item lists per group. In icon-only mode, labels are
  // omitted so only the icon is rendered (kit Menu has no inlineCollapsed
  // equivalent; tooltips on hover are not available in icon-only mode).
  const primaryItems: MenuItem[] = sortedPrimaryActions.map(a => ({
    key: a.id,
    icon: a.icon,
    label: isIconOnly ? null : a.label,
  }))

  const navigationItems: MenuItem[] = sortedNavigation.map(n => ({
    key: n.id,
    icon: n.icon,
    label: isIconOnly ? null : n.label,
  }))

  const toolsItems: MenuItem[] = sortedTools.map(t => ({
    key: t.id,
    icon: t.icon,
    label: isIconOnly ? null : t.label,
  }))

  const navSel = selectionForGroup(location.pathname, sortedNavigation)
  const toolsSel = selectionForGroup(location.pathname, sortedTools)
  // Primary actions surface paths only when present (otherwise the
  // action is a pure `onClick` like "New Chat" which never has a
  // selected state). Build the list with non-null paths only.
  const primarySel = selectionForGroup(
    location.pathname,
    sortedPrimaryActions
      .filter((a): a is SidebarActionItem & { to: string } => Boolean(a.to))
      .map(a => ({ id: a.id, path: a.to })),
  )
  const ancestorList = (id?: string) => (id ? [id] : undefined)

  // On mobile the sidebar is a full-screen Sheet and AppLayout remounts on each
  // route change — so navigating away while the Sheet is open unmounts it mid-
  // open and orphans its portaled overlay in <body>, which then swallows every
  // tap on the new page. Collapse first (closing the Sheet cleanly) before we
  // navigate. No-op on desktop where the sidebar is persistent.
  const navTo = (path: string) => {
    if (windowMinSize.xs) AppLayout.setSidebarCollapsed(true)
    navigate(path)
  }

  const handleNavMenuClick = (key: string) => {
    const item = sortedNavigation.find(n => n.id === key)
    if (item) navTo(item.path)
  }

  const handleToolsMenuClick = (key: string) => {
    const item = sortedTools.find(t => t.id === key)
    if (!item) return
    // A tools entry may open a drawer (or run any action) instead of navigating
    // (e.g. the Jobs button). `onClick` wins; otherwise navigate to `path`.
    if (item.onClick) {
      item.onClick()
      return
    }
    navTo(item.path)
  }

  const handlePrimaryMenuClick = (key: string) => {
    const item = sortedPrimaryActions.find(a => a.id === key)
    if (!item) return
    if (item.onClick) item.onClick()
    if (item.to) navTo(item.to)
  }

  return (
    <div
      className={
        'h-full flex flex-col overflow-hidden bg-muted/40' +
        (windowMinSize.xs ? '' : ' border-r border-border') +
        (rootClassName ? ' ' + rootClassName : '')
      }
      style={{
        width: '100%',
        // Wrapper overrides win — applied last.
        ...rootStyle,
      }}
    >
      <SidebarHeaderSpacer />

      {/* Header region — the account switcher (A4). Renders nothing at ≤1 account /
          on desktop, so solo + desktop users never see it. Hidden entirely in
          icon-only mode (no room for the label + dropdown). */}
      {!isIconOnly &&
        headerWidgets.length > 0 &&
        headerWidgets
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map(widget => (
            <div key={widget.id} className="px-2 pt-2">
              <LazyComponentRenderer component={widget.component} />
            </div>
          ))}

      {/* Primary Actions — no section header, like the original. */}
      {primaryItems.length > 0 && (
        <Menu
          mode="vertical"
          aria-label="Primary actions"
          data-testid="layout-sidebar-primary-actions-menu"
          selectedKey={primarySel.exact}
          ancestorKeys={ancestorList(primarySel.ancestor)}
          items={primaryItems}
          onSelect={handlePrimaryMenuClick}
          className="px-2"
        />
      )}

      {/* Navigation — section header rendered as a Menu item group so
          kit Menu handles the group title + token-based typography. */}
      {navigationItems.length > 0 && (
        <div className="mt-2">
          <Menu
            mode="vertical"
            aria-label="Primary navigation"
            data-testid="layout-sidebar-nav-menu"
            selectedKey={navSel.exact}
            ancestorKeys={ancestorList(navSel.ancestor)}
            items={[
              {
                type: 'group',
                label: 'Navigation',
                children: navigationItems,
              },
            ]}
            onSelect={handleNavMenuClick}
            className="px-2"
          />
        </div>
      )}

      {/* Content Section — widget slot (hidden in icon-only mode). */}
      {!isIconOnly && (
        <div className="flex-1 overflow-hidden flex flex-col mt-2">
          {contentWidgets
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map(widget => (
              <div key={widget.id} className="flex-1 min-h-0 flex flex-col">
                <LazyComponentRenderer component={widget.component} />
              </div>
            ))}
        </div>
      )}

      {/* Spacer in icon-only mode to push tools to bottom */}
      {isIconOnly && <div className="flex-1" />}

      {/* Tools — same shape as Navigation. */}
      {toolsItems.length > 0 && (
        <div className="mt-2">
          <Menu
            mode="vertical"
            aria-label="Tools navigation"
            data-testid="layout-sidebar-tools-menu"
            selectedKey={toolsSel.exact}
            ancestorKeys={ancestorList(toolsSel.ancestor)}
            items={[
              {
                type: 'group',
                label: 'Tools',
                children: toolsItems,
              },
            ]}
            onSelect={handleToolsMenuClick}
            className="px-2"
          />

          {/* Bottom Widgets (hidden in icon-only mode) */}
          {!isIconOnly && bottomWidgets.length > 0 && (
            <div className="px-2 mt-2">
              {bottomWidgets
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map(widget => (
                  <div key={widget.id}>
                    <LazyComponentRenderer component={widget.component} />
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Footer Slot */}
      {footerWidgets.length > 0 && (
        <>
          <Separator className="my-0" />
          <div className="py-2">
            {footerWidgets
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map(widget => (
                <div key={widget.id}>
                  <LazyComponentRenderer component={widget.component} />
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
