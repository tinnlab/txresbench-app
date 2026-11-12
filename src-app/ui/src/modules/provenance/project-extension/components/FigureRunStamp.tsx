import { Descriptions, type DescriptionsItem } from '@txresbench/kit'
import type { RunNodeDto } from '@/api-client/types'

function short(hash?: string): string {
  if (!hash) return '—'
  return hash.length > 16 ? `${hash.slice(0, 12)}…${hash.slice(-4)}` : hash
}

function paramsPreview(params: unknown): string {
  if (params == null) return '—'
  try {
    const s = JSON.stringify(params)
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  } catch {
    return '—'
  }
}

/**
 * The figure run-stamp — the compact "reproducibility receipt" for a single
 * run: the run id, its object/code hash, pinned environment, params, tool
 * version, and seed. This is what a user cites next to a figure so a reader can
 * reproduce it. Rendered for the most recent run in the panel header.
 */
export function FigureRunStamp({ run }: { run: RunNodeDto }) {
  const items: DescriptionsItem[] = [
    { key: 'run_id', label: 'Run', children: <code className="text-xs">{run.run_id}</code> },
    {
      key: 'generator',
      label: 'Tool',
      children: `${run.generator_id} · ${run.generator_version}`,
    },
    { key: 'seed', label: 'Seed', children: run.seed == null ? '—' : String(run.seed) },
    { key: 'code', label: 'Code hash', children: <code className="text-xs">{short(run.code_sha256)}</code> },
    {
      key: 'env',
      label: 'Environment',
      children: <code className="text-xs">{short(run.env_rootfs_sha256)}</code>,
    },
    { key: 'params', label: 'Params', children: <span className="text-xs">{paramsPreview(run.params)}</span> },
  ]

  return (
    <Descriptions
      items={items}
      title="Figure run-stamp"
      bordered
      size="sm"
      column={2}
      data-testid="provenance-run-stamp"
    />
  )
}
