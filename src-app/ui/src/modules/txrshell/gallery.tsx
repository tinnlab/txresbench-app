/**
 * txrshell dev-gallery surfaces (qa-fixes ITEM-7 X2; app-shell ITEM-1).
 *
 * The shell is the one surface a page-story cannot show (the gallery frames
 * mount the page component under its own MemoryRouter, and the route
 * `layout` is the app router's), so the header's own narrow story lives
 * here: the real TxrShell around an empty routed area at a width the spec
 * passes (`?w=360|390|414|768`, default 390) for the gallery-e2e
 * `txr-theme-phone.spec.ts`.
 *
 * The app-shell ITEM-1 primitives each get their own seeded story (the
 * browser tier `txr-shell-primitives.spec.ts` drives them): the shell with
 * a page frame inside (the document-fixed + header-stationary legs), the
 * page frame alone, the scroll region (shadow cues), and the data table
 * below and above the virtualisation threshold (sticky header leg).
 *
 * DEV-ONLY: picked up by the dev gallery's `import.meta.glob`, never in a
 * production bundle path.
 */
import { lazy, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ModuleGallery } from '@txresbench/gallery'
import { TxrShell } from './TxrLayout'
import { NotFoundPage } from './pages/NotFoundPage'
import { PageFrame } from './components/PageFrame'
import { PageToolbar } from './components/PageToolbar'
import { PageFooterBar } from './components/PageFooterBar'
import { ScrollRegion } from './components/ScrollRegion'
import { DataTable, type DataTableColumn } from './components/DataTable'

/** One narrow frame (the spec's `?w=` query, the QA report's 390 default). */
function NarrowShell({ children }: { children: ReactNode }) {
  const w = Number(new URLSearchParams(window.location.search).get('w')) || 390
  return (
    <section
      data-testid="txr-shell-narrow"
      style={{ width: w, maxWidth: '100%', minWidth: 0, border: '0' }}
    >
      {children}
    </section>
  )
}

const NarrowShellStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <NarrowShell>
        <TxrShell>
          <div style={{ padding: '24px 16px' }} />
        </TxrShell>
      </NarrowShell>
    ),
  }),
)

/** The demo rows the table and the region stories share. */
function demoRows(count: number): Array<{ id: string; marker: string; value: string; day: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `P${String(i + 1).padStart(4, '0')}`,
    marker: `M${(i % 3) + 1}`,
    value: `${(3.2 + (i % 7) * 0.4).toFixed(1)}`,
    day: 30 + (i % 5) * 15,
  }))
}

const DEMO_COLUMNS: DataTableColumn<{ id: string; marker: string; value: string; day: number }>[] = [
  { id: 'patient', header: 'Patient', width: 160, cell: r => r.id },
  { id: 'marker', header: 'Marker', width: 140, cell: r => r.marker },
  { id: 'value', header: 'Value', width: 120, align: 'right', cell: r => r.value },
  { id: 'day', header: 'Day', width: 100, align: 'right', cell: r => String(r.day) },
]

function TableStory({ rows }: { rows: number }) {
  const data = demoRows(rows)
  return (
    // A bounded box (the audit's "wide table in a region" frame): the table
    // is wider than it, so the region scrolls horizontally and the sticky
    // first column is real. `min()` keeps a phone frame from overflowing.
    <div style={{ width: 'min(420px, 100%)', height: '100%' }}>
      <ScrollRegion label="People and markers">
        <DataTable
          rows={data}
          columns={DEMO_COLUMNS}
          rowKey={row => row.id}
          label="People and markers"
          stickyFirstColumn
        />
      </ScrollRegion>
    </div>
  )
}

const TableStory40 = lazy(() =>
  Promise.resolve({ default: () => <TableStory rows={40} /> }),
)
const TableStory300 = lazy(() =>
  Promise.resolve({ default: () => <TableStory rows={300} /> }),
)

const RegionStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <ScrollRegion label="Visit notes">
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--txr-border-subtle)' }}>
            Visit {i + 1} — the clinical line for the row, long enough to scroll the region at the
            frame height and exercise its shadow cues.
          </div>
        ))}
      </ScrollRegion>
    ),
  }),
)

const PageFrameStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <PageFrame
        top={
          <PageToolbar>
            <h2 style={{ margin: 0, fontSize: 18 }}>Results</h2>
            <span style={{ marginLeft: 'auto', color: 'var(--txr-muted)' }}>Filter bar</span>
          </PageToolbar>
        }
        body={
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 24px' }}>
            <ScrollRegion label="Patients">
              {Array.from({ length: 40 }, (_, i) => (
                <div key={i} style={{ padding: '12px', borderBottom: '1px solid var(--txr-border-subtle)' }}>
                  Patient row {i + 1}
                </div>
              ))}
            </ScrollRegion>
          </div>
        }
        bottom={
          <PageFooterBar>
            <span style={{ color: 'var(--txr-muted)' }}>Showing 12 of 40</span>
            <span style={{ marginLeft: 'auto' }}>Actions</span>
          </PageFooterBar>
        }
      />
    ),
  }),
)

const ShellStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <TxrShell>
        <PageFrame
          top={
            <PageToolbar>
              <h2 style={{ margin: 0, fontSize: 18 }}>A page inside the shell</h2>
            </PageToolbar>
          }
          body={
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <ScrollRegion label="Body region">
                {Array.from({ length: 80 }, (_, i) => (
                  <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--txr-border-subtle)' }}>
                    Line {i + 1} — the shell's routed body holds one page frame; the header stays
                    while this region scrolls.
                  </div>
                ))}
              </ScrollRegion>
            </div>
          }
          bottom={
            <PageFooterBar>
              <span style={{ color: 'var(--txr-muted)' }}>Bottom bar</span>
            </PageFooterBar>
          }
        />
      </TxrShell>
    ),
  }),
)

const RestoreStory = lazy(() =>
  Promise.resolve({
    default: function RestoreStory() {
      // Two views of one story, switched by the frame's MemoryRouter — the
      // Back-button scroll-restore leg drives these links: the region of
      // view A keeps its scroll position when the view is re-entered.
      const location = useLocation()
      const viewA = location.pathname !== '/b'
      return (
        <TxrShell>
          {viewA ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ padding: 12, display: 'flex', gap: 12, borderBottom: '1px solid var(--txr-border)' }}>
                <span>View A</span>
                <Link to="/b">Go to B</Link>
              </div>
              <ScrollRegion label="Notes" restoreKey="/a#Notes">
                {Array.from({ length: 80 }, (_, i) => (
                  <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--txr-border-subtle)' }}>
                    Note {i + 1} — the scroll position of this region is remembered per view.
                  </div>
                ))}
              </ScrollRegion>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ padding: 12, display: 'flex', gap: 12, borderBottom: '1px solid var(--txr-border)' }}>
                <span>View B</span>
                <Link to="/a">Back to A</Link>
              </div>
              <ScrollRegion label="Other" restoreKey="/b#Other">
                {Array.from({ length: 20 }, (_, i) => (
                  <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--txr-border-subtle)' }}>
                    B line {i + 1}
                  </div>
                ))}
              </ScrollRegion>
            </div>
          )}
        </TxrShell>
      )
    },
  }),
)

const NotFoundStory = lazy(() =>
  Promise.resolve({
    default: () => (
      <TxrShell>
        <NotFoundPage />
      </TxrShell>
    ),
  }),
)

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'txr-shell-route-not-found',
      title: 'Page not found inside the shell',
      note: 'The app-shell ITEM-3 route byte for the catch-all: no fixed chrome, the not-found block in the page\'s ONE region (the audit\'s "none top, body region, none bottom" row), the shell\'s header stays put while the region scrolls in a short window.',
      path: '*',
      initialPath: '/no-such-route',
      component: NotFoundStory,
    },
    {
      slug: 'txr-shell-narrow-390',
      title: 'The shell header at narrow width',
      note: 'The narrow byte: the tagline yields under 900 px, the header is ONE 56 px row at every width, and under 700 px the nav becomes a menu button — the four destinations remain reachable (keyboard and screen-reader), no horizontal page overflow.',
      path: '*',
      initialPath: '/',
      component: NarrowShellStory,
      fullHeight: true,
    },
    {
      slug: 'txr-app-shell',
      title: 'The app shell with a page frame',
      note: 'The shell mode byte: the header is fixed, the routed body holds one page frame, the body region scrolls, the bottom bar is fixed. The document itself never scrolls.',
      path: '*',
      initialPath: '/',
      component: ShellStory,
    },
    {
      slug: 'txr-scroll-restore',
      title: 'The scroll position on Back',
      note: 'Two views of one story: view A\'s region remembers its scroll position while view B is open, and restores it when A is re-entered — the Back-button rule, in memory per route.',
      path: '*',
      initialPath: '/a',
      component: RestoreStory,
    },
    {
      slug: 'txr-page-frame',
      title: 'The page frame slots',
      note: 'The one page layout: fixed top (toolbar), the region body, fixed bottom (actions/counters) — the regions scroll, the frame never does.',
      path: '*',
      initialPath: '/',
      component: PageFrameStory,
    },
    {
      slug: 'txr-scroll-region',
      title: 'The scroll region',
      note: 'Focusable and labelled, scrollbar-gutter stable, shadow cues at the edges when there is more content; PageDown/Space/Home/End answer while it holds focus.',
      path: '*',
      initialPath: '/',
      component: RegionStory,
    },
    {
      slug: 'txr-data-table',
      title: 'The data table',
      note: 'Sticky header inside its region, sticky first column, consistent row height, focus and hover rows; wide tables scroll inside the region.',
      path: '*',
      initialPath: '/',
      component: TableStory40,
    },
    {
      slug: 'txr-data-table-virtual',
      title: 'The data table above 200 rows',
      note: 'The virtualised body: the same sticky header and sticky first column, the same keyboard behaviour, aria-rowcount for the full set.',
      path: '*',
      initialPath: '/',
      component: TableStory300,
    },
  ],
}
