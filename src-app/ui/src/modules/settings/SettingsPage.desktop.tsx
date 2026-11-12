/**
 * DELIBERATE DIVERGENCE from core's SettingsPage.
 *
 * Why: desktop is single-admin. No need for the web's "User Settings"
 * vs "Admin Settings" sectioning, no need for permission-based filtering
 * (the bootstrapped admin has every permission), no need for the inline
 * 403 panel core renders on forbidden deep-links.
 *
 * What this file does differently:
 *   1. Collapses both `settingsUserPages` and `settingsAdminPages` into a
 *      single flat menu (no section divider, no "Admin Settings" header).
 *   2. Filters BOTH slot lists through a computed set — entries whose `id`
 *      is hidden never appear in the menu. The set starts with a static
 *      list of multi-user-only page IDs, then auto-derives desktop-
 *      replacement entries from slot registrations: any core entry
 *      whose id has a counterpart ending in `-desktop` is suppressed.
 *   3. Combined desktop modules (e.g. memory-desktop) register their own
 *      entry; the auto-derivation removes the equivalent core entries
 *      so the user sees one combined "Memory" instead of duplicates.
 *
 * If core's SettingsPage gains a feature that ALL settings UIs need
 * (e.g. a new layout primitive), re-sync the layout shell below — keep
 * the filter list + flat menu logic.
 */

import { Button, Dropdown, Flex, Menu, Title } from '@txresbench/kit'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useElementMinSize } from '@txresbench/shell'
import { HeaderBarContainer } from '@txresbench/shell'
import { IoIosArrowDown, IoMdSettings } from 'react-icons/io'
import { useEffect, useRef } from 'react'
import { ModuleSystem } from '@txresbench/framework/stores'
import { AppMode } from '@/modules/app/AppMode.store'

// Settings page entries that are specific to multi-user SaaS features
// with no equivalent on single-admin desktop. These are explicitly
// listed because they have no desktop counterpart to auto-derive from.
//
//  - Multi-user RBAC surfaces (no role on a single-admin desktop):
//    users, user-groups, auth-providers.
//  - `user-llm-providers`: lets a non-admin override the admin-set API
//    key with their own. On single-admin desktop there's no split.
//  - `assistant-templates`: templates seed a fleet. On single-user
//    desktop there's no fleet — use `assistants` (kept visible).
//  - `mcp-servers`: personal/user MCP. Hidden on desktop in favour of
//    `mcp-admin` (System MCP, kept visible). The page's per-row group-
//    assignment widget + user-policy card are hidden via
//    `AppMode.multiUserMode` (false on desktop).
//  - `profile`: account display name + password. The single desktop
//    admin is auto-provisioned with a fixed username and uses Tauri's
//    auto-login; no profile to present or edit.
//
// Core entries that DO have a desktop counterpart (e.g. `memory` and
// `memory-admin` replaced by `memory-desktop`) are NOT listed here.
// They are auto-derived from slot registrations below — a desktop
// module with id ending in `-desktop` automatically suppresses the
// matching core `{base}` and `{base}-admin` entries.
const DESKTOP_INAPPROPRIATE_IDS = new Set([
  'users',
  'user-groups',
  'assistant-templates',
  'auth-providers',
  'user-llm-providers',
  'mcp-servers',
  'profile',
])

// Re-export so desktop modules can verify against the static filter
// set during tests without depending on the page component.
export { DESKTOP_INAPPROPRIATE_IDS as DESKTOP_HIDDEN_SETTING_IDS }

// Label remap applied to the desktop settings menu only. On desktop
// the user MCP page is hidden, so the System MCP page is THE MCP
// page — the "System" qualifier is redundant and confusing. Other
// admin labels that imply a user/admin split can be remapped the
// same way here in the future.
const LABEL_OVERRIDES: Record<string, string> = {
  'mcp-admin': 'MCP Servers',
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Layout flips based on the settings page's OWN width via
  // ResizeObserver on `containerRef` (not the viewport, not the
  // AppLayout main-content). `sm` (≤640px) is the threshold: the
  // side menu (~180px) + a usable content column (~440px) needs
  // ~620px total. Below that, fold the menu into the mobile
  // dropdown so the page stops feeling cramped.
  const containerRef = useRef<HTMLDivElement>(null)
  const minSize = useElementMinSize(containerRef)
  const useMobileLayout = minSize.sm

  const { slots } = ModuleSystem

  // Compute the effective filter: start with multi-user-only IDs, then
  // auto-hide any core entry whose id has a desktop counterpart
  // (registered with id ending in `-desktop`). This decouples the
  // desktop SettingsPage from knowing specific core settings page IDs:
  // adding a new desktop module auto-suppresses its core counterpart.
  const hiddenItems = new Set(DESKTOP_INAPPROPRIATE_IDS)
  for (const entry of [
    ...(slots.get('settingsUserPages') || []),
    ...(slots.get('settingsAdminPages') || []),
  ]) {
    if (entry.id.endsWith('-desktop')) {
      const base = entry.id.slice(0, -'-desktop'.length)
      hiddenItems.add(base)
      hiddenItems.add(`${base}-admin`)
    }
  }

  // Apply hiddenItems to BOTH slot lists (single-admin desktop doesn't
  // care about the user/admin distinction; what matters is the id).
  const userSettingsItems = (slots.get('settingsUserPages') || [])
    .filter(item => !hiddenItems.has(item.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  const adminSettingsItems = (slots.get('settingsAdminPages') || [])
    .filter(item => !hiddenItems.has(item.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // Build final menu (no sections in desktop app)
  const menuItems = [
    ...userSettingsItems.map(item => ({
      key: item.path,
      icon: item.icon,
      label: LABEL_OVERRIDES[item.id] ?? item.label,
    })),
    ...adminSettingsItems.map(item => ({
      key: item.path,
      icon: item.icon,
      label: LABEL_OVERRIDES[item.id] ?? item.label,
    })),
  ]

  // Extract the current settings section from the URL and validate it
  const urlSection = location.pathname.match(/\/settings\/([^/]+)/)?.[1]
  const validSections = menuItems
    .filter(item => 'key' in item && item.key)
    .map(item => item.key)

  const currentSection = validSections.includes(urlSection)
    ? urlSection
    : validSections[0]

  // Redirect to first available settings page if at root /settings
  useEffect(() => {
    if (
      location.pathname === '/settings' ||
      location.pathname === '/settings/'
    ) {
      if (validSections.length > 0) {
        navigate(`/settings/${validSections[0]}`, { replace: true })
      }
    }
  }, [location.pathname, navigate, validSections])

  const handleMenuClick = (key: string) => {
    navigate(`/settings/${key}`)
  }

  // Get current section display info
  const getCurrentSectionInfo = () => {
    const currentItem = menuItems.find(
      item => 'key' in item && item.key === currentSection,
    )
    return currentItem || { icon: <IoMdSettings />, label: 'Settings' }
  }

  const SettingsMenu = () => (
    <Menu
      data-testid="desktop-settings-menu"
      aria-label="Settings sections"
      className="w-fit h-full p-1"
      selectedKey={currentSection || validSections[0]}
      items={menuItems.map(item => ({
        key: item.key,
        icon: item.icon,
        label: item.label,
      }))}
      onSelect={key => handleMenuClick(key)}
    />
  )

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col overflow-hidden"
    >
      {/* Page Header */}
      <HeaderBarContainer>
        <div className="h-full flex items-center justify-between w-full">
          <Title level={4} className="m-0 leading-tight truncate">
            Settings
          </Title>
          {useMobileLayout && (
            <div className="flex flex-1 items-center px-2">
              <Dropdown
                data-testid="desktop-settings-section-dropdown"
                align="start"
                items={menuItems.map(item => ({
                  key: item.key,
                  label: (
                    <Flex className="gap-2 items-center">
                      {item.icon}
                      {item.label}
                    </Flex>
                  ),
                }))}
                onSelect={key => handleMenuClick(key)}
              >
                <Button data-testid="desktop-settings-section-dropdown-btn" variant="ghost" className="mt-[2px]">
                  {getCurrentSectionInfo().icon} {getCurrentSectionInfo().label}{' '}
                  <IoIosArrowDown />
                </Button>
              </Dropdown>
            </div>
          )}
        </div>
      </HeaderBarContainer>

      {/* Page Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop Sidebar — top padding gives the menu a 16px gap
            from the HeaderBarContainer above. Without it the menu's
            first item sits flush against the bottom of the header,
            which fights the soft fade overlay that HeaderBarContainer
            paints below itself. */}
        {!useMobileLayout && (
          <div className="w-fit pt-1">
            <SettingsMenu />
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
