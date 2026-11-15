/**
 * demo dev-gallery surfaces (demo-mode ITEM-5).
 *
 * Two kinds:
 *  · the SEEDED shell surfaces the notice-bar browser tier drives: the REAL
 *    shell (TxrLayout's TxrShell) seeded demo, at the wide byte and inside a
 *    390 frame (the plan's "at most three lines with the buttons below"
 *    measured against the shell's own width — the bar's narrow byte is a
 *    container query, so the frame width is what decides, not the browser
 *    viewport);
 *  · the STORY lane: one story per reusable component (DemoOnly /
 *    DesktopOnly / DisabledBecauseDemo / ExampleFileCard).
 *
 * The cassette answers the boot mode read with a VIEWPORT-INDEPENDENT rule:
 * `?demo=1` makes EVERY surface boot in demo mode (the route walk —
 * "present on every route in demo" — drives the real shell-route surfaces
 * with the flag), and the default is desktop (every existing surface and
 * spec keeps its desktop byte). The mode read is the store's one fetch at
 * module init — the URL is parsed before it, so the flag is already known.
 */
import { lazy, type ReactNode } from 'react'
import { Button } from '@txresbench/kit'
import type { GalleryStory, ModuleGallery } from '@txresbench/gallery'
import type { AppModeResponse } from '@/api-client/types'
import { TxrShell } from '@/modules/txrshell/TxrLayout'
import { DEMO_DISABLED_REASON } from './copy'
import { DemoOnly } from './components/DemoOnly'
import { DesktopOnly } from './components/DesktopOnly'
import { DisabledBecauseDemo } from './components/DisabledBecauseDemo'
import { ExampleFileCard } from './components/ExampleFileCard'
import { seedDemoMode } from './test-utils/demoSeed'

/** The demo wire answer the `?demo=1` flag surfaces boot with. */
const DEMO_MODE: AppModeResponse = {
  mode: 'demo',
  download_url: 'https://downloads.example.test/txresbench',
  limits: { history: 50, models: 50 },
  notice: 'Runs and models here are shared with everyone who visits the demo.',
}

/** The desktop wire answer (the gallery's default — the base cassette's own). */
const DESKTOP_MODE: AppModeResponse = {
  mode: 'desktop',
  download_url: '',
  limits: { history: 50, models: 50 },
  notice: '',
}

/** One narrow frame (the `?w=` query; default 390 — the phone byte). */
function NarrowFrame({ children }: { children: ReactNode }) {
  const w = Number(new URLSearchParams(window.location.search).get('w')) || 390
  return (
    <section data-testid="txr-demo-notice-narrow" style={{ width: w, maxWidth: '100%', minWidth: 0 }}>
      {children}
    </section>
  )
}

/** The shell with a page slot (the notice bar is the shell's own child). */
function ShellStory() {
  return (
    <TxrShell>
      <div style={{ padding: '24px 16px' }} data-testid="txr-demo-notice-slot">
        <p style={{ margin: 0 }}>The shell with a page slot — every route carries the bar.</p>
      </div>
    </TxrShell>
  )
}

const WideShellStory = lazy(() =>
  Promise.resolve({ default: () => <ShellStory /> }),
)

const NarrowShellStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <NarrowFrame>
        <ShellStory />
      </NarrowFrame>
    ),
  }),
)

/** Demo + desktop side by side on one canvas (story renders seed the mode). */
function GateCanvas() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span>
        demo: <DemoOnly><span data-testid="gallery-demo-only-child">demo child</span></DemoOnly>
        {' · '}
        <DesktopOnly><span data-testid="gallery-desktop-only-child">desktop child</span></DesktopOnly>
      </span>
      <DisabledBecauseDemo>
        <Button data-testid="gallery-disabled-control">Change files</Button>
      </DisabledBecauseDemo>
    </div>
  )
}

const stories: GalleryStory[] = [
  {
    id: 'txr-demo-gates',
    title: 'DemoOnly / DesktopOnly / DisabledBecauseDemo',
    note: 'Seeded per case: demo (the demo-only child renders, the desktop child does not, the control is disabled with the reason) and desktop (the reverse, the control untouched).',
    cases: [
      {
        key: 'demo',
        label: 'demo',
        render: () => {
          seedDemoMode('demo')
          return <GateCanvas />
        },
      },
      {
        key: 'desktop',
        label: 'desktop',
        render: () => {
          seedDemoMode('desktop')
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>
                demo: <DemoOnly><span>demo child</span></DemoOnly>
                {' · '}
                <DesktopOnly><span>desktop child</span></DesktopOnly>
              </span>
              <DisabledBecauseDemo>
                <Button data-testid="gallery-disabled-control-desktop">Change files</Button>
              </DisabledBecauseDemo>
            </div>
          )
        },
      },
    ],
  },
  {
    id: 'txr-demo-example-card',
    title: 'ExampleFileCard (demo only)',
    note: 'The three example cards (patients / measurements / predict) with the "Example" badge and the measured facts lines.',
    cases: [
      { key: 'patients', label: 'patients · 94 rows', render: () => <ExampleFileCard kind="patients" rows={94} /> },
      { key: 'measurements', label: 'measurements · 630 rows', render: () => <ExampleFileCard kind="measurements" rows={630} markers={['LDH', 'CRP', 'Haemoglobin']} /> },
      { key: 'predict', label: 'predict · 15 rows', render: () => <ExampleFileCard kind="predict" rows={15} /> },
    ],
  },
]

export const gallery: ModuleGallery = {
  cassette: {
    'App.mode': () =>
      new URLSearchParams(window.location.search).get('demo') === '1' ? DEMO_MODE : DESKTOP_MODE,
  },
  seeded: [
    {
      slug: 'txr-demo-notice',
      title: 'The demo notice bar (wide) — under the header, on the routed area\'s own height',
      note: 'Seeded demo: the bar under the header, the header download link, the two links + the close button; the routed area leaves the bar its height (no overlap). The browser tier (txr-demo-mode.spec.ts) measures the boxes at 1440.',
      path: '*',
      initialPath: '/',
      component: WideShellStory,
      fullHeight: true,
      setup: () => seedDemoMode('demo'),
    },
    {
      slug: 'txr-demo-notice-narrow',
      title: 'The demo notice bar (narrow) — at most three lines, buttons below',
      note: 'The same shell inside a 390 frame (?w= to resize): the text lines first, the action row below, no horizontal overflow. The browser tier measures the line count and the stacking at 390.',
      path: '*',
      initialPath: '/',
      component: NarrowShellStory,
      fullHeight: true,
      setup: () => seedDemoMode('demo'),
    },
  ],
  stories,
}
