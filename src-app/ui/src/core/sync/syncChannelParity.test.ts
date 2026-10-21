// A SYNC CHANNEL MUST HAVE BOTH ENDS.
//
// ── The failure this exists to make impossible ───────────────────────────────────────
//
// `SyncEntity` is an enum on the server and an EventBus key space on the client, and the
// two halves are wired in different files, in different languages, usually in different
// changes. Nothing connected them, so the tree accumulated channels with exactly one end
// and no symptom to point at either:
//
//   • `sync:job` — `Jobs.store` subscribed; `jobs/seams.rs` installed `NoopJobSyncSink`,
//     so all six `publish_job_changed` call sites were dead. Its own header said the
//     Noop would be "swapped at merge"; the merge happened, the swap did not.
//   • `sync:job_settings` — `JobSettings.store` subscribed; `SyncEntity::JobSettings` had
//     zero call sites in the entire backend.
//   • `sync:user` / `sync:group` — `Users.store` / `UserGroups.store` subscribed; neither
//     entity was published in ANY layer (the app's user handlers emitted nothing, and
//     ziee-auth has no `AuthSyncEntity::User`/`::Group` call site).
//   • `sync:provenance_verification` — published on every verification's terminal state,
//     with zero subscribers anywhere.
//
// A subscription with no publisher is a refresh that can never happen. A publisher with
// no subscriber is fan-out nobody reads. Both look exactly like working code.
//
// ── How this is checked, and the honesty rule it enforces ────────────────────────────
//
// PUBLISHED is derived from `src-app/server/src` ONLY — the layer that owns the real
// `publish`. That is deliberate and load-bearing, and the reason is worth keeping even
// though the specific case that motivated it is now fixed:
//
//   `sdk/crates/ziee-auth` calls `ctx.sync.publish(...)` for `Profile` / `SessionSettings`
//   / `Session` / `AuthProvider`, and for a long time every one of those was DROPPED —
//   `AuthModule::init` hard-coded `NoopAuthSyncSink` and offered no injection point.
//   Counting an SDK call site as "published" would have been exactly the lie this file
//   exists to refuse.
//
// The SDK now REQUIRES the app to declare its wiring (`install_auth_sync_sink` or
// `declare_auth_sync_inert`, and `AuthModule::init` refuses to boot without one), and this
// app installs a real sink in `src-app/server/src/modules/sync/auth_sink.rs`. Those
// entities therefore scan as published FROM THE APP LAYER, which is the honest reason —
// the mapping arms are app code and they are reached. The scan rule is unchanged: an SDK
// publish only counts once an app-side sink maps it.
//
// The ALLOW_LIST is for a channel that is genuinely one-sided, and every entry names WHY
// and WHAT would remove it. It is a ratchet: a STALE entry (one whose channel is no
// longer one-sided) FAILS, so an allowance cannot silently outlive the problem it
// described.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO_ROOT = path.resolve(UI_ROOT, '../..')
const SERVER_SRC = path.join(REPO_ROOT, 'src-app/server/src')
const SYNC_EVENT_RS = path.join(SERVER_SRC, 'modules/sync/event.rs')
const TYPES_TS = path.join(UI_ROOT, 'src/api-client/types.ts')

/** Roots scanned for `on('sync:<entity>')` subscriptions. */
const SUBSCRIBER_ROOTS = [
  path.join(UI_ROOT, 'src'),
  path.join(REPO_ROOT, 'sdk/packages'),
]

// ── the allow-list ──────────────────────────────────────────────────────────────────
//
// Each entry is a channel that is one-sided ON PURPOSE, with the reason and the exit
// condition. `side` is which end EXISTS.
const ALLOW_LIST: { entity: string; side: 'published' | 'subscribed'; reason: string }[] = [
  {
    entity: 'auth_provider',
    side: 'published',
    reason:
      'PUBLISH-ONLY, and app-side-fixable. `ziee-auth`\'s admin provider routes publish ' +
      '`AuthSyncEntity::AuthProvider` on create/update/delete/test ' +
      '(sdk/crates/ziee-auth/src/auth/http/handlers.rs:2055/2140/2208/2266) to ' +
      '`perm::<AuthProvidersRead>()`, and `modules/sync/auth_sink.rs` maps it to ' +
      '`SyncEntity::AuthProvider`. The CLIENT half does not exist: this app mounts the ' +
      'admin provider ENDPOINTS (they come with `auth_admin_routes`) but ships no admin ' +
      'provider UI — `modules/auth/AuthProviders.store.ts` reads the PUBLIC list for the ' +
      'login page, whose viewer is anonymous and holds no SSE stream, so subscribing there ' +
      'would be a listener that can never fire for the admin audience. Adding it to satisfy ' +
      'symmetry is the same dishonesty as a publisher with no subscriber. Remove this entry ' +
      'when an admin auth-providers page lands and subscribes to `sync:auth_provider`.',
  },
  // TxResBench strip: the auth-membership and account UI modules are gone, so the
  // server-side publishes below have no client half. The publishes are KEPT —
  // they come from the SDK auth sink (total-by-construction mapping) and the
  // account module's own sync wiring, both of which still run — with a NAMED
  // entry each, per the ratchet above.
  ...(['profile', 'session', 'session_settings', 'user', 'group'] as const).map(entity => ({
    entity,
    side: 'published' as const,
    reason:
      'PUBLISH-ONLY after the TxResBench strip: `modules/sync/auth_sink.rs` maps ' +
      '`ziee-auth`\'s `AuthSyncEntity` for this channel onto the app wire, but the ' +
      'client stores that subscribed (`Auth.store`, `Profile.store`, `Users.store`, ' +
      '`UserGroups.store`, `SessionSettings.store`) were removed with the auth/account ' +
      'UI modules. The desktop build has one local session and no multi-device sync; ' +
      'subscribe and remove this entry when a UI for this channel ships.',
  })),
  {
    entity: 'account',
    side: 'published',
    reason:
      'PUBLISH-ONLY after the TxResBench strip: the account module (kept, degenerate ' +
      'single-owner tenancy) still emits `sync:account` / `sync:account_member` from ' +
      'its write paths, but the FE account stores that subscribed were removed with ' +
      'the account UI. Remove when an account UI subscribes.',
  },
  {
    entity: 'account_member',
    side: 'published',
    reason:
      'PUBLISH-ONLY after the TxResBench strip: the account module (kept, degenerate ' +
      'single-owner tenancy) still emits `sync:account_member` from its membership ' +
      'write paths, but the FE account stores that subscribed were removed with the ' +
      'account UI. Remove when an account UI subscribes.',
  },
  {
    entity: 'provenance_verification',
    side: 'published',
    reason:
      'PUBLISH-ONLY, deliberately. `provenance/verify/runner.rs:226` emits it on a ' +
      "verification's terminal state and `server/tests/provenance/verify_test.rs:350` " +
      'asserts the frame arrives on the owner stream — an end-to-end-tested server ' +
      'capability. The CLIENT half does not exist yet: `Provenance.verify` has zero ' +
      'frontend call sites and `ProvenanceSettingsCard.tsx:119` still reads "Reserved for ' +
      'upcoming re-run verification". Deleting the emit would delete a tested capability ' +
      'to satisfy a symmetry rule; this entry keeps the missing half visible instead. ' +
      'Remove it when the verification UI lands and subscribes.',
  },
]

// ── production Noop-sink allowances ─────────────────────────────────────────────────
//
// A publish site inside a sink implementation is only LIVE if that sink is the one
// installed. `SyncEntity::Job` sat inside a perfectly good `publish_job_changed` while
// `JobsModule::init` installed `NoopJobSyncSink`, so the entity scanned as "published"
// and the whole channel was dead — a mutation that swapped the real sink back to the Noop
// left the parity check green. So an `Arc::new(Noop*SyncSink)` anywhere in production
// server code FAILS unless it is listed here with a reason.
const ALLOWED_NOOP_SINK_SITES: { file: string; reason: string }[] = [
  {
    file: 'modules/jobs/seams.rs',
    reason:
      'The DEFENSIVE FALLBACK inside `sync_sink()` — `SYNC.get().cloned().unwrap_or_else(|| ' +
      'Arc::new(NoopJobSyncSink))` — for a process that never called `install_seams` (unit ' +
      'tests, and any future binary that does not boot `JobsModule`). It is NOT an install: ' +
      '`JobsModule::init` sets the OnceLock to `RealJobSyncSink` before any emit can run.',
  },
]

// ── scan-floor guards (ITEM-37 house rule) ──────────────────────────────────────────
//
// Both scans FAIL CLOSED. A rename that moved the sources out from under a root would
// otherwise produce an empty set on one side and a wall of "unpublished channel"
// failures — or, worse, an empty set on BOTH and a green run proving nothing.
const MIN_ENTITIES = 15
const MIN_PUBLISH_SITES = 30
const MIN_SUBSCRIPTION_SITES = 20

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, exts, out)
      continue
    }
    if (exts.some(e => entry.name.endsWith(e))) out.push(full)
  }
  return out
}

/** Drop `//` line comments so a doc comment naming an entity is not read as a call. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map(l => {
      const i = l.indexOf('//')
      return i === -1 ? l : l.slice(0, i)
    })
    .join('\n')
}

const PascalToSnake = (v: string) => v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** The `SyncEntity` variants declared in `sync/event.rs` — the single source of truth. */
function declaredEntities(): string[] {
  const src = readFileSync(SYNC_EVENT_RS, 'utf8')
  const body = src.slice(src.indexOf('pub enum SyncEntity {'))
  const decl = body.slice(0, body.indexOf('\n}'))
  return stripLineComments(decl)
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[A-Z][A-Za-z0-9]*,$/.test(l))
    .map(l => PascalToSnake(l.slice(0, -1)))
}

/** Entities named in a real `SyncEntity::X` expression under `src-app/server/src`. */
function publishedEntities(): { entities: Set<string>; sites: number } {
  const files = walk(SERVER_SRC, ['.rs']).filter(f => path.resolve(f) !== path.resolve(SYNC_EVENT_RS))
  const entities = new Set<string>()
  let sites = 0
  for (const f of files) {
    const src = stripLineComments(readFileSync(f, 'utf8'))
    for (const m of src.matchAll(/SyncEntity::([A-Z][A-Za-z0-9]*)/g)) {
      entities.add(PascalToSnake(m[1]!))
      sites += 1
    }
  }
  // `Session` has no `SyncEntity::Session` expression by construction: it is emitted
  // through `publish_session_to_users`, which names the entity internally.
  for (const f of files) {
    if (/publish_session_to_users\s*\(/.test(stripLineComments(readFileSync(f, 'utf8')))) {
      entities.add('session')
      sites += 1
    }
  }
  return { entities, sites }
}

/** Entities a client subscribes to, from `on('sync:x')` / `EventBus.on('sync:x')`. */
function subscribedEntities(): { entities: Set<string>; sites: number } {
  const files = SUBSCRIBER_ROOTS.flatMap(r => walk(r, ['.ts', '.tsx'])).filter(
    f => !/\.(test|spec)\.[cm]?tsx?$/.test(f),
  )
  const entities = new Set<string>()
  let sites = 0
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\bon\(\s*['"]sync:([a-z_]+)['"]/g)) {
      if (m[1] === 'reconnect') continue
      entities.add(m[1]!)
      sites += 1
    }
  }
  return { entities, sites }
}

/** The generated TS union — the client's half of the vocabulary. */
function tsUnionEntities(): string[] {
  const line = readFileSync(TYPES_TS, 'utf8')
    .split('\n')
    .find(l => l.startsWith('export type SyncEntity ='))
  assert.ok(line, 'no `export type SyncEntity =` in api-client/types.ts')
  return [...line.matchAll(/'([a-z_]+)'/g)].map(m => m[1]!)
}

test('the scans have not collapsed (a moved file must fail, not pass silently)', () => {
  const declared = declaredEntities()
  const pub = publishedEntities()
  const sub = subscribedEntities()
  assert.ok(
    declared.length >= MIN_ENTITIES,
    `SyncEntity scan collapsed: ${declared.length} variant(s) parsed from ${SYNC_EVENT_RS}`,
  )
  assert.ok(
    pub.sites >= MIN_PUBLISH_SITES,
    `publish scan collapsed: ${pub.sites} SyncEntity:: expression(s) under ${SERVER_SRC}`,
  )
  assert.ok(
    sub.sites >= MIN_SUBSCRIPTION_SITES,
    `subscription scan collapsed: ${sub.sites} on('sync:…') site(s) under ${SUBSCRIBER_ROOTS.join(', ')}`,
  )
})

test('the Rust SyncEntity enum and the generated TS union are the same vocabulary', () => {
  assert.deepEqual(
    [...declaredEntities()].sort(),
    [...tsUnionEntities()].sort(),
    'the enum and `api-client/types.ts` disagree — run `just openapi-regen`',
  )
})

test('every SyncEntity is BOTH published and subscribed (or allow-listed with a reason)', () => {
  const declared = declaredEntities()
  const { entities: published } = publishedEntities()
  const { entities: subscribed } = subscribedEntities()

  const allowed = (entity: string, side: 'published' | 'subscribed') =>
    ALLOW_LIST.some(a => a.entity === entity && a.side === side)

  const unpublished = declared.filter(e => !published.has(e) && !allowed(e, 'subscribed'))
  const unsubscribed = declared.filter(e => !subscribed.has(e) && !allowed(e, 'published'))

  assert.deepEqual(
    unpublished,
    [],
    'SUBSCRIBED BUT NEVER PUBLISHED — every one of these subscriptions is a refresh that ' +
      'can never happen. Publish the entity from `src-app/server/src`, delete the ' +
      'subscription, or add a NAMED ALLOW_LIST entry saying why it is one-sided: ' +
      unpublished.join(', '),
  )
  assert.deepEqual(
    unsubscribed,
    [],
    'PUBLISHED BUT NOBODY LISTENS — the server pays to fan these out and no client reads ' +
      'them. Subscribe from a store, delete the publish, or add a NAMED ALLOW_LIST entry: ' +
      unsubscribed.join(', '),
  )
})

test('no Noop sync sink is INSTALLED — a publish site inside a dead sink is dead', () => {
  const files = walk(SERVER_SRC, ['.rs'])
  const offenders: string[] = []
  let sites = 0
  for (const f of files) {
    const rel = path.relative(SERVER_SRC, f).split(path.sep).join('/')
    const src = stripLineComments(readFileSync(f, 'utf8'))
    // Drop `#[cfg(test)]` modules: a test constructing a Noop sink is a test choice, not a
    // production wiring decision. Everything from the first `#[cfg(test)]` marker on.
    const prod = src.split('#[cfg(test)]')[0]!
    for (const _ of prod.matchAll(/Arc::new\(\s*(?:[A-Za-z_]+::)*Noop[A-Za-z]*SyncSink\s*\)/g)) {
      sites += 1
      if (!ALLOWED_NOOP_SINK_SITES.some(a => a.file === rel)) offenders.push(rel)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A Noop SYNC SINK is wired in production code. Every `publish` routed through it is ' +
      'silently dropped, and the parity check above cannot see that — the entity still ' +
      'appears in the source. Install the real sink, or add a reasoned entry to ' +
      `ALLOWED_NOOP_SINK_SITES: ${offenders.join(', ')}`,
  )
  // Fail closed: if the pattern stops matching entirely, this test has become decorative
  // and the allowance below would be silently unverified.
  assert.ok(
    sites >= ALLOWED_NOOP_SINK_SITES.length,
    `Noop-sink scan collapsed: ${sites} site(s) found but ${ALLOWED_NOOP_SINK_SITES.length} allowance(s) declared`,
  )
})

test('every allow-list entry is still true (a stale allowance must fail)', () => {
  const declared = new Set(declaredEntities())
  const { entities: published } = publishedEntities()
  const { entities: subscribed } = subscribedEntities()

  for (const a of ALLOW_LIST) {
    assert.ok(a.reason.length > 80, `ALLOW_LIST entry \`${a.entity}\` needs a real reason`)
    assert.ok(declared.has(a.entity), `ALLOW_LIST names \`${a.entity}\`, which is not a SyncEntity`)
    if (a.side === 'published') {
      assert.ok(published.has(a.entity), `\`${a.entity}\` is allow-listed as publish-only but is no longer published — delete the entry`)
      assert.ok(
        !subscribed.has(a.entity),
        `STALE ALLOWANCE: \`${a.entity}\` now HAS a subscriber. Delete its ALLOW_LIST entry so the ` +
          'channel is held to the rule from here on.',
      )
    } else {
      assert.ok(subscribed.has(a.entity), `\`${a.entity}\` is allow-listed as subscribe-only but nothing subscribes — delete the entry`)
      assert.ok(
        !published.has(a.entity),
        `STALE ALLOWANCE: \`${a.entity}\` is now published from src-app/server/src. Delete its ` +
          'ALLOW_LIST entry.',
      )
    }
  }
})
