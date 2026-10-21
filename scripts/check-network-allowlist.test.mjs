#!/usr/bin/env node
// check-network-allowlist.test.mjs — negative controls for
// `scripts/check-network-allowlist.sh`.
//
// Each assertion drives the REAL guard as a subprocess over a synthetic fixture
// tree and reads the process's OWN exit status (never a piped `$?`).
//
//   node --test scripts/check-network-allowlist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'check-network-allowlist.sh');

function run(allowlist, roots, locks, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'netguard-'));
  const aFile = path.join(dir, 'allowlist.txt');
  fs.writeFileSync(aFile, allowlist);
  const r = spawnSync(
    'bash',
    [GUARD, `--allowlist=${aFile}`, `--roots=${roots.join(',')}`, `--locks=${locks.join(',')}`, ...extraArgs],
    { cwd: REPO, encoding: 'utf-8' },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const EMPTY_LOCKS = process.env.TMPDIR
  ? []
  : [];

function fixtureTree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'netguard-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// A synthetic lockfile with no telemetry names anywhere.
const CLEAN_LOCK = `# nothing to see
[[package]]
name = "axum"
version = "0.8.4"
`;

test('passes on a clean tree (loopback + allowlisted host only)', () => {
  const src = fixtureTree({
    'src/main.rs': 'const A: &str = "http://127.0.0.1:3100/api";\nconst B: &str = "https://ghcr.io/org/env";\n',
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('ghcr.io\n', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('ignores hosts inside comments and #[cfg(test)] blocks', () => {
  const src = fixtureTree({
    'src/main.rs': [
      '// fetch from https://evil-attacker.example-corp.com/annotate',
      '/// https://doc.example-corpx.com',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    const URL: &str = "https://testonly.example-corpx.com/path";',
      '}',
      '',
      'const OK: &str = "http://localhost:1234";',
      '',
    ].join('\n'),
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('fails when non-test source adds a host outside the allowlist', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "https://telemetry.example-corp.com/collect";\n',
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('ghcr.io\n', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 1, 'guard must fail on a new host');
  assert.match(r.stderr, /telemetry\.example-corp\.com/);
});

test('fails when a telemetry crate appears in a lockfile', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "http://127.0.0.1:3100/api";\n',
  });
  const locks = fixtureTree({
    'Cargo.lock': `[[package]]
name = "sentry"
version = "0.36.0"
`,
  });
  const r = run('', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 1, 'guard must fail on a telemetry crate');
  assert.match(r.stderr, /sentry/);
});

test('fails when a telemetry package appears in an npm lockfile', () => {
  const src = fixtureTree({
    'src/ui.ts': 'const U = await fetch(`http://127.0.0.1:3100/api`)\n',
  });
  const locks = fixtureTree({
    'package-lock.json': `{
  "name": "x",
  "packages": {
    "node_modules/posthog-js": { "version": "1.0.0" }
  }
}
`,
    'Cargo.lock': CLEAN_LOCK,
  });
  const r = run('', [path.join(src, 'src')], [
    path.join(locks, 'Cargo.lock'),
    path.join(locks, 'package-lock.json'),
  ]);
  assert.equal(r.status, 1, 'guard must fail on a telemetry npm package');
  assert.match(r.stderr, /posthog/);
});

test('does not trip on names that merely contain telemetry substrings', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "http://127.0.0.1:3100/api";\n',
  });
  const locks = fixtureTree({
    'Cargo.lock': `[[package]]
name = "overlayscrollbars"
version = "2.0.0"
[[package]]
name = "line-segment"
version = "1.0.0"
`,
  });
  const r = run('', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
