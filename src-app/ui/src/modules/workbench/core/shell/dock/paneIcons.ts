// paneIcons — the icon for each pane KIND, shown alongside the title in every tab/header
// surface (the region tab strips, the VS-Code tab strip, the pane header). Kept OUT of
// `paneModel.tsx` so that module stays import-light (it's imported by node-env unit tests);
// this one pulls lucide. One icon per kind so a pane is recognizable at a glance in a dense
// tab strip.

import {
  Activity,
  Database,
  Download,
  Eye,
  FlaskConical,
  GitCompare,
  Network,
  Package,
  Palette,
  Play,
  RotateCcw,
  ScatterChart,
  SlidersHorizontal,
  Table,
  Table2,
  type LucideIcon,
} from 'lucide-react'
import type { PaneKind } from './paneModel'

const KIND_ICONS: Record<PaneKind, LucideIcon> = {
  visualize: Palette,
  canvas: ScatterChart,
  launcher: FlaskConical,
  run: Play,
  artifact: Table,
  view: Eye,
  jobs: Activity,
  rerun: RotateCcw,
  compare: GitCompare,
  datasets: Database,
  artifacts: Package,
  reproducibility: Network,
  'edit-plot': SlidersHorizontal,
  'data-table': Table2,
  export: Download,
}

/** The lucide icon for a pane kind (neutral `Eye` fallback for an unknown/unregistered kind). */
export function paneKindIcon(kind: PaneKind): LucideIcon {
  return KIND_ICONS[kind] ?? Eye
}
