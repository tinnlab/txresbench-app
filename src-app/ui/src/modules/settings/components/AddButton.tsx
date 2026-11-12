import { Plus } from 'lucide-react'
import { Button } from '@txresbench/kit'

interface AddButtonProps {
  onClick?: () => void
  /** Accessible name + tooltip (e.g. "Add server"). REQUIRED — the button is icon-only. */
  label: string
  /**
   * WHY adding is unavailable. Presence means unavailable and the string IS the reason —
   * the `removeBlockedReason` idiom, not a boolean plus a message that can disagree with it.
   *
   * This REPLACED a bare `disabled?: boolean`, which no caller ever passed. That prop was a
   * loaded gun with no user: this button is ICON-ONLY, so its tooltip is its only visible
   * identity, and a natively `disabled` button can open no tooltip at all — the first caller
   * to reach for it would have shipped a grey square that said neither what it does nor why it
   * refused, with every lint, type and tooltip-marker check still green. The shape that fails
   * that way is now unrepresentable here.
   */
  disabledReason?: string
  /** Unique test selector (required — the kit Button enforces data-testid). */
  'data-testid': string
}

// The ONE convention for a list/card "add" affordance: a compact icon-only `+`
// PRIMARY (accent) button with a tooltip — deliberately prominent. Replaces the
// mix of bare `<Plus>` icons and "Add X" text buttons that varied per page.
export function AddButton({ onClick, label, disabledReason, 'data-testid': testid }: AddButtonProps) {
  return (
    <Button
      size="icon"
      variant="default"
      icon={<Plus aria-hidden="true" />}
      tooltip={label}
      aria-label={label}
      unavailableReason={disabledReason}
      onClick={onClick}
      data-testid={testid}
    />
  )
}
