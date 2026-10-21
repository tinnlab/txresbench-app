// colorScale.ts — shared color-DOMAIN coordination (DEC-25 / ITEM-64).
//
// PROBLEM: when two linked panels both color by the SAME value column but each
// auto-detects its own domain, identical values render as different colors —
// silently misleading in the side-by-side comparison workflow.
//
// FIX: panels register their per-column color domain into a coordination scope
// keyed by a stable per-registration id. `resolveSharedDomain` unions every
// registered domain that colors by the same value column, so all linked panels
// map identical values to identical colors.
//
// This file is PURE (no React, no store) so the merge math is unit-testable in
// the node vitest pass; the store slice + the `useSharedColorDomain` hook build
// on these helpers.
//
// CATEGORICAL cross-pane stable identity (Build-2, COLOR_PALETTE_PLAN — implemented by
// `resolveSharedCategoryColors` at the bottom of this file). Alongside the CONTINUOUS domain
// union below, panels register their by-NAME `categoryColors` map (the shape
// `data/color.ts::resolveEffectivePalette` consumes) into a coordination scope, and
// `resolveSharedCategoryColors` MERGES every scope coloring by the same color-by column so a
// named group ("T cells") resolves to ONE color across linked panes AND datasets — the
// categorical analog of `resolveSharedDomain`. The continuous-domain contract below is
// UNCHANGED; the categorical merge is a separate, purely additive helper.

import type { PaletteEntry } from '../data/color'

/** One panel's declared color-by: the value column (`key`), its numeric
 *  `domain`, and the `colormap` it renders with. Registered per-panel under a
 *  unique registration id (multiple panels may share the same `key`). */
export interface ColorScaleScope {
  /** The value column the panel colors by (the coordination axis). */
  key: string
  /** The panel's own auto-detected numeric domain `[min, max]`. */
  domain: [number, number]
  /** The colormap name the panel renders the scale with. */
  colormap: string
}

/** The canonical "no data yet" / empty domain sentinel. A panel coloring an
 *  empty or all-NaN column registers this (min/max seeded to ±Infinity), and
 *  the merge helpers read it — and any non-finite or inverted domain — as
 *  ABSENT so it never poisons a sibling's real domain. */
export const EMPTY_DOMAIN: [number, number] = [Infinity, -Infinity]

/** True when a domain carries real, colormap-usable bounds — i.e. BOTH bounds
 *  are finite numbers. The `[Infinity, -Infinity]` "no data yet" sentinel and
 *  any `[NaN, NaN]` (empty / all-NaN column) are non-finite, so they read as
 *  absent. A finite-but-inverted domain (`d[0] > d[1]`, e.g. `[5, 0]`) is still
 *  a real domain that `mergeDomain` normalizes via min/max across bounds — it
 *  is NOT rejected, preserving the long-standing inverted-input tolerance. */
export function isValidDomain(d: [number, number]): boolean {
  return Number.isFinite(d[0]) && Number.isFinite(d[1])
}

/** Union of two numeric domains: `[min(lo), max(hi)]`. Order-independent and
 *  tolerant of inverted inputs (min/max are taken across all four bounds).
 *  Non-finite / inverted-empty domains are treated as ABSENT: if one side is
 *  invalid the other (valid) side is returned; if both are invalid the empty
 *  sentinel is returned, so a "no data yet" panel never widens the union to
 *  `[-Infinity, Infinity]` (or `[NaN, NaN]`). */
export function mergeDomain(
  a: [number, number],
  b: [number, number],
): [number, number] {
  const aOk = isValidDomain(a)
  const bOk = isValidDomain(b)
  if (!aOk && !bOk) return EMPTY_DOMAIN
  if (!aOk) return b
  if (!bOk) return a
  return [Math.min(a[0], a[1], b[0], b[1]), Math.max(a[0], a[1], b[0], b[1])]
}

/** The union domain across every registered scope coloring by `key`, or `null`
 *  when no scope colors by that key with a VALID domain (caller falls back to
 *  its own domain). Scopes whose domain is non-finite / inverted-empty (an
 *  empty or all-NaN column) are skipped, so they never poison the shared
 *  domain; `null` is returned when none of the matching scopes are valid. */
export function resolveSharedDomain(
  scopes: ColorScaleScope[],
  key: string,
): [number, number] | null {
  let merged: [number, number] | null = null
  for (const scope of scopes) {
    if (scope.key !== key) continue
    if (!isValidDomain(scope.domain)) continue
    // NORMALIZE + COPY even for the first/only matching scope: returning `scope.domain` by-reference
    // (a) leaks the caller-owned array (a mutation corrupts the stored scope) and (b) skips the
    // inverted-`[hi,lo]`→`[lo,hi]` normalization `mergeDomain` applies to every subsequent scope.
    merged =
      merged === null
        ? [Math.min(scope.domain[0], scope.domain[1]), Math.max(scope.domain[0], scope.domain[1])]
        : mergeDomain(merged, scope.domain)
  }
  return merged
}

// ── CATEGORICAL cross-pane stable identity (Build-2) ──────────────────────────
// The categorical analog of `ColorScaleScope` + `resolveSharedDomain` above: instead of unioning
// numeric DOMAINS, it merges per-scope by-NAME category→color maps so a named group resolves to
// ONE color across every linked scope. PURE (node-testable), no React/store. Additive — the
// continuous path above is untouched.

/** One panel's declared by-NAME categorical colors under a color-by column (`key`) — the
 *  categorical analog of `ColorScaleScope`. Registered per-panel under a unique registration id
 *  (multiple panels may color by the same `key`). `categoryColors` is a structural subset of
 *  `CategoricalOverrides.categoryColors`, so a merged result feeds straight back into
 *  `resolveEffectivePalette`. */
export interface CategoryColorScope {
  /** The color-by column whose category NAMES this scope colors (the coordination axis). */
  key: string
  /** This scope's by-NAME category→color map (raw category name → palette entry). */
  categoryColors: Readonly<Record<string, PaletteEntry>>
}

/**
 * The SHARED by-name category→color map across every registered scope coloring by `key`, or
 * `null` when no scope contributes a named color for that key (the caller falls back to its own
 * per-pane palette). The categorical analog of `resolveSharedDomain`.
 *
 * MERGE RULE — deterministic FIRST-WRITER-WINS per NAME: scopes are visited in registration
 * (array) order and, within a scope, category-name insertion order; the FIRST scope to name a
 * category fixes its color, and later scopes naming the SAME category do NOT overwrite it. So a
 * given NAME ("T cells") resolves to exactly ONE stable color across all participating scopes,
 * while a category named by only one scope keeps its own. A FRESH object is always returned (the
 * caller-owned per-scope maps are never leaked by reference); values are palette entries copied
 * by reference (strings / immutable byte triples). */
export function resolveSharedCategoryColors(
  scopes: CategoryColorScope[],
  key: string,
): Record<string, PaletteEntry> | null {
  let merged: Record<string, PaletteEntry> | null = null
  for (const scope of scopes) {
    if (scope.key !== key) continue
    for (const name of Object.keys(scope.categoryColors)) {
      if (merged === null) merged = {}
      // FIRST-WRITER-WINS: keep the first color seen for this name; later scopes don't override,
      // so one NAME maps to one stable color across every scope sharing this key.
      if (!Object.prototype.hasOwnProperty.call(merged, name)) {
        merged[name] = scope.categoryColors[name]
      }
    }
  }
  return merged
}
