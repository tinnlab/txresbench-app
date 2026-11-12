#!/usr/bin/env node
/**
 * The PRE-FLIGHT — Playwright `globalSetup` for the backend-free tiers.
 *
 * Playwright starts `webServer` entries BEFORE `globalSetup`, so by the time this
 * runs the origins either exist or they do not. It asks each one, exactly once,
 * "are you mine, and are you serving?" and refuses the whole run if any answer is
 * no.
 *
 * ## Why a pre-flight rather than a better port
 *
 * `viz-full-2.log` is 132 failed / 15 passed in 10.6 minutes against a server that
 * was not there. Every one of those 132 specs independently discovered the same
 * single fact — `net::ERR_CONNECTION_REFUSED` — and reported it as its own failure.
 * The cost was not the ten minutes; it was that 132 red specs is what a
 * catastrophic code regression looks like, so the next move is to read the diff.
 * One assertion, taken once, before any spec, converts that into a two-second
 * refusal that names the cause. A run which cannot possibly pass should cost
 * seconds.
 *
 * ## Contract
 *
 * The config publishes its origins on `process.env.HARNESS_ORIGINS` (JSON array of
 * `{label, port, url}`) at config-load time; Playwright loads the config and runs
 * globalSetup in the same process, so the value carries.
 *
 * FAIL CLOSED on a MISSING env var too. A pre-flight that quietly no-ops when its
 * input is absent is worse than none: it reports "checked" in every log while
 * checking nothing, which is how a guard survives the refactor that disconnects it.
 */
import { resolveWorktreeRoot } from '@txresbench/gallery/scripts/lib/run-key.mjs'

import { assertOriginIsOurs } from './harness-origin.mjs'

export const HARNESS_ORIGINS_ENV = 'HARNESS_ORIGINS'

/** Parse + validate the published origin list. Throws on anything malformed. */
export function readOrigins(env = process.env) {
  const raw = env[HARNESS_ORIGINS_ENV]
  if (!raw) {
    throw new Error(
      `harness-preflight: ${HARNESS_ORIGINS_ENV} is not set. The Playwright config must publish ` +
        'the origins it depends on before globalSetup runs; an unset value means the pre-flight ' +
        'has been disconnected from the config, so it is treated as a failure rather than a skip.',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`harness-preflight: ${HARNESS_ORIGINS_ENV} is not valid JSON: ${e.message}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `harness-preflight: ${HARNESS_ORIGINS_ENV} must be a non-empty array of {label, port, url}; ` +
        `got ${JSON.stringify(parsed)}. An empty list would assert nothing.`,
    )
  }
  for (const o of parsed) {
    if (!Number.isFinite(Number(o?.port)) || Number(o.port) <= 0) {
      throw new Error(`harness-preflight: origin ${JSON.stringify(o)} has no usable port`)
    }
  }
  return parsed.map(o => ({ label: o.label || `:${o.port}`, port: Number(o.port), url: o.url || '' }))
}

/** Assert every published origin. Returns the classifications (for tests). */
export async function preflight({ env = process.env, ownRoot = resolveWorktreeRoot(), fetchImpl = fetch } = {}) {
  const origins = readOrigins(env)
  const out = []
  for (const o of origins) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await assertOriginIsOurs({ ...o, ownRoot, fetchImpl }))
    // eslint-disable-next-line no-console
    console.log(`[preflight] ${o.label} :${o.port} — provably this worktree, serving. ok`)
  }
  return out
}

export default async function globalSetup() {
  await preflight()
}
