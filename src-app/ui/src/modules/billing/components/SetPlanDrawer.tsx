import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Alert, Button, Form, FormField, Select, message, useForm, zodResolver } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { SaasApiClient } from '@/api-client-saas/client'
import type { PlanCatalogEntry } from '@/api-client-saas/types'
import { SetPlanDrawer as SetPlanDrawerStore } from '@/modules/billing/components/SetPlanDrawer.store'
import { BillingSubscription } from '@/modules/billing/stores/BillingSubscription.store'
import { runAction } from '@/core/actions/defineAction'

/** Plan Select options from the catalog, plus the account's current plan if it
 *  isn't in the catalog (so the Select always shows the real plan). Pure + exported
 *  for tests. */
export function planOptions(
  catalog: PlanCatalogEntry[],
  currentPlanId?: string,
): { label: string; value: string }[] {
  const ids = new Set(catalog.map(p => p.id))
  return [
    ...catalog.map(p => ({ label: p.id, value: p.id })),
    ...(currentPlanId && !ids.has(currentPlanId)
      ? [{ label: `${currentPlanId} (current)`, value: currentPlanId }]
      : []),
  ]
}

const setPlanSchema = z.object({
  plan_id: z.string().min(1, 'Please choose a plan'),
})
type SetPlanValues = z.infer<typeof setPlanSchema>

/**
 * Set-plan (admin override) drawer (#45, ITEM-9). The plan is chosen from a typed
 * Select seeded from the REAL plan catalog (`Billing.getCatalog`) — never a
 * free-text box (DEC-6). Submitting drives the `billing.setPlan` `defineAction`
 * (AI-drivable), which delegates to the store's `setPlan` (SaasApiClient +
 * refetch).
 */
export function SetPlanDrawer({ accountId }: { accountId: string }) {
  const { isOpen = false } = SetPlanDrawerStore
  const { billing = null } = BillingSubscription
  const [catalog, setCatalog] = useState<PlanCatalogEntry[]>([])
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<SetPlanValues>({
    resolver: zodResolver(setPlanSchema),
    defaultValues: { plan_id: billing?.plan_id ?? '' },
  })

  // Load the plan catalog when the drawer opens; reset the default to the current plan.
  useEffect(() => {
    if (!isOpen) return
    form.reset({ plan_id: billing?.plan_id ?? '' })
    let alive = true
    void SaasApiClient.Billing.getCatalog()
      .then(entries => {
        if (alive) setCatalog(entries)
      })
      .catch(() => {
        /* catalog is best-effort; the Select still lists the current plan below */
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const close = () => {
    SetPlanDrawerStore.close()
    form.reset()
  }

  const handleSubmit = async (values: SetPlanValues) => {
    if (!accountId) return
    try {
      setSubmitting(true)
      const res = await runAction('billing.setPlan', {
        account_id: accountId,
        plan_id: values.plan_id,
      })
      if (!res) return
      message.success(`Plan set to “${values.plan_id}”`)
      close()
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to set the plan')
    } finally {
      setSubmitting(false)
    }
  }

  const options = planOptions(catalog, billing?.plan_id)

  return (
    <Drawer
      title="Set plan (admin override)"
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
            data-testid="billing-setplan-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="set-plan-form"
            loading={submitting}
            data-testid="billing-setplan-submit"
          >
            Set plan
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <Alert
          tone="info"
          title="Admin override"
          description="This sets the plan directly, with no Stripe round-trip. The override wins over Stripe webhooks until you clear it."
          className="mb-3"
          data-testid="billing-setplan-info"
        />
        <Form
          name="set-plan-form"
          form={form}
          layout="vertical"
          onSubmit={handleSubmit}
          data-testid="billing-setplan-form"
        >
          <FormField name="plan_id" label="Plan" required>
            <Select
              options={options}
              placeholder="Select a plan"
              showSearch
              data-testid="billing-setplan-select"
              aria-label="Plan"
            />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
