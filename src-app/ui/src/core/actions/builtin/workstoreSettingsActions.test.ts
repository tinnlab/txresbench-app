// TEST-11 [covers ITEM-9] — workstore.updateSettings is a permissioned, AI-drivable
// defineAction dispatched via runAction in its settings card (not a human-only form
// submit), with the exact permission that gates the settings PUT.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import './workstoreSettingsActions' // register
import { getActionMeta, getActionRegistry } from '../defineAction'

const ID = 'workstore.updateSettings'
const PERMISSION = 'workstore::settings::manage'
const COMPONENT = 'src/modules/workstore/components/WorkstoreLimitsCard.tsx'

describe('TEST-11 — workstore.updateSettings is a permissioned, AI-drivable settings defineAction', () => {
  it('is registered, mutating, AI-surfaced with the exact permission', () => {
    const meta = getActionMeta(ID)
    expect(meta, ID + ' not registered').toBeTruthy()
    expect(meta?.permission).toBe(PERMISSION)
    expect(meta?.mutating).toBe(true)
    expect(meta?.surfaces?.ai).toBe(true)
  })
  it('is dispatched via runAction in its settings card', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')
    expect(src).toContain("runAction('" + ID + "'")
  })

  // uncapped-uploads TEST-14: the two new upload-limit knobs are part of the action's
  // typed param surface, so a save (and an AI/palette invocation) can set them; each is
  // an optional bounded integer, and the card forwards them through the SAME
  // permissioned action payload rather than an inline handler.
  it('accepts the upload-limit knobs as optional bounded integer params, rejecting out-of-range/non-integers', () => {
    const schema = getActionRegistry().get(ID)?.params
    expect(schema, 'params schema present').toBeTruthy()
    // Both new knobs accepted together, in range.
    expect(
      schema!.safeParse({ max_upload_body_bytes: 1024 * 1024 * 1024, max_upload_parts: 2048 })
        .success,
    ).toBe(true)
    // Omitting them is valid (partial update).
    expect(schema!.safeParse({}).success).toBe(true)
    // Non-integers rejected.
    expect(schema!.safeParse({ max_upload_body_bytes: 1.5 }).success).toBe(false)
    expect(schema!.safeParse({ max_upload_parts: 'lots' }).success).toBe(false)
    // Out-of-range rejected (mirrors the server `validate()` bounds).
    expect(schema!.safeParse({ max_upload_body_bytes: 1024 }).success).toBe(false) // below 1 MiB
    expect(
      schema!.safeParse({ max_upload_body_bytes: 257 * 1024 * 1024 * 1024 }).success,
    ).toBe(false) // above 256 GiB
    expect(schema!.safeParse({ max_upload_parts: 0 }).success).toBe(false) // below 1
    expect(schema!.safeParse({ max_upload_parts: 65537 }).success).toBe(false) // above 65536
  })

  // uncapped-uploads TEST-14 (cont.) — the card sends the new fields through the SAME
  // action payload, not an inline handler (ai-controllable-actions).
  it('the card forwards the upload-limit fields through the action payload', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')

    // A bare `toContain` passes if the substring appears in a comment, a type
    // declaration, or a payload sent somewhere else entirely — it does not bind the
    // fields to `workstore.updateSettings`. So isolate the runAction call and assert
    // the fields are inside THAT object literal.
    const call = src.slice(src.indexOf("runAction('workstore.updateSettings'"))
    expect(call, 'the card must call the permissioned action').not.toBe('')
    const payload = call.slice(0, call.indexOf('})') + 1)

    expect(payload).toContain('max_upload_body_bytes:')
    expect(payload).toContain('max_upload_parts:')
    // ...and the pre-existing knobs are still in the same payload, so the two new
    // fields were ADDED to the action path rather than replacing it with a partial
    // one that silently drops the others.
    expect(payload).toContain('max_output_file_bytes:')
    expect(payload).toContain('gc_enabled:')

    // No inline fetch/PUT bypassing the action (ai-controllable-actions): the human
    // path and the AI path must be the same path.
    expect(src).not.toMatch(/fetch\(|axios\.|\.put\(/)
  })

  // uncapped-uploads TEST-23 — the card must not reintroduce intent reconstruction.
  //
  // TEST-21 moved to `WorkstoreLimitsCard.upload.test.tsx`, where it renders the real
  // component and asserts the PUT payload. It had to: in this file it asserted only the
  // display helper plus arithmetic over its own constants, and a blind audit showed it
  // stayed green when the submit's `max_upload_body_bytes` was replaced with the
  // constant 999. The submit is now covered behaviourally and mutation-checked.
  //
  // What remains here is a narrow DESIGN guard. Two attempts to preserve an "untouched"
  // ceiling both shipped fail-open behaviour, so this reds if the submit stops being a
  // direct conversion. Its limits, stated rather than implied: it matches one line, so
  // a reintroduction under different identifiers would slip past it — the render test
  // is what actually catches behaviour. It is cheap and it points the next person at
  // the reasoning, which is all it is for.
  it('converts the upload ceiling directly, with no preservation heuristic', () => {
    const src = readFileSync(resolve(process.cwd(), COMPONENT), 'utf8')
    const submit = src.slice(src.indexOf('const onSubmit'))
    expect(submit).toContain('max_upload_body_bytes: Math.round(v.max_upload_body_mib * MIB)')
    // The field is MiB-granular because the server's floor for it is 1 MiB; a GiB
    // field cannot represent the bottom of its own legal range.
    expect(src).toContain('uploadBodyMibForDisplay')
  })
})
