#!/usr/bin/env node
// stripe-sign.mjs — the B0 signed-webhook injector, exposed to SHELL tiers.
//
// A thin, dependency-free Node shim over the SAME Stripe signature scheme the Rust
// injector (tests/common/stripe_sim.rs) implements: HMAC-SHA256 over `"{t}.{raw}"`,
// keyed by the local `whsec_`, emitted as `Stripe-Signature: t=<t>,v1=<hex>`. It uses
// Node's `crypto` (OpenSSL) — an INDEPENDENT implementation from RustCrypto — so a
// matching signature across the two is real cross-implementation evidence of
// byte-exactness (PROV-B0-2). 100% local, no network.
//
// Usage:
//   printf '%s' "$BODY" | node scripts/stripe-sign.mjs sign --secret S --ts T
//        → prints "t=T,v1=<hex>"
//   printf '%s' "$BODY" | node scripts/stripe-sign.mjs verify --secret S --sig H [--tolerance N] [--now U]
//        → exit 0 (valid) / 1 (invalid), reason on stderr
//   node scripts/stripe-sign.mjs --selftest
//        → checks the shim against the embedded OpenSSL known-answer vector (must match
//          KAT_V1 in stripe_sim.rs — the shared byte-exact anchor)

import crypto from 'node:crypto';

const DEFAULT_TOLERANCE = 300;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    if (process.stdin.isTTY) resolve(Buffer.alloc(0));
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

// The hex v1 signature over `"{ts}.{raw}"`, keyed by the whsec string.
function v1Signature(rawBody, whsec, ts) {
  return crypto
    .createHmac('sha256', whsec)
    .update(`${ts}.`)
    .update(rawBody)
    .digest('hex');
}

function signHeader(rawBody, whsec, ts) {
  return `t=${ts},v1=${v1Signature(rawBody, whsec, ts)}`;
}

// Constant-time compare of two hex strings.
function ctEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verify(rawBody, header, whsec, tolerance, now) {
  let t = null;
  const v1s = [];
  for (const el of String(header).split(',')) {
    const [k, v] = el.trim().split('=');
    if (k === 't') t = parseInt(v, 10);
    else if (k === 'v1') v1s.push(v);
  }
  if (t === null || Number.isNaN(t)) return { ok: false, reason: 'MissingTimestamp' };
  if (v1s.length === 0) return { ok: false, reason: 'NoV1Scheme' };
  if (now - t > tolerance) return { ok: false, reason: 'TimestampOutOfTolerance' };
  const expected = v1Signature(rawBody, whsec, t);
  if (v1s.some((got) => ctEq(got, expected))) return { ok: true };
  return { ok: false, reason: 'SignatureMismatch' };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === '--selftest') {
    // The shared byte-exact anchor — identical to KAT_* in stripe_sim.rs, and to the
    // value `openssl dgst -sha256 -hmac` produces for the same inputs.
    const secret = 'whsec_b0_local_test_secret';
    const ts = 1700000000;
    const body = '{"id":"evt_test_b0","object":"event","type":"checkout.session.completed"}';
    const KAT = '72a3eec1985eb2895f730aadbda5fd29e7a9cdfd8665f6ac7bd4487399f8e09e';
    const got = v1Signature(Buffer.from(body), secret, ts);
    if (got !== KAT) {
      console.error(`[stripe-sign] SELFTEST FAIL: v1=${got} != KAT ${KAT}`);
      process.exit(1);
    }
    // roundtrip + a tampered-body reject
    const header = signHeader(Buffer.from(body), secret, ts);
    const good = verify(Buffer.from(body), header, secret, DEFAULT_TOLERANCE, ts);
    const bad = verify(Buffer.from(body + 'X'), header, secret, DEFAULT_TOLERANCE, ts);
    if (!good.ok || bad.ok) {
      console.error('[stripe-sign] SELFTEST FAIL: verify roundtrip/negative-control');
      process.exit(1);
    }
    console.error('[stripe-sign] SELFTEST PASS (matches the OpenSSL/Rust byte-exact KAT)');
    process.exit(0);
  }

  const args = parseArgs(rest);
  const body = await readStdin();

  if (cmd === 'sign') {
    const secret = args.secret || 'whsec_b0_local_test_secret';
    const ts = args.ts ? parseInt(args.ts, 10) : Math.floor(Date.now() / 1000);
    process.stdout.write(signHeader(body, secret, ts) + '\n');
    process.exit(0);
  }

  if (cmd === 'verify') {
    const secret = args.secret || 'whsec_b0_local_test_secret';
    const tolerance = args.tolerance ? parseInt(args.tolerance, 10) : DEFAULT_TOLERANCE;
    const now = args.now ? parseInt(args.now, 10) : Math.floor(Date.now() / 1000);
    const res = verify(body, args.sig || '', secret, tolerance, now);
    if (res.ok) {
      console.error('[stripe-sign] verify OK');
      process.exit(0);
    }
    console.error(`[stripe-sign] verify REJECTED: ${res.reason}`);
    process.exit(1);
  }

  console.error('usage: stripe-sign.mjs {sign|verify|--selftest} [--secret S] [--ts T] [--sig H] [--tolerance N] [--now U]  (body on stdin)');
  process.exit(2);
}

main();
