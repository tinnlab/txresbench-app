// registry.test.ts — the AUTHORING guard for showcase story ids (CONV-21).
//
// `registerStory` used to enforce id uniqueness by THROWING at registration time. That put the
// guard on the dev server's HOT PATH, where it did the opposite of its job: Vite re-executes a
// story module as the module graph evolves, the same id re-registers, and the throw crashed the
// showcase for whichever e2e spec happened to be loading — a DIFFERENT one each run. The suite
// stopped being a trustworthy green/red signal on EITHER tree (measured by convergence-4: branch
// 15/5 with 4 of the 5 passing in isolation; `origin/main` 17/2, failing a spec that passes on the
// branch). It had already caused two misclassifications.
//
// Registration is now idempotent where HMR exists, and the real guarantee — no two DIFFERENT
// stories claim one id — is asserted HERE instead. Two complementary checks, because neither alone
// is sufficient in this package's node/vitest environment (no DOM, so the story modules themselves
// cannot be imported):
//   1. a STATIC scan of the `registerStory({ id: '…' })` literals across `stories/*.story.tsx`,
//      which is the authoring data the old throw was really policing;
//   2. a unit test proving the throw still fires outside HMR, so the guard is not merely deleted.
// (1) is strictly stronger than the old behaviour: the throw only fired if a collision happened to
// be loaded in one session, whereas this reads the whole set every run.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerStory } from './registry'

const STORIES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'stories')

/** Every `registerStory({ … id: '<literal>' … })` in the story files, with its source file.
 *  Deliberately anchored on `registerStory(` so a `dataset: { id: 'demo' }` or a `grid` entry's id
 *  cannot be mistaken for a story id — the ids this guard is about are the ones the showcase routes
 *  on and the e2e specs address by `#<id>`. */
function declaredStoryIds(): { id: string; file: string }[] {
  const out: { id: string; file: string }[] = []
  for (const file of readdirSync(STORIES_DIR).filter(f => f.endsWith('.story.tsx'))) {
    const src = readFileSync(join(STORIES_DIR, file), 'utf8')
    const re = /registerStory\(\s*\{([\s\S]*?)\}\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const id = /(?:^|[\s,{])id:\s*'([^']+)'/.exec(m[1])?.[1]
      if (id) out.push({ id, file })
    }
  }
  return out
}

describe('showcase story registry — ids are unique (CONV-21)', () => {
  it('finds the story registrations at all (the scan is not vacuous)', () => {
    // A regex that silently matched nothing would make every assertion below trivially true — the
    // failure mode this package has shipped repeatedly.
    const found = declaredStoryIds()
    expect(found.length).toBeGreaterThanOrEqual(10)
  })

  it('no two stories declare the same id', () => {
    const found = declaredStoryIds()
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const { id, file } of found) {
      const prev = seen.get(id)
      if (prev) collisions.push(`"${id}" declared in both ${prev} and ${file}`)
      else seen.set(id, file)
    }
    expect(collisions).toEqual([])
  })

  it('STILL THROWS on a genuine collision outside HMR (the guard is not weakened)', () => {
    // `import.meta.hot` is undefined under vitest, so the authoring guard is live here: only a
    // module RE-EXECUTION is forgiven, and only where HMR exists. Two different stories claiming
    // one id must still be rejected.
    const id = `__conv21_probe_${Math.random().toString(36).slice(2)}`
    const story = { id, category: 'Grid + resize' as const, title: 'probe', Component: () => null }
    expect(() => registerStory(story)).not.toThrow()
    expect(() => registerStory({ ...story, title: 'a DIFFERENT story, same id' })).toThrow(
      /duplicate showcase story id/,
    )
  })
})
