import { Button, Dropdown, Flex, Link, Result, ScrollArea, Title, Text } from '@ziee/kit'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useElementMinSize } from '@ziee/shell'
import { useNativeScroll } from '@/modules/layouts/app-layout/hooks/useNativeScroll'
import { HeaderBarContainer } from '@ziee/shell'
import { cn } from '@/lib/utils'
import { IoIosArrowDown, IoMdSettings } from 'react-icons/io'
import { BookOpen, ExternalLink } from 'lucide-react'

// Help destination: the app's GitHub repo README is the de-facto operator
// documentation. (`ziee-ai/ziee` — renamed from `phibya/ziee-chat-new` in the
// org migration.)
const HELP_DOCS_URL = 'https://github.com/tinnlab/txresbench-app#readme'
import { useEffect, useRef, useState } from 'react'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout.store'
import { ModuleSystem } from '@ziee/framework/stores'
import { Session } from '@/modules/session/Session.store'
import { evaluatePermission } from '@/core/permissions'
import type { SettingsPageSlot } from '@/modules/settings/types/SettingsSlots'
import { Menu } from '@ziee/kit'
import type { MenuItem } from '@ziee/kit/kit/menu'

export default function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Drive layout from the settings page's OWN container width
  // (via ResizeObserver on `containerRef`). Independent of the
  // viewport AND of `mainContentWidth` — guarantees the layout
  // flip is keyed to the actual horizontal room the settings
  // page has, regardless of what's happening upstream in the
  // AppLayout (sidebar collapse, window resize, embedded chrome).
  const containerRef = useRef<HTMLDivElement>(null)
  // Track the mobile section-picker dropdown's open state so the trigger
  // button can expose `aria-expanded` (the menu-button ARIA contract).
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const minSize = useElementMinSize(containerRef)
  // Opt Settings into native document scroll on mobile (iOS Safari toolbar
  // collapse). No-op on desktop / non-xs — the two-pane inner-scroll layout is
  // untouched there. `nativeScroll` from the store drives the flow classes.
  useNativeScroll(true)
  const { nativeScroll } = AppLayout
  // The settings layout needs the side-menu (~180px) + a content
  // column wide enough for cards/forms (~440px) to feel non-cramped
  // — that's ~620px total. Use `sm` (≤640px) as the threshold so
  // the menu folds into the mobile dropdown the moment the page
  // itself drops below the comfortable two-column width, not at
  // the much tighter `xs` (≤480) which the page rarely hits.
  const useMobileLayout = minSize.sm

  const { slots } = ModuleSystem
  const { user, permissions } = Session

  const isAllowed = (item: SettingsPageSlot) =>
    !item.permission || evaluatePermission(user, permissions, item.permission)

  // Get, sort, and permission-filter user settings from slots
  const userSettingsItems = (slots.get('settingsUserPages') || [])
    .filter(isAllowed)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // Get, sort, and permission-filter admin settings from slots
  const adminSettingsItems = (slots.get('settingsAdminPages') || [])
    .filter(isAllowed)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // Slot entries the user can't see, kept around so we can distinguish
  // "section doesn't exist" from "section exists but you're forbidden"
  // when handling deep-link URLs below.
  const forbiddenSettingsItems = [
    ...(slots.get('settingsUserPages') || []),
    ...(slots.get('settingsAdminPages') || []),
  ].filter(item => !isAllowed(item))

  // Kit Menu items — group nesting required by kit Menu's MenuItem type.
  const kitMenuItems: MenuItem[] = [
    ...userSettingsItems.map(item => ({
      key: item.path,
      icon: item.icon,
      label: item.label,
    })),
    ...(adminSettingsItems.length > 0
      ? [
          { type: 'divider' as const },
          {
            type: 'group' as const,
            label: (
              <span className="flex items-center gap-1">
                <IoMdSettings />
                Admin
              </span>
            ),
            children: adminSettingsItems.map(item => ({
              key: item.path,
              icon: item.icon,
              label: item.label,
            })),
          },
        ]
      : []),
  ]

  // Kit Dropdown items for the mobile trigger.
  const dropdownItems = [
    ...userSettingsItems.map(item => ({
      key: item.path,
      icon: item.icon,
      label: (
        <Flex className={'gap-2 items-center'}>
          {item.icon}
          {item.label}
        </Flex>
      ),
    })),
    ...(adminSettingsItems.length > 0
      ? [
          { type: 'divider' as const },
          {
            type: 'label' as const,
            label: (
              <div className={'-ml-1'}>
                <Text strong type={'secondary'} className={'!text-xs'}>
                  Admin
                </Text>
              </div>
            ),
          },
          ...adminSettingsItems.map(item => ({
            key: item.path,
            icon: item.icon,
            label: (
              <Flex className={'gap-2 items-center'}>
                {item.icon}
                {item.label}
              </Flex>
            ),
          })),
        ]
      : []),
    // Help link (reserved key handled in onSelect).
    { type: 'divider' as const },
    {
      key: '__help__',
      label: (
        <Flex className={'gap-2 items-center'}>
          <BookOpen />
          Help &amp; documentation
        </Flex>
      ),
    },
  ]

  // For permission checks on deep-linked URLs we need the flat valid section keys.
  const validSections = [
    ...userSettingsItems.map(item => item.path),
    ...adminSettingsItems.map(item => item.path),
  ]

  // Extract the current settings section from the URL and validate it
  const urlSection = location.pathname.match(/\/settings\/([^/]+)/)?.[1]

  // Did the user deep-link to a section that exists but their
  // permissions hide? Treat that distinctly from "section doesn't
  // exist" — render an inline 403 rather than silently redirecting,
  // so admin-shared links produce a meaningful page.
  const forbiddenSection = urlSection
    ? forbiddenSettingsItems.find(item => item.path === urlSection)
    : undefined

  const currentSection = validSections.includes(urlSection ?? '')
    ? urlSection
    : validSections[0]

  // Redirect to first available settings page if at root /settings.
  // Skip redirect when the URL points at a forbidden section — we want
  // to render the 403 panel in place, not bounce the user elsewhere.
  useEffect(() => {
    if (
      (location.pathname === '/settings' ||
        location.pathname === '/settings/') &&
      !forbiddenSection
    ) {
      if (validSections.length > 0) {
        navigate(`/settings/${validSections[0]}`, { replace: true })
      }
    }
  }, [location.pathname, navigate, validSections, forbiddenSection])

  const handleMenuClick = (key: string) => {
    navigate(`/settings/${key}`)
  }

  // Get current section display info
  const getCurrentSectionInfo = () => {
    const flat = [
      ...userSettingsItems,
      ...adminSettingsItems,
    ]
    return flat.find(item => item.path === currentSection) || { icon: <IoMdSettings />, label: 'Settings' }
  }

  const SettingsMenu = () => (
    <Menu
      data-testid="settings-nav-menu"
      className="w-fit px-2 py-1"
      items={kitMenuItems}
      selectedKey={currentSection ?? validSections[0]}
      onSelect={handleMenuClick}
      mode="vertical"
      aria-label="Settings navigation"
    />
  )

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-col',
        nativeScroll ? 'min-h-dvh' : 'h-full overflow-hidden',
      )}
    >
      {/* Page Header */}
      <HeaderBarContainer>
        <div className="h-full flex items-center justify-between w-full">
          <Title level={4} className="!m-0 !leading-tight truncate">
            Settings
          </Title>
          {useMobileLayout && (
            <div className="flex items-center">
              <Dropdown
                data-testid="settings-mobile-dropdown"
                items={dropdownItems.map((item: any) => {
                  if ('type' in item && item.type === 'divider') {
                    return { type: 'divider' as const }
                  }
                  if ('type' in item && item.type === 'label') {
                    return { type: 'label' as const, label: item.label }
                  }
                  return {
                    key: item.key,
                    label: item.label,
                  }
                })}
                onSelect={(key) => {
                  if (key === '__help__') {
                    window.open(HELP_DOCS_URL, '_blank', 'noopener,noreferrer')
                    return
                  }
                  handleMenuClick(key)
                }}
                onOpenChange={setMobileMenuOpen}
              >
                <Button
                  variant="ghost"
                  data-testid="settings-mobile-dropdown-trigger"
                  className={'mt-[2px]'}
                  aria-label="Select settings section"
                  aria-haspopup="menu"
                  aria-expanded={mobileMenuOpen}
                >
                  {getCurrentSectionInfo().icon} {getCurrentSectionInfo().label}{' '}
                  <IoIosArrowDown />
                </Button>
              </Dropdown>
            </div>
          )}
        </div>
      </HeaderBarContainer>

      {/* Page Content */}
      <div className={cn('flex flex-1', nativeScroll ? '' : 'overflow-hidden')}>
        {/* Desktop Sidebar — top padding gives the menu a 16px gap
            from the HeaderBarContainer above. Without it the menu's
            first item sits flush against the bottom of the header,
            which fights the soft fade overlay HeaderBarContainer
            paints below itself. */}
        {!useMobileLayout && (
          <div
            className="w-fit pt-1 flex flex-col h-full"
            role="navigation"
            aria-label="Settings sections"
          >
            <ScrollArea axis="y" className="flex-1 min-h-0">
              <SettingsMenu />
            </ScrollArea>
            {/* Help + onboarding guidance, pinned to the bottom of the nav. */}
            <div className="border-t border-border p-2 flex flex-col gap-1">
              <Link
                data-testid="settings-help-link"
                href={HELP_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 px-2 py-1 text-sm"
              >
                <BookOpen className="h-4 w-4" />
                Help &amp; documentation
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden">
          {forbiddenSection ? (
            <Result
              data-testid="settings-forbidden-result"
              status="403"
              title="Not authorized"
              subtitle={`You don't have permission to view "${forbiddenSection.label}".`}
            />
          ) : (
            <Outlet />
          )}
        </div>
      </div>
    </div>
  )
}
