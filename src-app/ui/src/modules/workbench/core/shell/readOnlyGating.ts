// Viewer read-only gating (ITEM-29) + pop-out chrome role (ITEM-30) — the pure
// predicates the panes/frame gate their affordances with, so a rule is one testable place
// rather than scattered inline `canEdit &&` chains that silently drift. `canEdit` is the
// per-project role (owner/editor, from `WorkbenchContext`), DISTINCT from the coarse RBAC
// `jobs::use`/`projects::use` the actions carry.
//
// ── WHAT `canEdit` IS NOT ────────────────────────────────────────────────────────────────
//
// `jobStopVisible(isActiveJob, canEdit)` used to live here, and it was the defect this file
// exists to prevent, committed in the file that prevents it: a SECOND, client-side copy of an
// authorization rule. Stopping a job is not the edit right — it is the creator, the owner of
// the dataset/project the job is scoped to, or an admin. So the predicate both over- and
// under-answered: a third-party EDITOR was offered a Stop the server refuses with a 403, and
// an OWNER who is not an editor was shown nothing at all. The server now STATES the answer
// per row (`JobListItem.can_stop` / `JobDetail.can_stop`) and the surfaces render it; see
// `modules/jobs/stopAuthority`. Do not reintroduce a role-derived stop gate here.

import { PRIMARY_CONTAINER, type ContainerId } from '@ziee/dock'

/**
 * A launcher row OPENS THE ANALYSIS' FORM — it does not enqueue anything (`analysis.launch`,
 * `mutating: false`; Run inside the form is the mutation). So it is enabled purely on whether
 * the analysis is launchable, and NOT on `canEdit`.
 *
 * It used to be `launchable && canEdit`, which put a viewer's refusal on the wrong control: the
 * row that opens a form said "viewers cannot launch analyses", while the panel it would have
 * opened already carries the refusal that is actually true ("viewers cannot RUN analyses") on
 * the control that is actually refused. A viewer deciding whether to ask for edit access could
 * not read the parameters they were asking about.
 *
 * `canEdit` is retained in the signature — dropping it would silently unhook every call site
 * from the role, and the argument being IGNORED here is the point being made, so it is stated
 * rather than deleted. (Its one-time mutating sibling, `jobStopVisible`, is gone — see the
 * header: stopping a job was never the edit right, and the server states that answer itself.)
 */
export function launcherRowEnabled(launchable: boolean, _canEdit: boolean): boolean {
  return launchable
}

/** The per-container pane-chrome action (ITEM-30): a pane in the MAIN window offers
 *  "pop out"; a pane already in a popup window offers "return to main" (never a
 *  redundant second pop-out). Layout ops are per-user, so this is NOT `canEdit`-gated. */
export function paneChromeAction(containerId: ContainerId): 'popout' | 'return' {
  return containerId === PRIMARY_CONTAINER ? 'popout' : 'return'
}
