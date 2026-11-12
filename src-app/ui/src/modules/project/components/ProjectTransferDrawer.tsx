import { z } from 'zod'
import { Button, Form, FormField, Input, message, useForm, zodResolver } from '@txresbench/kit'
import { Drawer } from '@txresbench/shell'
import { ProjectDrawer } from '@/modules/project/stores/ProjectDrawer.store'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { EMAIL_RE } from '@/lib/validation'

const transferSchema = z.object({
  email: z.string().min(1, 'Enter the new owner email').regex(EMAIL_RE, 'Enter a valid email'),
})
type TransferValues = z.infer<typeof transferSchema>

export function ProjectTransferDrawer() {
  const { transferOpen } = ProjectDrawer
  const { mutating, project } = ProjectDetail
  const form = useForm<TransferValues>({
    resolver: zodResolver(transferSchema),
    defaultValues: { email: '' },
  })

  const close = () => {
    ProjectDrawer.closeTransfer()
    form.reset({ email: '' })
  }

  const onSubmit = async (values: TransferValues) => {
    try {
      await ProjectDetail.createTransfer(values.email)
      message.success('Transfer request sent')
      close()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to request transfer')
    }
  }

  return (
    <Drawer
      title={project ? `Transfer "${project.name}"` : 'Transfer ownership'}
      open={transferOpen}
      onClose={close}
      size={480}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="project-transfer-cancel">
            Cancel
          </Button>
          <Button type="submit" form="project-transfer-form" loading={mutating} data-testid="project-transfer-submit">
            Request transfer
          </Button>
        </div>
      }
    >
      <Form
        name="project-transfer-form"
        form={form}
        layout="vertical"
        onSubmit={onSubmit}
        data-testid="project-transfer-form"
      >
        <p className="mb-3 text-sm text-muted-foreground">
          The new owner will be notified and must accept. When they do, you lose
          ownership of this project.
        </p>
        <FormField name="email" label="New owner email" required>
          <Input placeholder="new-owner@example.com" data-testid="project-transfer-email" />
        </FormField>
      </Form>
    </Drawer>
  )
}
