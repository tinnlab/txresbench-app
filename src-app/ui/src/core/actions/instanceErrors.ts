// Error classes a `kind: 'instance'` action's `run` throws when its target
// isn't reachable via `ctx.instance` — thrown INSIDE `run`, so they surface
// through the normal `runAction` catch path (`./engine.ts`'s `handleInvoke`
// posts them as `result.error`, same as any other action failure).
//
// Distinct from the engine's PRE-run stale-token guard (`STALE_STATE` /
// `READ_REQUIRED` — ARCHITECTURE.md Layer 6, checked BEFORE `run` is ever
// called) and from the engine's own instance-not-found short-circuit for
// mutating+stateful invokes (which never reaches `run` either). These two
// classes exist for the remaining path: a `run` that resolves via
// `ctx.instance` directly (e.g. a read action, or any action the engine
// doesn't pre-check) and finds nothing registered — ARCHITECTURE.md's
// "gone / replaced instance" case ("a stale handle can't hit the wrong
// thing").

export class InstanceNotFoundError extends Error {
  constructor(viewId: string) {
    super(`NOT_FOUND: no live instance "${viewId}"; call views.list to see live instances`)
    this.name = 'InstanceNotFoundError'
  }
}

export class InstanceHandlerMissingError extends Error {
  constructor(viewId: string, actionId: string) {
    super(`NOT_FOUND: live instance "${viewId}" registers no handler for "${actionId}"`)
    this.name = 'InstanceHandlerMissingError'
  }
}
