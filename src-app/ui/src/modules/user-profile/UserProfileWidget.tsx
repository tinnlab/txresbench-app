import { Dropdown, Tooltip, Skeleton } from '@ziee/kit'
import { LogOut, User } from 'lucide-react'
import { Auth } from '@/modules/auth/Auth.store'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout.store'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { useNavigate } from 'react-router-dom'

function SidebarItem({
  icon,
  label,
  onClick,
  collapsed,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  collapsed?: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
      className="flex items-center px-3 py-1 mx-2 rounded-md cursor-pointer transition-colors duration-150 text-foreground focus-visible:outline focus-visible:outline-2"
      onMouseEnter={e => {
        e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--primary) 90%, transparent)'
        e.currentTarget.style.color = 'white'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.backgroundColor = 'transparent'
        e.currentTarget.style.color = ''
      }}
      onFocus={e => {
        e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--primary) 90%, transparent)'
        e.currentTarget.style.color = 'white'
      }}
      onBlur={e => {
        e.currentTarget.style.backgroundColor = 'transparent'
        e.currentTarget.style.color = ''
      }}
    >
      <div
        aria-hidden="true"
        className="w-4 h-4 mr-1.5 flex items-center justify-center"
        style={{ fontSize: 18 }}
      >
        {icon}
      </div>
      <span
        title={label}
        className="text-sm"
        style={{
          opacity: collapsed ? 0 : 1,
          maxWidth: collapsed ? 0 : 200,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          transition: 'opacity 200ms ease-out, max-width 200ms ease-out',
        }}
      >
        {label}
      </span>
    </div>
  )
}

export function UserProfileWidget() {
  const { user, isInitializing, isLoading } = Auth
  const { isSidebarCollapsed } = AppLayout
  const canViewProfile = usePermission(Permissions.ProfileEdit)
  const navigate = useNavigate()

  if (!user) {
    // While auth is still resolving (user not yet hydrated) show a skeleton
    // row that mirrors the SidebarItem shape — an avatar-shaped circle plus a
    // label line, composed from the kit Skeleton primitive (no Skeleton.Avatar
    // in the kit) — so the sidebar footer doesn't pop in blank then jump to the
    // profile entry. Once auth has SETTLED with no user (logged out), the
    // signals clear and we render nothing.
    if (isInitializing || isLoading) {
      return (
        <div
          data-testid="user-profile-widget-loading"
          className="flex items-center px-3 py-1 mx-2"
          aria-hidden="true"
        >
          <Skeleton className="w-4 h-4 mr-1.5 rounded-full shrink-0" />
          {!isSidebarCollapsed && <Skeleton className="h-3.5 w-24 rounded" />}
        </div>
      )
    }
    return null
  }

  const items = [
    ...(canViewProfile
      ? [
          {
            key: 'profile',
            icon: <User />,
            label: 'Profile',
            onClick: () => navigate('/settings/profile'),
          },
        ]
      : []),
    {
      key: 'logout',
      icon: <LogOut />,
      label: 'Logout',
      onClick: async () => await Auth.logoutUser(),
    },
  ]

  const item = (
    <Dropdown
      data-testid="userprofile-menu-dropdown"
      items={items}
      side="top"
      align="start"
      // Keep the menu left-aligned under the username instead of flipping to the
      // right at the sidebar's left edge (Base UI's default align collision).
      collisionAvoidance={{ align: 'shift' }}
    >
      {/* role=button so Radix's injected aria-expanded/aria-haspopup are valid
          on this dropdown trigger (a bare <div> doesn't support them → axe
          aria-allowed-attr). tabIndex keeps it keyboard-reachable. */}
      <div data-testid="user-profile-widget" role="button" tabIndex={0}>
        <SidebarItem
          icon={<User />}
          label={user.username}
          collapsed={isSidebarCollapsed}
        />
      </div>
    </Dropdown>
  )

  if (isSidebarCollapsed) {
    return (
      <Tooltip content={user.username} side="right">
        {item}
      </Tooltip>
    )
  }

  return item
}
