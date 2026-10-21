import { type APIRequestContext } from '@playwright/test'
import { seedQcDataset, seedRunnableExpression } from '../14-declarative-qc/_seed'

// Shared project SEEDING for the W3/W6 workbench specs.
//
// WHY THIS REPLACED THE FORMER `seedClusteringColumns(page)`: every LAUNCHER-VISIBLE
// analysis is availability-gated on an input datatype (`qc.10x` / `cell.filter` need a
// `single-cell/expression`; `cellranger.count` needs a `sequence/fastq`). So a FRESH
// project has ZERO available launcher rows and nothing runnable: the old "launch the first
// available row and run it to completion to produce columns" seeder was unsatisfiable by
// construction. (ITEM-16 additionally deleted the one input-free analysis, the
// `selection.demo` dogfood, with its FE-code package.)
//
// The replacement seeds the project's DATA over the `#[cfg(debug_assertions)]` debug
// routes (the pattern the `14-declarative-qc` specs already use) — deterministic and,
// for the first two, compute-free.

/** Seed a `single-cell/expression` artifact — the minimum that makes `qc.10x` +
 *  `cell.filter` AVAILABLE (enabled) in the launcher. No compute involved. */
export async function seedExpressionArtifact(
  request: APIRequestContext,
  projectId: string,
): Promise<void> {
  await seedQcDataset(request, projectId, { annotated: false })
}

// ITEM-39 deleted `seedPerCellColumns` (expression artifact + per-cell metric columns):
// its only callers were the cell-group / cell-filter builder specs, which went with the
// four dimension primitives they drove.

/** Seed a REAL runnable counts matrix so `qc.10x` can RUN to completion: it IMPORTS the
 *  committed tiny `.h5ad` through the deployment's own on-ingest converter, so what lands is
 *  the CSC Zarr store (`kind: sparse_csc`) the computes actually read — see
 *  `14-declarative-qc/_seed.ts::seedRunnableExpression` for why a fixture cannot serve, and
 *  for the sandbox-capable host + wall-clock this costs. Almost every caller is
 *  REAL-compute-gated (see `_analysis.ts`); `run-pane.spec.ts`'s first describe is not, and
 *  says so at its call site. */
export async function seedRunnableMatrix(
  request: APIRequestContext,
  projectId: string,
): Promise<void> {
  await seedRunnableExpression(request, projectId, 'PBMC')
}
