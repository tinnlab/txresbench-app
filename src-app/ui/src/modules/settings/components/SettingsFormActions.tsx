import { Button, Flex } from '@txresbench/kit'

interface SettingsFormActionsProps {
  /** Primary submit handler — wire to `form.handleSubmit(onSubmit)`. */
  onSave: () => void
  onCancel: () => void
  saving?: boolean
  /**
   * WHY the Save cannot be pressed. Presence means unavailable — the string IS the reason.
   *
   * THIS REPLACED A `saveDisabled: boolean` + OPTIONAL `saveDisabledReason` PAIR, and the
   * replacement is the point. That shape let a caller refuse the user with nothing to say, and
   * five of seven call sites did exactly that (four omitting the reason entirely, and conflating
   * "you cannot manage this" with "there is nothing to save yet" into one grey button). A channel
   * that exists and is ignored is worse than an absent one: the component reads as covered and
   * every call site reads as compliant. With one field there is no way to express "refused, no
   * reason" — the boolean that made it expressible is gone.
   *
   * It is the kit's `unavailableReason`, so the Save renders `aria-disabled` with its handler
   * dropped: still hoverable, still a tab stop, reason in the tooltip AND in `aria-describedby`.
   * The Save keeps the saturated primary variant either way (Spec B) — a greyed accent that
   * explains itself reads as intentional; a greyed weak variant reads as broken.
   */
  saveUnavailableReason?: string
  /**
   * WHY Cancel cannot be pressed. There was NO cancel channel at all, while four callers
   * disabled it (`cancelDisabled={!canManage}`) — the purest form of the class.
   *
   * Omitting it while `saving` is fine: the component supplies the reason for that case itself,
   * because "a save is in flight" is a reason the CALLER cannot phrase better than this one can.
   */
  cancelUnavailableReason?: string
  saveLabel?: string
  cancelLabel?: string
  /** Unique test selectors (required — the kit Button enforces data-testid). */
  saveTestid: string
  cancelTestid: string
}

// The ONE convention for a card's Save/Cancel actions. Rendered in the Card
// `footer` slot (never as a Separator + inline buttons in the body), with the
// secondary action as `outline` and the primary as the default (accent) button.
export function SettingsFormActions({
  onSave, onCancel, saving, saveUnavailableReason, cancelUnavailableReason,
  saveLabel = 'Save', cancelLabel = 'Cancel', saveTestid, cancelTestid,
}: SettingsFormActionsProps) {
  return (
    <Flex justify="end" gap="small" className="w-full">
      <Button
        type="button"
        variant="outline"
        onClick={onCancel}
        // A caller's reason wins; otherwise an in-flight save IS the reason. Previously
        // `disabled={cancelDisabled ?? saving}`, which took Cancel out of the tab order and told
        // nobody why — the one control a user reaches for when a save is taking too long.
        unavailableReason={
          cancelUnavailableReason || (saving ? 'Waiting for the save to finish' : undefined)
        }
        data-testid={cancelTestid}
      >
        {cancelLabel}
      </Button>
      {/* No Tooltip-on-a-focusable-span wrapper any more: that workaround existed because a
          natively `disabled` button swallows pointer events, and `unavailableReason` removes the
          native disable instead of building scaffolding around it. */}
      <Button
        type="button"
        loading={saving}
        unavailableReason={saveUnavailableReason || undefined}
        onClick={onSave}
        data-testid={saveTestid}
      >
        {saveLabel}
      </Button>
    </Flex>
  )
}
