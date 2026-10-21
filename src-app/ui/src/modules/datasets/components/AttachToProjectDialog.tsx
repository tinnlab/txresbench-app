import { useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import { type ProjectDto } from '@/api-client/types'
import { Button, Dialog, Empty, ErrorState, Input, Spinner, message } from '@ziee/kit'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { Check, Search } from 'lucide-react'

/**
 * Attach a dataset to one of the user's projects for later analysis (M:N — DEC-4).
 * Reads its target from `Datasets.attachTarget`. Lists the user's projects
 * (search-filtered) with a per-row Attach action; a dataset belongs to many
 * projects, so the dialog stays open for multiple attaches.
 */
export function AttachToProjectDialog() {
  const { attachTarget, mutating } = Datasets
  const open = attachTarget !== null

  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [attached, setAttached] = useState<Set<string>>(new Set())

  const loadProjects = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await ApiClient.Project.list({ page: 1, per_page: 50 })
      setProjects(res.projects)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setAttached(new Set())
      setSearch('')
      void loadProjects()
    }
  }, [open, attachTarget?.id])

  const close = () => Datasets.closeAttach()

  const attach = async (project: ProjectDto) => {
    if (!attachTarget) return
    try {
      await Datasets.attachToProject(attachTarget.id, project.id)
      setAttached(prev => new Set(prev).add(project.id))
      message.success(`Attached to "${project.name}"`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to attach dataset')
    }
  }

  const filtered = projects.filter(s =>
    s.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) close()
      }}
      title={attachTarget ? `Attach "${attachTarget.name}" to a project` : 'Attach to project'}
      description="A dataset can belong to many projects. Attach it where you want to analyze it."
      data-testid="dataset-attach-dialog"
      footer={
        <div className="flex justify-end">
          <Button variant="outline" onClick={close} data-testid="dataset-attach-done">
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Search projects"
          aria-label="Search projects"
          prefix={<Search className="size-4" />}
          value={search}
          onChange={e => setSearch(e.target.value)}
          data-testid="dataset-attach-search"
        />
        {error ? (
          <ErrorState resource="projects" description={error} onRetry={loadProjects} data-testid="dataset-attach-error" />
        ) : loading ? (
          <div className="flex justify-center py-8" data-testid="dataset-attach-loading">
            <Spinner label="Loading projects" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8">
            <Empty
              description={search ? 'No projects match your search' : 'No projects yet'}
              data-testid="dataset-attach-empty"
            />
          </div>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" role="list" data-testid="dataset-attach-list">
            {filtered.map(project => {
              const done = attached.has(project.id)
              return (
                <li
                  key={project.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="truncate text-sm">{project.name}</span>
                  <Button
                    variant={done ? 'ghost' : 'outline'}
                    disabled={done || mutating}
                    onClick={() => attach(project)}
                    data-testid={`dataset-attach-project-${project.id}`}
                  >
                    {done ? (
                      <>
                        <Check className="mr-1 size-4" /> Attached
                      </>
                    ) : (
                      'Attach'
                    )}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
