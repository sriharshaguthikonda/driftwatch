'use strict';
// S2.6, hardened F1: the dist staleness stamp — build.js bakes pack versions
// plus a content hash over EVERY byte after the stamp line (engine + baked
// packs) into the dist header; a consumer can assert what it vendored with
// tools/check-stamp.mjs. These tests run AFTER `node build.js` (npm test
// order), so dist/ is guaranteed fresh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { readStamp, parseStamp, computeDistSha256, STAMP_RE } = require('../tools/check-stamp.mjs');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'check-stamp.mjs');
const DIST = path.join(ROOT, 'dist', 'driftwatch.js');

// The same construction build.js uses: packs object keyed by basename.
function currentPacks() {
  const packs = {};
  const packsDir = path.join(ROOT, 'packs');
  for (const f of fs.readdirSync(packsDir).filter((x) => x.endsWith('.json'))) {
    packs[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(packsDir, f), 'utf8'));
  }
  return packs;
}

function currentStamp() {
  const packs = currentPacks();
  return {
    packs: Object.fromEntries(Object.keys(packs).sort().map((n) => [n, packs[n].version])),
    distSha256: computeDistSha256(DIST),
  };
}

// Writes a scratch copy of dist/driftwatch.js under a tmp dir so a test can
// mutate it (hand edit / CRLF / header lines) without touching the real file.
function scratchCopy(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-stamp-'));
  const dest = path.join(dir, 'driftwatch.js');
  let content = fs.readFileSync(DIST, 'utf8');
  if (mutate) content = mutate(content);
  fs.writeFileSync(dest, content);
  return dest;
}

test('dist header carries a driftwatch-stamp line matching packs/*.json', () => {
  for (const f of ['dist/driftwatch.js', 'dist/driftwatch.cjs']) {
    const stamped = readStamp(path.join(ROOT, f));
    assert.ok(stamped, `${f}: no parsable driftwatch-stamp line`);
    assert.deepEqual(stamped, currentStamp(), `${f}: stamp does not match current packs/engine`);
  }
});

test('parseStamp: shape and rejections', () => {
  const ok = parseStamp('chatgpt.com@2 dist-sha256=0123456789abcdef');
  assert.deepEqual(ok, { packs: { 'chatgpt.com': 2 }, distSha256: '0123456789abcdef' });
  assert.equal(parseStamp('chatgpt.com@2'), null); // no hash
  assert.equal(parseStamp('dist-sha256=0123456789abcdef'), null); // no packs
  assert.equal(parseStamp('chatgpt.com@2 extra-token dist-sha256=0123456789abcdef'), null); // unknown token
  assert.equal(parseStamp('chatgpt.com@two dist-sha256=0123456789abcdef'), null); // non-numeric version
});

test('check-stamp.mjs: exit 0 on the fresh dist, exit 1 on wrong expectations', () => {
  const stamp = currentStamp();
  const name = Object.keys(stamp.packs)[0];
  const good = JSON.parse(execFileSync(process.execPath, [TOOL, DIST, '--expect', `${name}@${stamp.packs[name]}`, '--expect-sha', stamp.distSha256], { encoding: 'utf8' }));
  assert.equal(good.ok, true);
  assert.equal(good.distSha256, stamp.distSha256);

  let failed = false;
  try {
    execFileSync(process.execPath, [TOOL, DIST, '--expect', `${name}@${stamp.packs[name] + 1}`], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /stamped @\d+, expected @\d+/);
  }
  assert.ok(failed, 'a wrong --expect version must exit non-zero');

  failed = false;
  try {
    execFileSync(process.execPath, [TOOL, DIST, '--expect-sha', '0000000000000000'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /dist-sha256/);
  }
  assert.ok(failed, 'a wrong --expect-sha must exit non-zero');
});

test('F1: an engine-only change (same packs) flips dist-sha256', () => {
  const stamp = currentStamp();
  // Simulate an engine change by appending a byte after the stamp line —
  // exactly what build.js would produce for a different src/*.js.
  const mutated = fs.readFileSync(DIST, 'utf8') + '\n// engine changed\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-stamp-'));
  const dest = path.join(dir, 'driftwatch.js');
  fs.writeFileSync(dest, mutated);
  const newHash = computeDistSha256(dest);
  assert.notEqual(newHash, stamp.distSha256, 'appending bytes after the stamp must change dist-sha256 even though packs are unchanged');
});

test('F1: a hand edit below the stamp line fails check-stamp.mjs (self-check, no --expect flags needed)', () => {
  const dest = scratchCopy((content) => content.replace(/\}\)\(\);\s*\n$/, '})();\n// hand edit\n'));
  assert.throws(() => execFileSync(process.execPath, [TOOL, dest], { encoding: 'utf8', stdio: 'pipe' }));
  try {
    execFileSync(process.execPath, [TOOL, dest], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    assert.match(String(e.stderr), /hand-edited or partially copied/);
  }
});

test('F1: consumer header lines pasted ABOVE the stamp do not affect the hash', () => {
  const dest = scratchCopy((content) => '// Vendored into my-project, do not edit\n// Copyright Example Corp\n' + content);
  const out = JSON.parse(execFileSync(process.execPath, [TOOL, dest], { encoding: 'utf8' }));
  assert.equal(out.ok, true, 'header lines above the stamp must not break self-check');
  assert.deepEqual(out.distSha256, currentStamp().distSha256);
});

test('F1: a CRLF-saved copy still verifies (LF-normalized hashing)', () => {
  const dest = scratchCopy((content) => content.replace(/\n/g, '\r\n'));
  const out = JSON.parse(execFileSync(process.execPath, [TOOL, dest], { encoding: 'utf8' }));
  assert.equal(out.ok, true, 'a CRLF copy of the same bytes must still self-check clean');
});

test('F1: --against a fresh dist file detects a stale vendored stamp', () => {
  // A vendored copy whose packs disagree with a "fresh" build (simulated by
  // hand-editing the stamp line's pack version) must fail --against.
  // STAMP_RE is ^-anchored without the m flag, so replacing with it on the
  // full file content only matches a stamp on line 1 — build.js writes the
  // stamp on line 2, under the "Generated by" banner, so anchor per-line
  // here or the mutation silently changes nothing and dest == DIST.
  const dest = scratchCopy((content) =>
    content.replace(/^\/\/\s*driftwatch-stamp:.*$/m, (line) => line.replace(/@(\d+)/, (m, v) => '@' + (Number(v) + 1)))
  );
  assert.throws(() => execFileSync(process.execPath, [TOOL, dest, '--against', DIST], { encoding: 'utf8', stdio: 'pipe' }));
  try {
    execFileSync(process.execPath, [TOOL, dest, '--against', DIST], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    assert.match(String(e.stderr), /stale copy/);
  }

  // --against the same fresh file as itself always passes.
  const out = JSON.parse(execFileSync(process.execPath, [TOOL, DIST, '--against', DIST], { encoding: 'utf8' }));
  assert.equal(out.ok, true);
});
