'use strict';
// F1 regression: tools/check-no-captures.mjs must inspect attribute VALUES,
// not just attribute names. A leak hidden inside an allowed attribute (e.g.
// aria-label carrying an email address) must fail the gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeFixtureRoot(html) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-guard-'));
  const dir = path.join(tmp, 'fixtures', 'testpack', '2026-01-01-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'f.html'), html, 'utf8');
  return tmp;
}

test('runGuard: rejects an email address hidden inside an allowlisted attribute value', async () => {
  const { runGuard } = await import('../tools/check-no-captures.mjs');
  const tmp = makeFixtureRoot(
    '<button aria-label="Copy reply to jane.doe@example.com re: invoice 4521"></button>'
  );
  try {
    const failures = runGuard(tmp);
    assert.ok(failures.length > 0, 'expected at least one failure for the leaked email/aria-label');
    assert.ok(
      failures.some((f) => f.includes('aria-label')),
      `expected a failure mentioning aria-label, got: ${JSON.stringify(failures)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runGuard: never prints the full leaked value in a failure message', async () => {
  const { runGuard } = await import('../tools/check-no-captures.mjs');
  const tmp = makeFixtureRoot(
    '<button aria-label="Copy reply to jane.doe@example.com re: invoice 4521"></button>'
  );
  try {
    const failures = runGuard(tmp);
    for (const f of failures) {
      assert.ok(!f.includes('jane.doe@example.com'), `failure message leaked the full value: ${f}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runGuard: real-fixture-shaped legitimate attribute values pass clean', async () => {
  const { runGuard } = await import('../tools/check-no-captures.mjs');
  const tmp = makeFixtureRoot(
    '<div aria-label="Copy response" data-testid="conversation-turn-1" ' +
    'data-turn-id="request-WEB:00000000-0000-4000-8000-000000000002-0"></div>'
  );
  try {
    const failures = runGuard(tmp);
    assert.deepEqual(failures, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
