// registry.ts — the Visualization Showcase story registry (ITEM-66). Every capability
// registers a Story; the catalog UI + the story-completeness gate read this. Stories are
// grouped by category (view-kinds, controls, grid, overlays, selection, export, pop-out,
// scale/perf, states). Auto-discovered stories are added by import side-effect.

import type { ComponentType } from 'react'

export type StoryCategory =
  | 'Overview'
  | 'View kinds'
  | 'Color / legend / colorbar'
  | 'Controls'
  | 'Grid + resize'
  | 'Overlays'
  | 'Selection'
  | 'Export'
  | 'Pop-out'
  | 'Scale / perf'
  | 'States'

export interface Story {
  id: string
  category: StoryCategory
  title: string
  /** the view-kind / control / overlay this story exercises (completeness gate key). */
  covers?: string
  Component: ComponentType
}

const REGISTRY: Story[] = []

/** Register a story — idempotently under HMR (CONV-21).
 *
 *  WHY THIS IS NOT A PLAIN THROW. It used to throw unconditionally on a repeated id, which made the
 *  whole e2e suite non-deterministic: `run-all.mjs` drives ~20 specs sequentially against ONE
 *  long-lived dev server, and as the module graph evolves across those requests Vite re-executes a
 *  story module, re-running its top-level `registerStory(...)` with the SAME id. The throw then
 *  crashed the showcase for whichever spec happened to be loading — landing on a DIFFERENT spec each
 *  run. Convergence-4 measured it on BOTH trees: the branch's full run gave 15/5 where 4 of the 5
 *  passed in isolation, and the same one-server run on `origin/main` gave 17/2, failing a spec that
 *  passes on the branch. It had already caused two misclassifications, and it meant
 *  `npm run test:e2e` was not a trustworthy green/red signal on either tree.
 *
 *  A module re-execution is not an authoring mistake, so where HMR exists the newest definition
 *  REPLACES the old one — which is also what a developer editing a story expects to see. The
 *  authoring guard the throw actually existed for — two DIFFERENT stories claiming one id — is not
 *  weakened: `import.meta.hot` is undefined under vitest/node and in a production build, so the
 *  throw still fires there, and `registry.test.ts` pins uniqueness across the real story set
 *  deterministically rather than incidentally. */
export function registerStory(story: Story): void {
  const at = REGISTRY.findIndex(s => s.id === story.id)
  if (at !== -1) {
    // Dev/HMR: a module re-executed. Replace in place, preserving registration order.
    if (import.meta.hot) {
      REGISTRY[at] = story
      return
    }
    throw new Error(`duplicate showcase story id: ${story.id}`)
  }
  REGISTRY.push(story)
}

export function allStories(): readonly Story[] {
  return REGISTRY
}

export function storiesByCategory(): Map<StoryCategory, Story[]> {
  const map = new Map<StoryCategory, Story[]>()
  for (const s of REGISTRY) {
    const arr = map.get(s.category) ?? []
    arr.push(s)
    map.set(s.category, arr)
  }
  return map
}
