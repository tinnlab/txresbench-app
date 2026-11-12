#!/usr/bin/env node
/**
 * Load `playwright.config.ts` EXACTLY the way Playwright loads it, in a child
 * process, and print what it decided as JSON.
 *
 * This exists for one test, and that test exists because `ab51cabc`'s own surviving
 * mutation was this: Playwright re-loads a config file in the RUNNER and again in
 * EVERY WORKER, so a resolution taken at module scope is taken once per PROCESS. The
 * moment reuse became opt-in, a worker's re-resolution correctly stepped OVER the
 * server the runner had just booted and handed its specs a port nothing was listening
 * on — a live failure, with the pre-flight truthfully reporting one port while every
 * spec navigated to another.
 *
 * A same-process assertion cannot see that. Only a second process can, so the test
 * spawns this.
 *
 * Usage: node --experimental-strip-types --import ./scripts/ts-resolve.mjs \
 *          scripts/e2e-config-probe.mjs [path/to/playwright.config.ts]
 */
import { fileURLToPath } from 'node:url'

const target = process.argv[2] ?? fileURLToPath(new URL('../playwright.config.ts', import.meta.url))
const mod = await import(target)
const cfg = mod.default
const servers = Array.isArray(cfg.webServer) ? cfg.webServer : [cfg.webServer]
process.stdout.write(
  JSON.stringify({
    baseURL: cfg.use?.baseURL,
    urls: servers.map(s => s.url),
    reuse: servers.map(s => s.reuseExistingServer),
    origins: JSON.parse(process.env.HARNESS_ORIGINS ?? '[]'),
    globalSetup: cfg.globalSetup ?? null,
    // Reporter entries as plain names, so a test can assert the watchdog is present in
    // EVERY branch — a guard wired only into the default configuration switches itself
    // off under the gate that needs it most.
    reporters: (cfg.reporter ?? []).map(r => (Array.isArray(r) ? r[0] : r)),
    backend: process.env.E2E_BACKEND,
    dataDir: process.env.TXR_APP_DATA_DIR,
    // The carry that makes a worker agree with the runner.
    carry: process.env.__HARNESS_RESOLVED_app_e2e,
  }),
)
