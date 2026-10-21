import { useEffect } from 'react'
import { z } from 'zod'
import { Alert, Button, Form, FormField, Input, Textarea, message, useForm, zodResolver } from '@ziee/kit'
import { Drawer } from '@ziee/shell'
import { ProjectDrawer } from '@/modules/project/stores/ProjectDrawer.store'
import { Projects } from '@/modules/project/stores/Projects.store'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { deriveProjectScope } from '@/modules/project/context/ProjectScope'

// Mirrors the backend caps (PROJECT_NAME_MAX=200, PROJECT_DESCRIPTION_MAX=64 KiB).
const projectSchema = z.object({
  name: z.string().min(1, 'Please enter a project name').max(200, 'Name is too long (max 200)'),
  description: z.string().max(64 * 1024, 'Description is too long').optional(),
})

type ProjectFormValues = z.infer<typeof projectSchema>

export function ProjectFormDrawer() {
  const { formOpen, editing } = ProjectDrawer
  const { mutating } = Projects
  const canUse = usePermission(Permissions.ProjectsUse)
  // Read-only only when EDITING an existing project as a viewer. Create mode
  // (`editing == null`) is never read-only — gate on `editing` first, because
  // `deriveProjectScope(null)` fail-closes to `viewer` (which is correct for a
  // permission gate, but here null means "new project", not "a viewer's project").
  const readOnly = !!editing && deriveProjectScope(editing).isViewer
  const isEdit = !!editing

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: '', description: '' },
  })

  useEffect(() => {
    if (formOpen) {
      form.reset({
        name: editing?.name ?? '',
        description: editing?.description ?? '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, editing?.id])

  const close = () => {
    ProjectDrawer.closeForm()
    form.reset({ name: '', description: '' })
  }

  const onSubmit = async (values: ProjectFormValues) => {
    try {
      if (editing) {
        await Projects.updateProject(editing.id, {
          name: values.name,
          description: values.description ?? '',
        })
        message.success('Project updated')
      } else {
        await Projects.createProject({
          name: values.name,
          description: values.description ?? '',
        })
        message.success('Project created')
      }
      close()
    } catch {
      /* store surfaces the error */
    }
  }

  const showSubmit = canUse && !readOnly

  return (
    <Drawer
      title={isEdit ? 'Edit project' : 'New project'}
      open={formOpen}
      onClose={close}
      size={520}
      mask={{ closable: false }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={mutating} data-testid="project-form-cancel">
            {showSubmit ? 'Cancel' : 'Close'}
          </Button>
          {showSubmit && (
            <Button
              type="submit"
              form="project-form"
              loading={mutating}
              data-testid="project-form-submit"
            >
              {isEdit ? 'Save' : 'Create'}
            </Button>
          )}
        </div>
      }
    >
      {/* One wrapper so the Drawer body (a flex ROW) keeps banner-above-form. */}
      <div className="flex flex-col">
        {/* `showSubmit` has TWO causes and the greyed form states neither: no
            `projects::use` at all, or viewer access to THIS project. Name the one
            that applies (permission first — it is the broader refusal). */}
        {!showSubmit && (
          <Alert
            data-testid="project-form-readonly-alert"
            tone="info"
            title="Read-only view"
            description={
              !canUse
                ? 'You don’t have the “projects::use” permission, so these fields are read-only and nothing can be saved here.'
                : 'You have view-only access to this project, so these fields are read-only. Ask its owner for editor access to make changes.'
            }
            className="mb-3"
          />
        )}

        <Form
          name="project-form"
          form={form}
          layout="vertical"
          onSubmit={onSubmit}
          disabled={!showSubmit}
          data-testid="project-form"
        >
          <FormField name="name" label="Name" required>
            {/* A domain-NEUTRAL example. It read "e.g. PBMC atlas 2026" — the generic
                project-create form, the first thing every user of every deployment sees,
                telling them this platform is for single-cell biology. It carries no word
                in the domain guard's vocabulary, which is exactly why a vocabulary scan
                could never find it: the leak is the PURPOSE of the copy, not its nouns. */}
            <Input placeholder="e.g. Q3 experiment" data-testid="project-name-input" />
          </FormField>
          <FormField name="description" label="Description">
            <Textarea
              placeholder="What is this project about? (optional)"
              rows={4}
              data-testid="project-description-input"
            />
          </FormField>
        </Form>
      </div>
    </Drawer>
  )
}
