import { z } from 'zod'
import {
  Button,
  Dialog,
  Form,
  FormField,
  Input,
  Select,
  Spinner,
  Tag,
  message,
} from '@txresbench/kit'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { useForm, zodResolver } from '@txresbench/kit'
import { Trash2 } from 'lucide-react'
import type { DatasetShare } from '@/api-client/types'

const shareSchema = z.object({
  principal_type: z.enum(['user', 'group']),
  principal_id: z.string().min(1, 'Enter the user or group ID'),
  role: z.enum(['view', 'edit']),
})
type ShareValues = z.infer<typeof shareSchema>

/**
 * Share a dataset with a user or group at a role (DEC-3). Reads its target from
 * `Datasets.shareTarget` so the SAME dialog serves the library table + the
 * detail header. Uses the exact `ShareDatasetRequest` contract (principal +
 * role); there is no user-facing user-search endpoint, so the principal is entered
 * by id. The dataset's existing shares are listed above the form (loaded when the
 * dialog opens) with a per-row revoke affordance.
 */
export function ShareDialog() {
  const { shareTarget, shares, sharesLoading, mutating } = Datasets
  const form = useForm<ShareValues>({
    resolver: zodResolver(shareSchema),
    defaultValues: { principal_type: 'user', principal_id: '', role: 'view' },
  })

  const open = shareTarget !== null
  const close = () => {
    Datasets.closeShare()
    form.reset({ principal_type: 'user', principal_id: '', role: 'view' })
  }

  const onSubmit = async (values: ShareValues) => {
    if (!shareTarget) return
    try {
      await Datasets.shareDataset(shareTarget.id, values)
      message.success('Dataset shared')
      form.reset({ principal_type: 'user', principal_id: '', role: 'view' })
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to share dataset')
    }
  }

  const onRevoke = async (share: DatasetShare) => {
    if (!shareTarget) return
    try {
      await Datasets.unshareDataset(shareTarget.id, share.id)
      message.success('Access revoked')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to revoke access')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) close()
      }}
      title={shareTarget ? `Share "${shareTarget.name}"` : 'Share dataset'}
      description="Grant another user or group access to this dataset."
      // WHERE FOCUS BELONGS, DECLARED. Base UI focuses the first TABBABLE element, and this
      // dialog renders "People with access" ABOVE the form — so with any share present the first
      // tabbable is a per-row "Remove access for …" bin, and the dialog opened with a destructive
      // action one Enter away. It looked fine only because shares load async: at mount the list is
      // a spinner, so the Select won the race. Timing, not design.
      //
      // The field the user came to fill in is the one that should have focus anyway, which is why
      // this is a fix rather than a mitigation. The bin is ALSO marked `destructive` below, so the
      // kit's guarded default keeps this dialog safe even if this line is ever dropped.
      initialFocus="dataset-share-principal"
      data-testid="dataset-share-dialog"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="dataset-share-cancel">
            Cancel
          </Button>
          <Button
            type="submit"
            form="dataset-share-form"
            loading={mutating}
            data-testid="dataset-share-submit"
          >
            Share
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Existing access — the dataset's current shares, with a revoke affordance. */}
        <div className="flex flex-col gap-2" data-testid="dataset-share-existing">
          <span className="text-sm font-medium">People with access</span>
          {sharesLoading ? (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="dataset-share-loading"
            >
              <Spinner size="sm" label="Loading shares" /> Loading…
            </div>
          ) : shares.length === 0 ? (
            <span className="text-sm text-muted-foreground" data-testid="dataset-share-empty">
              No one else has access yet.
            </span>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="dataset-share-list">
              {shares.map(share => (
                <li
                  key={share.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  data-testid={`dataset-share-row-${share.id}`}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{share.principal_id}</span>
                    <span className="text-xs text-muted-foreground">
                      {share.principal_type === 'group' ? 'Group' : 'User'}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Tag
                      tone={share.role === 'edit' ? 'primary' : 'default'}
                      variant="soft"
                      data-testid={`dataset-share-role-${share.id}`}
                    >
                      {share.role === 'edit' ? 'Edit' : 'View'}
                    </Tag>
                    <Button
                      size="icon"
                      variant="ghost"
                      // `tooltip` not `aria-label`: the kit adopts a string tooltip as the name,
                      // so a bin icon repeated once per row cannot say one thing on hover and
                      // another to a screen reader.
                      //
                      // THIS USED TO BE `disabled={mutating}`, on the reasoning that an in-flight
                      // share is a transient global "busy" rather than a per-row reason, so there
                      // was nothing extra to explain. The first half is right and the conclusion
                      // does not follow, for two reasons measured here:
                      //
                      //   1. THE TOOLTIP ON THIS CONTROL IS ITS NAME, NOT A REASON. Twelve
                      //      identical bins are told apart by nothing else. Going natively
                      //      `disabled` did not withhold a reason nobody needed — it made every
                      //      row's only identity unreadable for the length of the request, to
                      //      exactly the sighted user who has no other way to get it.
                      //   2. ITS SIBLING IN THIS SAME DIALOG, ON THIS SAME FLAG, already uses the
                      //      kit's busy idiom: the Share submit is `loading={mutating}`, which is
                      //      aria-disabled + aria-busy and stays hoverable and focusable. One flag
                      //      was being read two ways ten lines apart.
                      //
                      // `loading` is wrong for the rows (it would put a spinner on every bin), so
                      // this takes the same posture by hand: inert and announced busy, still
                      // hoverable, still a tab stop, name intact. NOT `unavailableReason` either —
                      // that prop is for a control with a REASON to state, and "an unrelated
                      // request is in flight for 300ms" is not one.
                      tooltip={`Remove access for ${share.principal_id}`}
                      // NOT A LOOK — a declaration. `ghost` is the house variant for a
                      // destructive singleton, so the variant could never have carried this, and
                      // this is precisely the control an overlay's initial focus must not aim at.
                      destructive
                      aria-disabled={mutating || undefined}
                      aria-busy={mutating || undefined}
                      className={mutating ? 'cursor-not-allowed opacity-50' : undefined}
                      onClick={() => {
                        if (mutating) return
                        void onRevoke(share)
                      }}
                      data-testid={`dataset-share-remove-${share.id}`}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Form
          name="dataset-share-form"
          form={form}
          layout="vertical"
          onSubmit={onSubmit}
          data-testid="dataset-share-form"
        >
          <FormField name="principal_type" label="Share with">
            <Select
              data-testid="dataset-share-type"
              options={[
                { label: 'User', value: 'user' },
                { label: 'Group', value: 'group' },
              ]}
            />
          </FormField>
          <FormField
            name="principal_id"
            label="User or group ID"
            required
            description="The id of the user or group to grant access."
          >
            <Input placeholder="00000000-0000-0000-0000-000000000000" data-testid="dataset-share-principal" />
          </FormField>
          <FormField name="role" label="Access level">
            <Select
              data-testid="dataset-share-role"
              options={[
                { label: 'View (read-only)', value: 'view' },
                { label: 'Edit (process + attach)', value: 'edit' },
              ]}
            />
          </FormField>
        </Form>
      </div>
    </Dialog>
  )
}
