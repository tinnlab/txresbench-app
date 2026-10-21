import { ApiClient } from '@/api-client'
import { echoLocalSyncFrames, type LocalSyncFrame } from '@/core/sync/localEcho'
import {
  registerNotificationKind,
  type AppNotification,
  type NotificationRendererCtx,
} from '@ziee/framework/notification'
import { Button, message } from '@ziee/kit'

// The project module's notification kinds (must match the backend
// NOTIFICATION_KINDS strings + payload shapes).
const KIND_SHARE_INVITE = 'project_share_invite'
const KIND_TRANSFER_INVITE = 'project_transfer_invite'
const KIND_OWNERSHIP_CHANGED = 'project_ownership_changed'

function Body({ n }: { n: AppNotification }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium">{n.title}</div>
      {n.body ? <div className="text-sm text-muted-foreground">{n.body}</div> : null}
    </div>
  )
}

/**
 * An invite action returns the frames the server WITHHELD from this connection, so the
 * generic runner below can echo them.
 *
 * This used to call `Projects.load()` — one store, hand-picked at the call site, with a
 * comment noting that self-echo is suppressed here. That refreshed the /projects grid and
 * nothing else: not the sidebar rail, not an open project detail (which, on an accepted
 * TRANSFER, is a project whose ownership just changed), not the admin table, not the
 * workbench catalog. Returning frames instead puts this path on the same channel as every
 * other device, so a new consumer of `sync:project*` is served without editing this file.
 */
type InviteAction = () => Promise<LocalSyncFrame[]>

function InviteActions({
  n,
  ctx,
  accept,
  decline,
  acceptLabel,
}: {
  n: AppNotification
  ctx: NotificationRendererCtx
  accept: InviteAction
  decline: InviteAction
  acceptLabel: string
}) {
  const run = async (fn: InviteAction, ok: string) => {
    try {
      const frames = await fn()
      message.success(ok)
      await echoLocalSyncFrames(frames)
      ctx.remove(n.id)
      ctx.close()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Action failed')
    }
  }
  return (
    <>
      <Button data-testid={`notification-accept-${n.id}`} onClick={() => void run(accept, `${acceptLabel}`)}>
        Accept
      </Button>
      <Button
        variant="outline"
        data-testid={`notification-decline-${n.id}`}
        onClick={() => void run(decline, 'Declined')}
      >
        Decline
      </Button>
    </>
  )
}

/** Register the project notification renderers through the SDK seam. Invoked once
 *  at module load (side-effect import from the project module). */
export function registerProjectNotificationKinds(): void {
  registerNotificationKind(KIND_SHARE_INVITE, {
    render: n => <Body n={n} />,
    actions: (n, ctx) => {
      const shareId = String(n.payload.share_id ?? '')
      return (
        <InviteActions
          n={n}
          ctx={ctx}
          acceptLabel="Project added to your list"
          // `accept_share` publishes BOTH `ProjectShare`/Update and `Project`/Create to
          // the ACTOR with `origin` — both suppressed, so both are echoed here.
          // The `Project` frame used to be published with `origin: None`, and this site
          // carried a paragraph explaining why it alone must NOT be echoed. That
          // exception is gone: the server now applies `origin` to every frame addressed
          // to the acting user, so this list is identical in shape to the transfer one
          // below and neither needs a reader to look up which frames are special.
          accept={() =>
            ApiClient.Project.acceptShare({ id: shareId }).then(s => [
              { entity: 'project_share', action: 'update', id: s.id } as const,
              { entity: 'project', action: 'create', id: s.project_id } as const,
            ])
          }
          decline={() =>
            ApiClient.Project.declineShare({ id: shareId }).then(s => [
              { entity: 'project_share', action: 'update', id: s.id } as const,
            ])
          }
        />
      )
    },
  })

  registerNotificationKind(KIND_TRANSFER_INVITE, {
    render: n => <Body n={n} />,
    actions: (n, ctx) => {
      const transferId = String(n.payload.transfer_id ?? '')
      return (
        <InviteActions
          n={n}
          ctx={ctx}
          acceptLabel="You now own this project"
          // `accept_transfer` publishes BOTH `Project`/Create and
          // `ProjectTransfer`/Update to the ACTOR with `origin` — both suppressed, so the
          // accepting device previously learned nothing at all about the project it had
          // just been given.
          accept={() =>
            ApiClient.Project.acceptTransfer({ id: transferId }).then(t => [
              { entity: 'project', action: 'create', id: t.project_id } as const,
              { entity: 'project_transfer', action: 'update', id: t.id } as const,
            ])
          }
          decline={() =>
            ApiClient.Project.declineTransfer({ id: transferId }).then(t => [
              { entity: 'project_transfer', action: 'update', id: t.id } as const,
            ])
          }
        />
      )
    },
  })

  // Informational only (an admin moved a project to you) — no accept/decline.
  registerNotificationKind(KIND_OWNERSHIP_CHANGED, {
    render: n => <Body n={n} />,
  })
}
