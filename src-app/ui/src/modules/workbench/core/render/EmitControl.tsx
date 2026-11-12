// THE EMIT CONTROL — the one ▶ every section in the Visualize pane draws on its rows.
//
// ── Why this file exists (owner, ledger #33) ─────────────────────────────────────────────────
//
//   *"why the visualize button in entry do not have border but in Color by have it, the
//    coordinates too"*
//
// Three sections drew this control and three call sites decided how. The entry-axis section's
// (`EntryListWidget`) and § Coordinates' (`ArtifactRefWidget`) each hand-wrote
// `variant="ghost"`; the column section's rows were `table` tiles, and the table's generic row-button
// renderer defaults `variant` to `default` — a filled, bordered button. Nothing was wrong at any
// one site: each looked at its own file and picked something reasonable, and the pane ended up
// spelling one verb three ways.
//
// FIXING THE THREE CALL SITES WOULD LEAVE THE FOURTH FREE TO DIFFER, which is the whole content
// of the ledger row: *"make it a shared control so a fourth section cannot diverge"*. So the
// control is a component, the variant is ITS decision and not a prop, and a new section that
// wants a ▶ gets this one or writes something that is visibly not a ▶.
//
// ── What it decides, and what it refuses to take from a caller ───────────────────────────────
//
//   · THE GLYPH is the canvas's own `ScatterChart` — the pane-kind icon of the surface a press
//     lands on (`shell/dock/paneIcons.ts`), not a transport ▶. A transport glyph promises a
//     thing that starts, runs and finishes; this draws a picture, and pressing it again draws a
//     second one. The argument is `ROW_ACTION_ICONS`' (extensions/widgets/renderers.tsx) and it
//     is not restated per site any more — that registry now routes its `plot` icon here.
//   · THE VARIANT is `ghost`, i.e. borderless — the owner named the entry-axis section's as the one to keep,
//     and it is also the house rule for peer icon-only buttons in one chrome cluster
//     (`@txresbench/kit` button.tsx's variant policy). It is not a prop: a caller that could pass
//     `outline` is a caller that can re-create the divergence.
//   · THE NAME carries the ROW, never the verb alone. Forty rows called "Plot" are forty
//     indistinguishable controls to a screen-reader or voice user. Both `aria-label` and
//     `tooltip` are passed explicitly and identically, so the control is named to every channel
//     — an icon-only button with a name but no tooltip is legible to everything except the
//     pointer user looking straight at it.
//   · THE SIZE is `size-7` (28px), one step under kit's `size="icon"` default of `size-8`.
//     Ledger #31 — *"each row in the group and values are too tall"* — is a claim about ROW
//     HEIGHT, and in a list whose rows are one line of 13px text the tallest thing on the row is
//     this button: it, not the text, is what sets the row's height. So the row is shortened
//     where the height actually comes from. It stays a comfortable pointer target and the pane
//     is a dense desktop rail; the mobile sheet's own touch minimums are the SHEET's (the drag
//     grip carries a 44px target of its own) and are unaffected.
//   · THE REFUSAL rides `unavailableReason`, which is kit's "the string IS the reason" idiom: a
//     refused control stays hoverable and focusable and says why, where a natively `disabled`
//     one parks the reason somewhere unreachable. A non-empty reason also drops the click, here,
//     once — so no call site can forget that half.

import * as React from 'react'
import { ScatterChart } from 'lucide-react'

import { Button } from '@txresbench/kit'

/** The icon NAME a declaration uses to ask for this control (`icon: plot` in a view spec). */
export const EMIT_ICON = 'plot'

export interface EmitControlProps {
  /** the row's testid stem — the caller's, because only it knows the addressing scheme. */
  'data-testid': string
  /**
   * What this press is a picture OF — the ROW's own name, already qualified by whoever knows
   * whether it is contested. It becomes both the accessible name and the tooltip.
   */
  name: string
  /** why the press refuses, or `undefined`. A non-empty string IS the refusal. */
  refusal?: string
  onPress: () => void
}

/**
 * The pane's one emit control. Used by `EntryListWidget` (the entry-axis section and, since ledger #32,
 * The column section), by `ArtifactRefWidget`'s per-option `row_action` (§ Coordinates), and by the
 * generic table row-button renderer whenever a view declares {@link EMIT_ICON}.
 */
export function EmitControl({
  'data-testid': testid,
  name,
  refusal,
  onPress,
}: EmitControlProps): React.ReactElement {
  const reason = refusal !== undefined && refusal.trim() !== '' ? refusal : undefined
  return (
    <Button
      size="icon"
      variant="ghost"
      // `size-7` REPLACES kit's `size-8` — `cn`'s twMerge drops the conflicting base class
      // rather than racing it. See the header for why the height is the button's to give back.
      className="size-7"
      icon={<ScatterChart />}
      data-testid={testid}
      aria-label={name}
      tooltip={reason ?? name}
      unavailableReason={reason}
      onClick={(e: React.MouseEvent) => {
        // A row in § Coordinates is a CHOICE and a VERB at once: kit's radio renders an
        // option's content inside the `<label>` that activates the choice, so an unguarded
        // press here would ALSO move the frame — silently rescoping every other section as a
        // side effect of asking for a picture. Suppressed HERE rather than at that one call
        // site, because the next section to put this control inside an activating element
        // would have to rediscover it, and the suppression costs nothing anywhere else (a
        // button in a plain list has no default action to prevent and no ancestor listening).
        e.preventDefault()
        e.stopPropagation()
        if (reason !== undefined) return
        onPress()
      }}
    />
  )
}
