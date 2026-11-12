import { Alert, Card } from '@txresbench/kit'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from '@txresbench/kit/shadcn/field'
import { SandboxStatus } from '@/modules/sandbox/stores/SandboxStatus.store'
import type { SandboxAvailability } from '@/api-client/types'

const AVAILABILITY_LABEL: Record<SandboxAvailability, string> = {
  ready: 'Ready',
  host_unsupported: 'Host unsupported (bwrap not found)',
  rootfs_unavailable: 'Rootfs not built into this binary',
  workspace_init_failed: 'Workspace init failed',
  not_initialized: 'Not initialized',
}

function StatusRow({ title, description, value, testid }: {
  title: string
  description: string
  value: React.ReactNode
  testid: string
}) {
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <span data-testid={testid} className="text-sm text-muted-foreground">
        {value}
      </span>
    </Field>
  )
}

/**
 * Read-only status of the embedded analysis rootfs (docker-built at build time,
 * extracted + squashfuse-mounted at runtime). No re-extract/verify action this
 * round (DEC-6) — the rootfs is embedded, not fetched.
 */
export function RootfsStatusCard() {
  const { status } = SandboxStatus
  const rootfs = status?.rootfs
  const availability = status?.availability

  const bool = (b: boolean | undefined) => (b ? 'Yes' : 'No')

  return (
    <Card data-testid="sandbox-rootfs-card" title="Analysis rootfs">
      {availability && availability !== 'ready' && (
        <Alert
          data-testid="sandbox-rootfs-availability-alert"
          tone="warning"
          title="Sandbox not available"
          description={AVAILABILITY_LABEL[availability]}
          className="mb-3"
        />
      )}
      <FieldGroup>
        <StatusRow
          title="Availability"
          description="Whether analysis runs can execute."
          value={availability ? AVAILABILITY_LABEL[availability] : '—'}
          testid="sandbox-rootfs-availability"
        />
        <StatusRow
          title="Schema version"
          description="The rootfs layout version this binary expects."
          value={rootfs?.schema_version ?? '—'}
          testid="sandbox-rootfs-schema"
        />
        <StatusRow
          title="Content version"
          description="Short hash of the embedded rootfs contents."
          value={rootfs?.content_version || '—'}
          testid="sandbox-rootfs-content"
        />
        <StatusRow
          title="Embedded size"
          description="Size of the rootfs baked into the binary."
          value={rootfs ? `${Math.round(rootfs.embedded_bytes / (1024 * 1024))} MiB` : '—'}
          testid="sandbox-rootfs-size"
        />
        <StatusRow
          title="Built in"
          description="A real (non-stub) rootfs was embedded at build time."
          value={bool(rootfs?.supported)}
          testid="sandbox-rootfs-supported"
        />
        <StatusRow
          title="Extracted"
          description="The rootfs has been extracted to the data directory."
          value={bool(rootfs?.extracted)}
          testid="sandbox-rootfs-extracted"
        />
        <StatusRow
          title="Mounted"
          description="The rootfs is currently squashfuse-mounted."
          value={bool(rootfs?.mounted)}
          testid="sandbox-rootfs-mounted"
        />
      </FieldGroup>
    </Card>
  )
}
