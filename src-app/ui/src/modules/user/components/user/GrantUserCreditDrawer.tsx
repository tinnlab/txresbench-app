import { useState } from 'react'
import { z } from 'zod'
import {
  Alert,
  Button,
  DatePicker,
  Form,
  FormField,
  Input,
  InputNumber,
  message,
  useForm,
  zodResolver,
} from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { GrantUserCreditDrawer as GrantUserCreditDrawerStore } from '@/modules/user/components/user/GrantUserCreditDrawer.store'
import { dollarsToCents } from '@/modules/billing/lib/money'
import { runAction } from '@/core/actions/defineAction'

/** Build the `user.grantUserCredit` action params from the typed form values —
 *  dollars → integer cents (INV-4), and a 'yyyy-MM-dd' expiry → end-of-day ISO so the
 *  grant is valid through the chosen day. Pure + exported for tests. Mirrors
 *  `billing/components/GrantCreditDrawer.tsx#buildGrantParams`. */
export function buildUserGrantParams(
  accountId: string,
  values: { amount_dollars: number; reason: string; expires_on?: string },
): { account_id: string; amount_cents: number; reason: string; expires_at?: string } {
  const expires_at = values.expires_on
    ? new Date(`${values.expires_on}T23:59:59Z`).toISOString()
    : undefined
  return {
    account_id: accountId,
    amount_cents: dollarsToCents(values.amount_dollars),
    reason: values.reason,
    ...(expires_at ? { expires_at } : {}),
  }
}

const grantSchema = z.object({
  // Collected in DOLLARS (INV-4) — converted to integer cents on submit.
  amount_dollars: z
    .number({ message: 'Enter an amount in dollars' })
    .positive('Amount must be greater than $0'),
  reason: z.string().min(1, 'A reason is required'),
  // DatePicker emits a 'yyyy-MM-dd' string (or '' when cleared).
  expires_on: z.string().optional(),
})
type GrantValues = z.infer<typeof grantSchema>

/**
 * Per-user grant-credit drawer (#43). TYPED fields only (DEC-3) — amount in DOLLARS
 * (converted to cents), a required reason, and an OPTIONAL expiry date; never a
 * raw-JSON textarea. Submitting drives the `user.grantUserCredit` `defineAction`
 * (AI-drivable, INV-2), which delegates to the Users store's
 * `grantPersonalAccountCredit` (SaasApiClient + list refetch). Mirrors
 * `modules/billing/components/GrantCreditDrawer.tsx`.
 */
export function GrantUserCreditDrawer() {
  const { isOpen = false, accountId = null, label = '' } = GrantUserCreditDrawerStore
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<GrantValues>({
    resolver: zodResolver(grantSchema),
    defaultValues: { amount_dollars: undefined as unknown as number, reason: '', expires_on: '' },
  })

  const close = () => {
    GrantUserCreditDrawerStore.close()
    form.reset()
  }

  const handleSubmit = async (values: GrantValues) => {
    if (!accountId) return
    try {
      setSubmitting(true)
      const res = await runAction(
        'user.grantUserCredit',
        buildUserGrantParams(accountId, values),
      )
      if (!res) return
      message.success('Credit granted')
      close()
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to grant credit')
    } finally {
      setSubmitting(false)
    }
  }

  const today = new Date()

  return (
    <Drawer
      title={label ? `Grant credit — ${label}` : 'Grant credit'}
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
            data-testid="user-grant-credit-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="user-grant-credit-form"
            loading={submitting}
            data-testid="user-grant-credit-submit"
          >
            Grant
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <Alert
          tone="info"
          title="Overage credit"
          description="A positive credit lets this user's personal account run past its plan quota by the granted amount. It affects admission only — not the Stripe invoice."
          className="mb-3"
          data-testid="user-grant-credit-info"
        />
        <Form
          name="user-grant-credit-form"
          form={form}
          layout="vertical"
          onSubmit={handleSubmit}
          data-testid="user-grant-credit-form"
        >
          <FormField
            name="amount_dollars"
            label="Amount (USD)"
            required
            description="The credit amount in US dollars."
          >
            <InputNumber
              min={0.01}
              step={0.01}
              prefix="$"
              className="w-full"
              placeholder="0.00"
              data-testid="user-grant-credit-amount"
            />
          </FormField>
          <FormField name="reason" label="Reason" required>
            <Input
              placeholder="Why this credit is granted"
              data-testid="user-grant-credit-reason"
            />
          </FormField>
          <FormField
            name="expires_on"
            label="Expires"
            description="Optional — leave empty for a grant that never expires."
          >
            <DatePicker
              placeholder="No expiry"
              minDate={today}
              data-testid="user-grant-credit-expiry"
              aria-label="Expiry date"
            />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
