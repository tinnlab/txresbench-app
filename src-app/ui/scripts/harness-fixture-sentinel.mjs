#!/usr/bin/env node
/**
 * A stand-in server that answers `/__worktree` with a given root — the fixture for
 * "another run of THIS worktree is already on the port".
 *
 * It is a SEPARATE PROCESS, and that is the whole point. The obvious version of this
 * fixture is an `http.createServer` inside the test file, and it does not work: the
 * test drives the config through `execFileSync`, which BLOCKS the node event loop, so
 * an in-process sentinel accepts the connection and never answers while the probe is
 * waiting. `classifyOrigin` then reports `unidentified` instead of `ours` — and the
 * assertion "the config stepped over it" passes for the WRONG REASON, because a
 * config that adopts everything would also step over something it cannot identify.
 * The mutation this fixture exists to kill survives that version.
 *
 * Usage: node harness-fixture-sentinel.mjs <port> <worktreeRoot>
 * Prints `ready` on stdout once listening.
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2])
const root = process.argv[3]
if (!Number.isFinite(port) || port <= 0 || !root) {
  process.stderr.write('usage: harness-fixture-sentinel.mjs <port> <worktreeRoot>\n')
  process.exit(2)
}

createServer((req, res) => {
  if (req.url?.startsWith('/__worktree')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ worktreeRoot: root, pid: process.pid }))
    return
  }
  res.writeHead(200)
  res.end('ok')
}).listen(port, '0.0.0.0', () => process.stdout.write('ready\n'))
