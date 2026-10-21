// main.tsx — Visualization Showcase entry (dev-only; reached ONLY from
// viz-showcase.html, never imported by the app's main.tsx, so it tree-shakes out of
// prod). Auto-discovers every `stories/*.story.tsx` (side-effect registration) then
// mounts the catalog.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ShowcaseApp } from './ShowcaseApp'
import { installSingletonResidueProbe } from './singletonResidue'
// Tailwind + @ziee/kit tokens for the standalone showcase (so the kit-based in-cell controls render).
import './showcase.css'

// Cross-story contamination probe: exposes how far the MODULE-SINGLETON viz stores have drifted
// from a never-touched set. Installed BEFORE the first story mounts so a landing-story write is
// visible to `tests/viz-e2e/story-isolation.spec.ts`. See `singletonResidue.ts`.
installSingletonResidueProbe()

// side-effect import: each story file calls registerStory() at module load.
const storyModules = import.meta.glob('./stories/*.story.tsx', { eager: true })
void storyModules

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <StrictMode>
      <ShowcaseApp />
    </StrictMode>,
  )
}
