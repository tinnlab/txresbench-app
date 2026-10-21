// stopAuthority — the ONE sentence a refused Stop control says, and the ONE place a
// client is allowed to learn whether a Stop is permitted.
//
// SIGHT AND STOP ARE DIFFERENT RIGHTS. An editor of the dataset/project a job runs on may
// LIST that job; only the job's CREATOR, the OWNER of the scope it runs on, or an admin may
// STOP it. That rule lives in the server and nowhere else: `GET /api/jobs` states it per row
// as `JobListItem.can_stop` and `GET /api/jobs/{id}` states it as `JobDetail.can_stop`. A
// surface renders THAT answer. It does not compare `job.owner_id` to the current user, and it
// does not stand in a per-project role (`canEdit`) as a proxy — a second copy of an
// authorization rule is a copy that drifts, and this one had already drifted into showing a
// Stop button to people the server refuses.
//
// `can_stop` says NOTHING about whether the job is still RUNNING (stopping a finished job is a
// 409, not a 403), so every call site keeps its own `queued|running` status check as the
// separate question of whether a Stop control exists at all.

/**
 * WHY a Stop control is unavailable, in the user's words. One string, used by every Stop
 * affordance (the jobs drawer list + detail, the workbench Jobs pane list + detail, the
 * analysis run console) so a user meets the same explanation wherever they meet the refusal.
 */
export const JOB_STOP_UNAVAILABLE_REASON =
  "Only this run's creator or the owner of the dataset or project it runs on can stop it"

/**
 * The kit `Button`'s `unavailableReason` for a Stop control, from the server's answer.
 *
 * `undefined` (available) when the server said yes; the reason string when it said no. The
 * control is VISIBLE either way — a refusal a user cannot see is a refusal they cannot act on
 * (they cannot ask the owner for something they never learned exists).
 */
export function jobStopUnavailableReason(canStop: boolean): string | undefined {
  return canStop ? undefined : JOB_STOP_UNAVAILABLE_REASON
}
