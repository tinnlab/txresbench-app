import { RefreshCw } from 'lucide-react'
import { Alert, Badge, Button, Card, Skeleton, message } from '@txresbench/kit'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from '@txresbench/kit/shadcn/field'
import { ProcessorsAdmin } from '@/modules/processors/stores/ProcessorsAdmin.store'
import { usePermission } from '@/core/permissions'
import { type PackageLoadStatus } from '@/api-client/types'
import { Permissions } from '@/api-client/permissions'

/** One discovered-package row: id + version on the left, a load-status badge on the
 * right, and (when skipped) the package-scoped error beneath. */
function PackageRow({ pkg }: { pkg: PackageLoadStatus }) {
  return (
    <Field orientation="responsive" data-testid={`processor-row-${pkg.id}`}>
      <FieldContent>
        <FieldTitle>{pkg.id}</FieldTitle>
        <FieldDescription>
          {pkg.version ? `version ${pkg.version}` : 'version unknown'}
          {!pkg.ok && pkg.error ? ` — ${pkg.error}` : ''}
        </FieldDescription>
      </FieldContent>
      {pkg.ok ? (
        <Badge tone="success" data-testid={`processor-status-${pkg.id}`}>
          Loaded
        </Badge>
      ) : (
        <Badge tone="error" data-testid={`processor-status-${pkg.id}`}>
          Skipped
        </Badge>
      )}
    </Field>
  )
}

/**
 * The discovered-processors card: lists each scanned package under
 * `<data_root>/processors/` with its per-package load status (Loaded / Skipped +
 * the package-scoped error), a package count, and a Reload button that re-scans the
 * folder (`POST /api/processors/reload`) and refreshes the list.
 */
export function ProcessorsListCard() {
  const { packages, loading, reloading, error } = ProcessorsAdmin
  // The Reload action requires MANAGE (the perm the reload endpoint enforces); a
  // read-only admin sees the list but no Reload button (no 403-on-click). M6.
  const canReload = usePermission(Permissions.SandboxSettingsManage)

  const onReload = async () => {
    const ok = await ProcessorsAdmin.reload()
    if (ok) {
      const skipped = ProcessorsAdmin.$.packages.filter(p => !p.ok).length
      message.success(
        skipped > 0
          ? `Reloaded processors — ${skipped} skipped with errors`
          : 'Reloaded processors',
      )
    } else {
      message.error(ProcessorsAdmin.$.error ?? 'Failed to reload processors')
    }
  }

  const count = packages.length
  const skippedCount = packages.filter(p => !p.ok).length

  return (
    <Card
      data-testid="processors-list-card"
      title={
        <span>
          Discovered processors{' '}
          <span className="text-muted-foreground" data-testid="processors-count">
            ({count})
          </span>
        </span>
      }
      extra={
        canReload ? (
          <Button
            variant="outline"
            icon={<RefreshCw />}
            loading={reloading}
            onClick={() => void onReload()}
            data-testid="processors-reload"
            aria-label="Reload processors"
          >
            Reload
          </Button>
        ) : null
      }
    >
      {/* A reload FAILURE keeps the card + the Reload affordance (never swaps the whole
          card for a page-level error) — the inline alert shows the reason, the button
          stays for a retry (LOW: empty-folder reload error must not lose the affordance). */}
      {error && count === 0 && !loading ? (
        <Alert
          tone="error"
          title="Reload failed"
          description={error}
          data-testid="processors-inline-error"
          className="mb-3"
        />
      ) : null}
      {loading && count === 0 ? (
        <div className="flex flex-col gap-3" data-testid="processors-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : count === 0 ? (
        <div
          className="py-8 text-center text-sm text-muted-foreground"
          data-testid="processors-empty"
        >
          No processors discovered in the processors folder.
        </div>
      ) : (
        <FieldGroup data-testid="processors-list">
          {skippedCount > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="processors-skipped-note">
              {skippedCount} package{skippedCount === 1 ? '' : 's'} skipped — fix the
              package-scoped error and reload.
            </p>
          )}
          {packages.map(pkg => (
            <PackageRow key={pkg.id} pkg={pkg} />
          ))}
        </FieldGroup>
      )}
    </Card>
  )
}
