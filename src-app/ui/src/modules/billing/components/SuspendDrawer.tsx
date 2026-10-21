import { useState } from 'react'
import { z } from 'zod'
import { Alert, Button, Form, FormField, Input, message, useForm, zodResolver } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { SuspendDrawer as SuspendDrawerStore } from '@/modules/billing/components/SuspendDrawer.store'
import { runAction } from '@/core/actions/defineAction'

const suspendSchema = z.object({ reason: z.string().optional() })
type SuspendValues = z.infer<typeof suspendSchema>

/**
 * Suspend-account drawer (#45, ITEM-10) — an admin hold with an OPTIONAL typed
 * reason (DEC-7). Drives the `billing.suspendAccount` `defineAction`
 * (`admin::accounts`), which delegates to the store's `suspend`.
 */
export function SuspendDrawer({ accountId }: { accountId: string }) {
  const { isOpen = false } = SuspendDrawerStore
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<SuspendValues>({
    resolver: zodResolver(suspendSchema),
    defaultValues: { reason: '' },
  })

  const close = () => {
    SuspendDrawerStore.close()
    form.reset()
  }

  const handleSubmit = async (values: SuspendValues) => {
    if (!accountId) return
    try {
      setSubmitting(true)
      const res = await runAction('billing.suspendAccount', {
        account_id: accountId,
        ...(values.reason ? { reason: values.reason } : {}),
      })
      if (!res) return
      message.success('Account suspended')
      close()
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to suspend the account')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      title="Suspend account"
      open={isOpen}
      onClose={close}
      size={520}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={close}
            disabled={submitting}
            data-testid="billing-suspend-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="suspend-form"
            variant="destructive"
            loading={submitting}
            data-testid="billing-suspend-submit"
          >
            Suspend
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <Alert
          tone="warning"
          title="Admin hold"
          description="This blocks the account's compute and storage independently of its billing status. It is NOT overridable by credits or premium. Reactivate to lift it."
          className="mb-3"
          data-testid="billing-suspend-info"
        />
        <Form
          name="suspend-form"
          form={form}
          layout="vertical"
          onSubmit={handleSubmit}
          data-testid="billing-suspend-form"
        >
          <FormField
            name="reason"
            label="Reason"
            description="Optional — recorded on the account status."
          >
            <Input
              placeholder="e.g. abuse investigation"
              data-testid="billing-suspend-reason"
            />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
