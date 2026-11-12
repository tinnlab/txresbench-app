import { z } from 'zod'
import { Button, Form, FormField, Input, Select, message, useForm, zodResolver } from '@txresbench/kit'
import { Drawer } from '@txresbench/shell'
import { ProjectDrawer } from '@/modules/project/stores/ProjectDrawer.store'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { EMAIL_RE } from '@/lib/validation'
import { isDesktop } from '@/core/platform'
import { deriveProjectScope } from '@/modules/project/context/ProjectScope'
import { ProjectSharePanel } from './ProjectSharePanel'

const shareSchema = z.object({
  email: z.string().min(1, 'Enter the recipient email').regex(EMAIL_RE, 'Enter a valid email'),
  permission_level: z.enum(['viewer', 'editor']),
})
type ShareValues = z.infer<typeof shareSchema>

export function ProjectShareDrawer() {
  const { shareOpen } = ProjectDrawer
  const { mutating, project } = ProjectDetail
  // Listing/revoking shares is owner-only + web-only (desktop is single-user) — the same
  // gate the panel carried on the old detail page. Defensive: the card ⋮ menu already only
  // offers "Share" to an owner on web.
  const canManageShares = deriveProjectScope(project).isOwner && !isDesktop()
  const form = useForm<ShareValues>({
    resolver: zodResolver(shareSchema),
    defaultValues: { email: '', permission_level: 'viewer' },
  })

  const close = () => {
    ProjectDrawer.closeShare()
    form.reset({ email: '', permission_level: 'viewer' })
  }

  // The drawer is now the share MANAGEMENT surface (invite + who-it-is-shared-with +
  // revoke), not a one-shot invite form, so a successful invite RESETS the form and stays
  // open — the new recipient appears in the list below, which is the confirmation that the
  // invite actually landed. `createShare` already refetches `shares`.
  const onSubmit = async (values: ShareValues) => {
    try {
      await ProjectDetail.createShare(values.email, values.permission_level)
      message.success('Invitation sent')
      form.reset({ email: '', permission_level: 'viewer' })
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to share')
    }
  }

  return (
    <Drawer
      title={project ? `Share "${project.name}"` : 'Share project'}
      open={shareOpen}
      onClose={close}
      size={480}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="project-share-cancel">
            Cancel
          </Button>
          <Button type="submit" form="project-share-form" loading={mutating} data-testid="project-share-submit">
            Send invite
          </Button>
        </div>
      }
    >
      <Form
        name="project-share-form"
        form={form}
        layout="vertical"
        onSubmit={onSubmit}
        data-testid="project-share-form"
      >
        <FormField name="email" label="Recipient email" required>
          <Input placeholder="colleague@example.com" data-testid="project-share-email" />
        </FormField>
        <FormField name="permission_level" label="Permission">
          <Select
            data-testid="project-share-level"
            options={[
              { label: 'Viewer (read-only)', value: 'viewer' },
              { label: 'Editor (edit + attach datasets)', value: 'editor' },
            ]}
          />
        </FormField>
      </Form>

      {/* Who this project is already shared with, + revoke. */}
      {canManageShares ? (
        <div className="mt-6">
          <ProjectSharePanel />
        </div>
      ) : null}
    </Drawer>
  )
}
