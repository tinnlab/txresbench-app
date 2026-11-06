/**
 * txrrun — the E screen's group filter chips (PROV-UI-RUN-2's
 * `buildGroupChips`, TEST-RUN-09; ITEM-4).
 *
 * The shared list (`txrlist`) renders host-controlled chips: the group
 * filter row on E (`Busy.dc.html`'s Response call / Response probability /
 * Static risk / Dynamic risk) is the HOST's data, because the row contract
 * deliberately carries no group id — only the chip label/tone (DEC-8). So
 * this module derives the chips' STATIC facts from ONE `MethodCatalogue.list`
 * payload (the module fetches the list itself; full list is bounded, no
 * pagination per PROV-MC-2) and the host wires the two stateful fields:
 *
 * - `id` — the method group (the filter's identity);
 * - `label` — the group's label on the method-summary payload;
 * - `count` — the group's methods WITHIN the set the host passes (the
 *   status-filtered set — a count that matches what the list shows);
 * - a group with ZERO methods in that set renders NO chip (TEST-RUN-09's
 *   zero-count rule — an empty filter is never offered);
 * - `active` / `onToggle` — the host's state (the host controls the filter:
 *   the chip toggles the host's grouped view; the baked-in values here are
 *   the inert defaults the host replaces).
 *
 * The chip order is the board's order — which is also the generated
 * `MethodGroup` enum order.
 */
import type { MethodSummary } from '@/api-client/types'
import type { TxrFilterChip } from '@/modules/txrlist/types'

/** The board's four group chips, in the board's order (Busy.dc.html). */
const GROUP_ORDER: MethodSummary['group'][] = [
  'response-call',
  'response-probability',
  'static-risk',
  'dynamic-risk',
]

export function buildGroupChips(methods: MethodSummary[]): TxrFilterChip[] {
  const chips: TxrFilterChip[] = []
  for (const group of GROUP_ORDER) {
    const members = methods.filter(method => method.group === group)
    if (members.length === 0) continue
    chips.push({
      id: group,
      label: members[0].group_label,
      count: members.length,
      active: false,
      onToggle: () => {},
    })
  }
  return chips
}
