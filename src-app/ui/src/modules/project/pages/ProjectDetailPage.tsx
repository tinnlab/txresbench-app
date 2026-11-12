import { useEffect } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { isDesktop } from '@/core/platform'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout.store'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { ProjectDrawer } from '@/modules/project/stores/ProjectDrawer.store'
import { ProjectSettings } from '@/modules/project/stores/ProjectSettings.store'
import { Button, ErrorState, Spinner, Tag, Title } from '@txresbench/kit'
import { DivScrollY, HeaderBarContainer } from '@txresbench/shell'
import { cn } from '@/lib/utils'
import { ArrowLeft } from 'lucide-react'
import { ProjectFormDrawer } from '@/modules/project/components/ProjectFormDrawer'
import { ProjectShareDrawer } from '@/modules/project/components/ProjectShareDrawer'
import { ProjectTransferDrawer } from '@/modules/project/components/ProjectTransferDrawer'
import { ProjectDetailPanelSlot, useProjectNavEntries } from '@/modules/project/core/extensions'
import { useActiveDetailPanelIsFullBleed } from '@/modules/project/core/extensions/slots'
import { deriveProjectScope, ProjectScopeProvider } from '@/modules/project/context/ProjectScope'

/**
 * The project detail SHELL. The header/actions stay here; the body is composed from
 * project extensions — a section nav (from the `project_nav` slot) + the active
 * section panel (from `detail_panels`), selected by the URL `:section`
 * (`/projects/:id/:section`). The datasets UI now lives in the dataset extension's
 * panel, not inline here — future modules add sections with ZERO edits to this
 * page.
 */
export function ProjectDetailPage() {
  const { id, section } = useParams<{ id: string; section?: string }>()
  const navigate = useNavigate()
  const { project, loading, error } = ProjectDetail
  // Mirror SettingsPage: read the shared native-scroll flag so the shell's
  // HeaderBarContainer + body flow stay consistent with the rest of the app.
  const { nativeScroll } = AppLayout
  const navEntries = useProjectNavEntries()
  // Whether the active section's panel is full-bleed (the workbench) — drives the
  // page to drop its max-width/padding and yield viewport height below the header.
  const fullBleed = useActiveDetailPanelIsFullBleed(section)

  useEffect(() => {
    if (id) {
      ProjectDetail.loadProject(id)
      void ProjectDetail.loadAvailableDatasets()
    }
  }, [id])

  const { isOwner, canEdit } = deriveProjectScope(project)
  const web = !isDesktop()
  const transferEnabled = ProjectSettings.settings?.transfer_enabled ?? true

  if (error) {
    return (
      <div className="p-6">
        <ErrorState
          resource="project"
          description={error}
          onRetry={() => {
            if (id) ProjectDetail.loadProject(id)
          }}
          data-testid="project-detail-error"
        />
      </div>
    )
  }
  if (loading && !project) {
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading project" />
      </div>
    )
  }
  if (!project) return null

  // Default / unknown section → the first registered section (DEC-7).
  const defaultSection = navEntries[0]?.section
  if (id && defaultSection && (!section || !navEntries.some(e => e.section === section))) {
    return <Navigate to={`/projects/${id}/${defaultSection}`} replace />
  }

  // Header bar (back + title/permission + actions) — standardized on the shared
  // HeaderBarContainer bar, shared by both layouts.
  const headerBar = (
    <HeaderBarContainer>
      <div className="flex h-full w-full items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/projects')}
            data-testid="project-detail-back"
          >
            <ArrowLeft className="size-4" /> Projects
          </button>
          <Title level={4} className="!m-0 !leading-tight truncate" data-testid="project-detail-name">
            {project.name}
          </Title>
          <Tag variant="outline" data-testid="project-detail-permission">
            {project.effective_permission}
          </Tag>
        </div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <Button variant="outline" onClick={() => ProjectDrawer.openEdit(project)} data-testid="project-detail-edit">
              Edit
            </Button>
          ) : null}
          {isOwner && web ? (
            <Button variant="outline" onClick={() => ProjectDrawer.openShare()} data-testid="project-detail-share">
              Share
            </Button>
          ) : null}
          {isOwner && web && transferEnabled ? (
            <Button
              variant="outline"
              onClick={() => ProjectDrawer.openTransfer()}
              data-testid="project-detail-transfer"
            >
              Transfer
            </Button>
          ) : null}
        </div>
      </div>
    </HeaderBarContainer>
  )

  // Sub-header (description + section nav) — constrained body content directly
  // below the bar; shared by both layouts as a fragment.
  const subHeader = (
    <>
      {project.description ? (
        <p className="text-sm text-muted-foreground">{project.description}</p>
      ) : null}

      {/* Section nav — contributed by project extensions. Scrolls on narrow
          viewports; renders a placeholder when no extension is registered. */}
      {navEntries.length > 0 ? (
        <nav
          className="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-px"
          aria-label="Project sections"
          data-testid="project-section-nav"
        >
          {navEntries.map(entry => {
            const active = entry.section === section
            return (
              <Link
                key={entry.id}
                to={`/projects/${project.id}/${entry.section}`}
                aria-current={active ? 'page' : undefined}
                data-testid={`project-section-tab-${entry.section}`}
                className={
                  'flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-1.5 text-sm ' +
                  (active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground')
                }
              >
                {entry.icon ? <span className="[&_svg]:size-4">{entry.icon}</span> : null}
                {entry.label}
                {entry.badge ? (
                  <span className="text-xs text-muted-foreground">{entry.badge(project)}</span>
                ) : null}
              </Link>
            )
          })}
        </nav>
      ) : null}
    </>
  )

  // The extension panels read `canEdit`/role from this ONE provider — a Viewer
  // gets a fully-rendered but read-only panel. This is the seam the P6 workbench
  // shell consumes for every contribution.
  const panelRegion = (
    <ProjectScopeProvider project={project}>
      <ProjectDetailPanelSlot
        section={section}
        fallback={
          <p className="text-sm text-muted-foreground" data-testid="project-no-sections">
            No sections yet.
          </p>
        }
      />
    </ProjectScopeProvider>
  )

  const drawers = (
    <>
      <ProjectFormDrawer />
      <ProjectShareDrawer />
      <ProjectTransferDrawer />
    </>
  )

  // Full-bleed layout (the workbench): ZERO chrome — the project detail page IS the workbench, filling
  // the entire viewport so the user has the most space to analyse + explore. There is deliberately no
  // header/sub-header here: back = the sidebar Projects nav, the project name = the sidebar highlight,
  // and Edit/Share/Transfer live on the projects-list card ⋮ menu. Datasets / Artifacts / Reproducibility
  // are PANES inside the workbench (Datasets open by default), not sections. The panel region
  // (`ProjectDetailPanelSlot`, fullBleed) yields flex-1 and fills the height.
  if (fullBleed) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden"
        data-testid="project-detail-page"
      >
        {panelRegion}
        {drawers}
      </div>
    )
  }

  // Sectioned layout (header bar + section nav + a constrained body). This is the shell's
  // generic dual-layout capability, kept because `fullBleed` is a PER-PANEL flag.
  //
  // ⚠️ CURRENTLY UNREACHABLE. `workbench` registers the ONLY `project_nav` entry in the
  // tree, and its panel is `fullBleed`, so every reachable project URL takes the branch
  // above. `headerBar` / `subHeader` therefore render nowhere today — do NOT write tests
  // against `project-detail-{name,back,permission,edit,share,transfer}` or
  // `project-section-{nav,tab-*}`; they cannot appear. The live equivalents are
  // `workbench-project-name` (WorkbenchShell header) and the projects-list card ⋮ menu
  // (`ProjectCard`), which carries Edit/Share/Transfer under the SAME gates used here.
  // This branch revives the moment any extension registers a non-full-bleed section.
  return (
    <div
      className={cn(
        'flex flex-col',
        nativeScroll ? 'min-h-dvh' : 'h-full overflow-hidden',
      )}
      data-testid="project-detail-page"
    >
      {headerBar}
      {/* Page body — scrollable, nativeScroll-aware region below the bar. */}
      <DivScrollY nativeFlow className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
          {subHeader}
          {panelRegion}
        </div>
      </DivScrollY>

      {drawers}
    </div>
  )
}
