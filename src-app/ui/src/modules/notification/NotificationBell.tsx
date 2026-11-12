import { Notifications } from '@/modules/notification/Notifications.store'
import {
  getNotificationRenderer,
  type AppNotification,
  type NotificationRendererCtx,
} from '@txresbench/framework/notification'
import { Badge, Button, Empty, Popover, Separator } from '@txresbench/kit'
import { Bell, Check, X } from 'lucide-react'
import { useState } from 'react'

/** One inbox row — dispatches on `kind` to the registered renderer, or a
 *  generic title/body fallback. */
function InboxRow({
  n,
  ctx,
}: {
  n: AppNotification
  ctx: NotificationRendererCtx
}) {
  const renderer = getNotificationRenderer(n.kind)
  return (
    <div
      className="flex flex-col gap-2 px-3 py-2"
      data-testid={`notification-row-${n.id}`}
      data-kind={n.kind}
      data-unread={n.read_at ? undefined : 'true'}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {renderer ? (
            renderer.render(n, ctx)
          ) : (
            <div>
              <div className="text-sm font-medium">{n.title}</div>
              {n.body ? (
                <div className="text-sm text-muted-foreground">{n.body}</div>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {!n.read_at ? (
            <Button
              variant="ghost"
              size="icon"
              tooltip="Mark read"
              data-testid={`notification-mark-read-${n.id}`}
              onClick={() => ctx.markRead(n.id)}
            >
              <Check className="size-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            tooltip="Dismiss"
            data-testid={`notification-dismiss-${n.id}`}
            onClick={() => ctx.remove(n.id)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      {renderer?.actions ? (
        <div className="flex gap-2">{renderer.actions(n, ctx)}</div>
      ) : null}
    </div>
  )
}

function Inbox({ ctx }: { ctx: NotificationRendererCtx }) {
  const { items, unread } = Notifications
  return (
    <div className="w-full" data-testid="notification-inbox">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium">Notifications</span>
        {unread > 0 ? (
          <Button
            variant="ghost"
            data-testid="notification-read-all"
            onClick={() => Notifications.readAll()}
          >
            Mark all read
          </Button>
        ) : null}
      </div>
      <Separator />
      <div className="max-h-96 overflow-y-auto">
        {items.length === 0 ? (
          <div className="py-6">
            <Empty description="No notifications" data-testid="notification-empty" />
          </div>
        ) : (
          items.map((n, i) => (
            <div key={n.id}>
              {i > 0 ? <Separator /> : null}
              <InboxRow n={n} ctx={ctx} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** The notification bell + unread badge + inbox popover, mounted into a sidebar
 *  slot. The SDK owns the renderer-registry SEAM; this shell dogfoods it. */
export function NotificationBell() {
  const { unread } = Notifications
  const [open, setOpen] = useState(false)
  const ctx: NotificationRendererCtx = {
    markRead: id => void Notifications.markRead(id),
    remove: id => void Notifications.remove(id),
    close: () => setOpen(false),
  }
  return (
    <div className="flex px-2 py-1">
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="right"
        align="start"
        className="w-80 max-w-[92vw]"
        content={<Inbox ctx={ctx} />}
      >
        <Button
          variant="ghost"
          size="icon"
          tooltip="Notifications"
          data-testid="notification-bell"
        >
          <Badge
            count={unread}
            aria-label={`${unread} unread notifications`}
            data-testid="notification-unread-badge"
          >
            <Bell className="size-5" />
          </Badge>
        </Button>
      </Popover>
    </div>
  )
}
