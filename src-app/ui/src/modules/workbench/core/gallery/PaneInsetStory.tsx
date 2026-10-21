// Gallery STORY for the pane's own chrome: EVERY pane kind's REAL `PaneBody`, one frame each.
//
// It lives beside `DeclarativeFixtureStories` (and is spread into `modules/workbench/gallery.tsx`
// the same way) because it is the same kind of thing: a surface that mounts production shell code
// against a seeded fake host so a LAYOUT property can be measured in a real browser.
//
// WHY IT EXISTS. A pane's content inset and its scroll track are SHELL properties, and both were
// previously unmeasurable: `PaneBody` applied no inset at all, so each renderer picked its own
// (`p-2`×14, `p-4`×6, `p-6`×4, `p-1`×1 across the pane renderers and the declarative render
// surfaces) and the drift re-created itself with every new pane. jsdom cannot tell those apart —
// Tailwind is not compiled there and no layout is performed — so the guard has to render.
//
// The frame list is DERIVED from `PANE_KINDS`, never hand-written: a pane kind added tomorrow
// gets a frame tomorrow, and `tests/visual/pane-inset.spec.ts` (which reads the same vocabulary
// off the runtime registry seam) therefore measures it without anyone remembering to.
//
// The frame is deliberately WIDER than the declarative form column's own `max-w-lg` cap: a
// scroll track capped narrower than its pane draws its scrollbar in the middle of the pane, and
// at any narrower frame the two are the same box and the defect is invisible.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { PaneBody } from '@/modules/workbench/core/shell/regions/RegionShell'
import { PANE_KINDS } from '@/modules/workbench/core/shell/dock/paneModel'

const GALLERY_EXTENSION_ID = 'cyto.workbench.pane-inset-gallery'
const PROJECT_ID = 'wb-gallery-pane-inset'

/** Wider than the form column's `max-w-lg` (512px) cap — see the header. */
export const PANE_INSET_FRAME_PX = 760
const PANE_INSET_FRAME_HEIGHT_PX = 260

const PaneInsetFrames: LazyExoticComponent<ComponentType> = lazy(async () => {
  // An EMPTY fake host, deliberately: what is measured here is the pane's own chrome — the
  // inset the shell supplies and the scroll track it hands the renderer — and every renderer
  // draws that chrome around its empty state exactly as it draws it around a populated one.
  // (Populated declarative panes are measured on their own surfaces, `DeclarativeFixtureStories`.)
  const api = createWorkbenchApi(makeFakeHost({ projectId: PROJECT_ID }), GALLERY_EXTENSION_ID)
  const Frame: ComponentType = () => (
    <div className="flex flex-col gap-4" data-testid="workbench-gallery-frame">
      <WorkbenchProvider api={api} projectId={PROJECT_ID} viewId={`gallery-${PROJECT_ID}`} canEdit>
        {PANE_KINDS.map(kind => (
          <div key={kind} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{kind}</span>
            <div
              className="flex overflow-hidden rounded-md border border-border"
              style={{ width: PANE_INSET_FRAME_PX, height: PANE_INSET_FRAME_HEIGHT_PX }}
              data-testid={`pane-inset-frame-${kind}`}
            >
              {/* TITLED, deliberately. The pane HEADER is shell chrome with three measurable
                  claims of its own — it must span the pane edge to edge, its close must exist
                  for every kind, and the body below it must be cleared by the shell's inset —
                  and an untitled frame can measure none of them. It is also the shape a pane
                  takes in the side regions, where most panes live. */}
              <PaneBody pane={{ id: `inset-${kind}`, kind }} titled />
            </div>
          </div>
        ))}
      </WorkbenchProvider>
    </div>
  )
  return { default: Frame }
})

export interface PaneInsetSurface {
  slug: string
  title: string
  note: string
  path: string
  initialPath: string
  component: LazyExoticComponent<ComponentType>
}

/** The single seeded surface `modules/workbench/gallery.tsx` spreads into its `seeded:` array. */
export const paneInsetSurfaces: PaneInsetSurface[] = [
  {
    slug: 'workbench-pane-inset',
    title: 'Workbench — every pane kind’s content inset + scroll track',
    note:
      'The REAL PaneBody for every kind in the registry, in a pane wider than the declarative form ' +
      'column’s own cap. The pane’s inset and its scroll track are shell properties, measured here ' +
      '(tests/visual/pane-inset.spec.ts + pane-scroll.spec.ts) rather than asserted as class strings.',
    path: '/dev/workbench-pane-inset',
    initialPath: '/dev/workbench-pane-inset',
    component: PaneInsetFrames,
  },
]
