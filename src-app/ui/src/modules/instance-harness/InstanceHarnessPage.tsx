import { useMemo, useRef, useState } from 'react'
import { Button, Card, Paragraph, Title } from '@ziee/kit'
import { createVersioned } from '@/core/actions/versioned'
import { useAction } from '@/core/actions/useAction'

// The instance-action DEMONSTRATOR page (PLAN.md ITEM-9; DECISIONS.md DEC-4).
// No rich per-analysis viz surface with real per-instance state exists yet
// (that lands with the P6/P7 workbench) — this is a small REAL component
// proving the REAL `useAction -> engine -> agent-channel -> dispatch ->
// stale-guard` path end to end (TEST-11), not a mock/no-op.
//
// A freshly-minted `view_id` (UUID, per ARCHITECTURE.md Layer 6 "never
// reused") joins the instance registry for as long as this page is mounted,
// backed by a `./core/actions/versioned.ts` container.
//
// The "Increment (local)" button and the AI-driven `harness.setValue`
// invoke apply the SAME underlying mutation (`applyValue`, below) but
// through DELIBERATELY DIFFERENT paths, modeling the correct shape for each
// caller (ARCHITECTURE.md Layer 6 — "the checkbox calls the SAME method the
// AI action calls", not the same GUARDED entry point):
//   - the human button mutates the `versioned` store DIRECTLY. A human
//     clicking a live button is acting on what's on their screen RIGHT NOW,
//     not on a possibly-stale read from earlier — there is no "expected
//     token" for a human to have gone stale, so there is nothing to guard.
//   - the AI path goes through `runAction('harness.setValue', ...)` with an
//     `expected` token from a prior `view.describe`/`harness.describe`
//     read, and picks up the engine's read-before-write / stale-state guard
//     (`../../core/actions/engine.ts`'s `checkInstanceGuard` +
//     `./instanceLock.ts`'s per-instance serialization) BEFORE this same
//     handler ever runs.
// Threading a locally-known-fresh `expected` token through `runAction` on
// the local path would be misleading: it LOOKS guarded but isn't (the
// engine's guard only ever runs on the agent-invoke path), and a live human
// action should never need to justify itself against a stale-read check.

interface HarnessState extends Record<string, unknown> {
  value: number
}

export default function InstanceHarnessPage() {
  const instanceId = useMemo(() => crypto.randomUUID(), [])
  const versionedRef = useRef(createVersioned<HarnessState>(instanceId, { value: 0 }))
  const [, forceRender] = useState(0)

  // The ONE place that actually mutates — both the AI-driven
  // `harness.setValue` handler and the local button call this, so there is
  // exactly one code path that bumps `version`/`_state_token` (see the
  // header comment: same mutation, different entry paths, not duplicated
  // logic).
  const applyValue = (value: number) => {
    versionedRef.current.set({ value })
    forceRender(n => n + 1)
    return versionedRef.current.snapshot()
  }

  useAction(instanceId, {
    type: 'harness',
    handlers: {
      'harness.setValue': params => {
        const { value } = params as { value: number }
        return applyValue(value)
      },
      'harness.describe': () => versionedRef.current.snapshot(),
    },
    getSnapshot: () => versionedRef.current.snapshot(),
  })

  const current = versionedRef.current.value
  const token = versionedRef.current.token

  const incrementLocally = () => {
    applyValue(current.value + 1)
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-6" data-testid="instance-harness-page">
      <Title level={4} className="!mb-0">
        Instance Action Harness
      </Title>
      <Paragraph className="text-sm text-muted-foreground">
        A live, useAction-registered instance surface (PLAN.md ITEM-9) — proves the AI can drive
        (and read the state of) THIS specific mounted instance via harness.setValue /
        harness.describe, with the same read-before-write / stale-state guard every instance
        action gets.
      </Paragraph>
      <Card data-testid="instance-harness-card" title="Live instance">
        <div className="flex flex-col gap-3">
          <div>
            <span className="text-sm text-muted-foreground">view_id: </span>
            <span className="font-mono text-sm" data-testid="instance-harness-view-id">
              {instanceId}
            </span>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">value: </span>
            <span className="font-mono text-sm" data-testid="instance-harness-value">
              {current.value}
            </span>
          </div>
          <div>
            <span className="text-sm text-muted-foreground">_state_token: </span>
            <span className="font-mono text-sm" data-testid="instance-harness-token">
              {token}
            </span>
          </div>
          <div>
            <Button data-testid="instance-harness-increment" onClick={incrementLocally}>
              Increment (local)
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
