'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const driftwatch = require('../src/core.js');

const { compile, resolve, audit } = driftwatch;

const FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures');
const PACKS_DIR = path.join(__dirname, '..', 'packs');

function docFrom(html, host) {
  return new JSDOM(html, { url: 'https://' + (host || 'example.test') + '/' }).window.document;
}

function loadPacks() {
  const out = {};
  if (!fs.existsSync(PACKS_DIR)) return out;
  for (const f of fs.readdirSync(PACKS_DIR).filter((x) => x.endsWith('.json'))) {
    out[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
  }
  return out;
}

// { pack, dir, file, path, isCurrent, hasCurrentSibling }.
// Dated dirs sorted ascending so the last entry per pack is its newest dated dir.
// fixtures/<pack>/current/<variant>/*.html fixtures are flagged isCurrent: true —
// several variants (mobile, streaming, logged-out...) can all be "current" at once,
// unlike dated dirs where only one is ever the newest.
function discoverFixtures(fixturesRoot) {
  fixturesRoot = fixturesRoot || FIXTURES_ROOT;
  const out = [];
  if (!fs.existsSync(fixturesRoot)) return out;
  for (const packName of fs.readdirSync(fixturesRoot).sort()) {
    const packDir = path.join(fixturesRoot, packName);
    if (!fs.statSync(packDir).isDirectory()) continue;
    const entries = fs.readdirSync(packDir).filter((d) => fs.statSync(path.join(packDir, d)).isDirectory());
    const hasCurrent = entries.includes('current');

    if (hasCurrent) {
      const currentDir = path.join(packDir, 'current');
      const variants = fs.readdirSync(currentDir)
        .filter((d) => fs.statSync(path.join(currentDir, d)).isDirectory())
        .sort();
      for (const variant of variants) {
        const dirPath = path.join(currentDir, variant);
        const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.html')).sort();
        for (const file of files) {
          out.push({ pack: packName, dir: 'current/' + variant, file, path: path.join(dirPath, file), isCurrent: true });
        }
      }
    }

    const dateDirs = entries.filter((d) => d !== 'current').sort();
    for (const dateDir of dateDirs) {
      const dirPath = path.join(packDir, dateDir);
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.html')).sort();
      for (const file of files) {
        out.push({ pack: packName, dir: dateDir, file, path: path.join(dirPath, file), isCurrent: false, hasCurrentSibling: hasCurrent });
      }
    }
  }
  return out;
}

// Pack names for which `fixtures` has zero rows. Used to enforce the ratchet
// PER PACK: the old check only looked at fixtures.length across every pack
// combined, so a newly added pack with an empty/missing fixtures/<pack>/ dir
// produced no rows and therefore no test at all — zero coverage, silently.
function missingFixturePacks(packNames, fixtures) {
  return packNames.filter((name) => !fixtures.some((f) => f.pack === name));
}

// F6: synthetic fixtures (hand-written decoys/edge cases, never real captures)
// must never become the frontier a pack is graded against. A dir opts in via
// `"_synthetic": true` in its state.json (documented alongside state — no
// separate marker file; see fixtureState() below for the same file).
function isSyntheticFixtureDir(f) {
  const p = path.join(path.dirname(f.path), 'state.json');
  if (!fs.existsSync(p)) return false;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return !!(raw && raw._synthetic === true);
}

// Newest non-synthetic dated dir per pack (last write wins = newest, fixtures
// sorted ascending by discoverFixtures). Synthetic dirs are excluded so a
// hand-written decoy can never become the strict-ratchet frontier fixture.
function computeNewestDatedDirByPack(fixtures) {
  const out = {};
  for (const f of fixtures) {
    if (!f.isCurrent && !isSyntheticFixtureDir(f)) out[f.pack] = f.dir;
  }
  return out;
}

test('F6: synthetic fixture dirs are excluded from the frontier (newestDatedDirByPack)', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-synthetic-'));
  try {
    fs.mkdirSync(path.join(tmp, 'testpack', '2026-01-01-old'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'testpack', '2026-01-01-old', 'a.html'), '<div></div>');
    fs.mkdirSync(path.join(tmp, 'testpack', '2026-02-01-synthetic'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'testpack', '2026-02-01-synthetic', 'a.html'), '<div></div>');
    fs.writeFileSync(path.join(tmp, 'testpack', '2026-02-01-synthetic', 'state.json'), JSON.stringify({ state: 'idle', _synthetic: true }));
    // No current/ dir at all for this pack — its frontier can only come from a dated dir.
    const found = discoverFixtures(tmp);
    const newest = computeNewestDatedDirByPack(found);
    assert.equal(newest.testpack, '2026-01-01-old', 'the synthetic dir (dated AFTER the real one) must never win the frontier');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit tests: compile()
// ---------------------------------------------------------------------------

test('compile: css passthrough', () => {
  assert.equal(compile({ css: 'a.b' }), 'a.b');
});

test('compile: testid default op (=)', () => {
  assert.equal(compile({ testid: 'foo' }), '[data-testid="foo"]');
});

test('compile: testid prefix op (^)', () => {
  assert.equal(compile({ testid: 'foo', op: '^' }), '[data-testid^="foo"]');
});

test('compile: testid contains op (*)', () => {
  assert.equal(compile({ testid: 'foo', op: '*' }), '[data-testid*="foo"]');
});

test('compile: attr presence only', () => {
  assert.equal(compile({ attr: 'data-x' }), '[data-x]');
});

test('compile: attr with value', () => {
  assert.equal(compile({ attr: 'data-x', value: 'y' }), '[data-x="y"]');
});

test('compile: role only', () => {
  assert.equal(compile({ role: 'textbox' }), '[role="textbox"]');
});

test('compile: role + name', () => {
  assert.equal(compile({ role: 'textbox', name: 'Foo' }), '[role="textbox"][aria-label="Foo"]');
});

test('compile: throws on unrecognized strategy', () => {
  assert.throws(() => compile({ id: 'bad' }), /bad strategy: bad/);
});

// ---------------------------------------------------------------------------
// Unit tests: resolve() — one inline jsdom document per reason
// ---------------------------------------------------------------------------

function packWith(strategies, opts) {
  return { anchors: { thing: Object.assign({ strategies }, opts) } };
}

test('resolve: primary — first strategy matches', () => {
  const doc = docFrom('<div data-testid="thing"></div>');
  const p = packWith([{ id: 's1', testid: 'thing' }]);
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'primary');
  assert.equal(r.strategyIndex, 0);
  assert.equal(r.el.getAttribute('data-testid'), 'thing');
});

test('resolve: degraded — falls through to second strategy', () => {
  const doc = docFrom('<div data-legacy="thing"></div>');
  const p = packWith([
    { id: 's1', testid: 'thing' },
    { id: 's2', attr: 'data-legacy', value: 'thing' },
  ], { risk: 'observe' });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'degraded');
  assert.equal(r.degraded, true);
  assert.equal(r.strategyIndex, 1);
});

test('resolve: fail-closed — action risk past degradeLimit', () => {
  const doc = docFrom('<div data-c="thing"></div>');
  const p = packWith([
    { id: 's1', attr: 'data-a' },
    { id: 's2', attr: 'data-b' },
    { id: 's3', attr: 'data-c' },
  ], { risk: 'action', degradeLimit: 1 });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fail-closed');
  assert.equal(r.el, null);
  assert.equal(r.strategyIndex, 2);
});

test('resolve: absent — min:0, every strategy errors out (unsupported selector)', () => {
  const doc = docFrom('<div></div>');
  const p = packWith([{ id: 's1', css: '[[[' }], { min: 0 });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'absent');
  assert.equal(r.el, null);
});

test('resolve: absent — min:0, zero plain matches (regression: was ok/primary with el undefined)', () => {
  const doc = docFrom('<div></div>');
  const p = packWith([{ id: 's1', attr: 'data-x' }], { min: 0 });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'absent');
  assert.equal(r.el, null); // must be null, never undefined
});

test('resolve: degraded — min:0, strategy[0] empty, strategy[1] matches', () => {
  const doc = docFrom('<div data-legacy="thing"></div>');
  const p = packWith([
    { id: 's1', testid: 'thing' },
    { id: 's2', attr: 'data-legacy', value: 'thing' },
  ], { min: 0 });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'degraded');
  assert.equal(r.strategyIndex, 1);
  assert.equal(r.el.getAttribute('data-legacy'), 'thing');
});

test('resolve: broken — min>=1 (default), nothing matches', () => {
  const doc = docFrom('<div></div>');
  const p = packWith([{ id: 's1', attr: 'data-x' }]);
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'broken');
  assert.equal(r.el, null);
});

test('resolve: ambiguous — more matches than max', () => {
  const doc = docFrom('<div data-x></div><div data-x></div>');
  const p = packWith([{ id: 's1', attr: 'data-x' }], { max: 1 });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
});

test('resolve: risk "action" anchor with no explicit max defaults to max:1 — two matches at strategy index 0 must be ambiguous, never resolve (F3 regression)', () => {
  const doc = docFrom('<div data-testid="thing"></div><div data-testid="thing"></div>');
  const p = packWith([{ id: 's1', testid: 'thing' }], { risk: 'action' }); // no max set
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.el, null);
});

test('resolve: risk "action" anchor with an EXPLICIT max keeps that max instead of the implicit default', () => {
  const doc = docFrom('<div data-testid="thing"></div><div data-testid="thing"></div>');
  const p = packWith([{ id: 's1', testid: 'thing' }], { risk: 'action', max: 5 });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.matchedCount, 2);
});

test('resolve: risk "observe" anchor is unaffected by the action-anchor max default — pick:"last" still works with >1 matches', () => {
  const doc = docFrom('<div data-testid="thing" id="a"></div><div data-testid="thing" id="b"></div>');
  const p = packWith([{ id: 's1', testid: 'thing' }], { risk: 'observe', pick: 'last' });
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.el.id, 'b');
});

test('resolve: unknown-anchor', () => {
  const doc = docFrom('<div></div>');
  const r = resolve({ anchors: {} }, 'nope', doc);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-anchor');
});

test('resolve: invariant — ok:true never pairs with a falsy el, across every real pack anchor on an empty scope', () => {
  const packs = loadPacks();
  const emptyScope = { querySelectorAll: () => [] };
  for (const packName of Object.keys(packs)) {
    const pack = packs[packName];
    for (const name of Object.keys(pack.anchors)) {
      const r = resolve(pack, name, emptyScope);
      if (r.ok) assert.ok(r.el, `${packName}/${name}: ok:true but el is falsy (${r.el})`);
    }
  }
});

test('audit: never reports status "ok" for an anchor with matchedCount 0', () => {
  const packs = loadPacks();
  const doc = docFrom('<div></div>');
  for (const packName of Object.keys(packs)) {
    const report = audit(packs[packName], doc);
    for (const [name, a] of Object.entries(report.anchors)) {
      if (a.matchedCount === 0) {
        assert.notEqual(a.status, 'ok', `${packName}/${name}: status "ok" with matchedCount 0`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Unit tests: requires — connected / enabled / visible / inside:<anchor>
// ---------------------------------------------------------------------------

test('resolve: requires "enabled" rejects disabled and aria-disabled elements', () => {
  const doc = docFrom(
    '<button data-testid="thing" disabled></button>' +
    '<button data-testid="thing" aria-disabled="true"></button>' +
    '<button data-testid="thing" id="ok"></button>'
  );
  const p = packWith([{ id: 's1', testid: 'thing', requires: ['enabled'] }]);
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.els.length, 1);
  assert.equal(r.el.id, 'ok');
});

test('resolve: requires "connected" rejects a detached element', () => {
  const doc = docFrom('<button data-testid="thing"></button>');
  const detached = doc.createElement('button');
  detached.setAttribute('data-testid', 'thing');
  doc.body.appendChild(detached);
  detached.remove(); // now disconnected
  const p = packWith([{ id: 's1', testid: 'thing', requires: ['connected'] }]);
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true);
  assert.equal(r.els.length, 1);
  assert.notEqual(r.el, detached);
});

test('resolve: requires "visible" — jsdom has no layout engine, reports unchecked and passes the element', () => {
  const doc = docFrom('<button data-testid="thing"></button>');
  const p = packWith([{ id: 's1', testid: 'thing', requires: ['visible'] }]);
  const r = resolve(p, 'thing', doc);
  assert.equal(r.ok, true); // unchecked treats the element as passing, never silently drops it
  assert.deepEqual(r.attempts[0].unchecked, ['visible']);
});

test('resolve: requires "inside:<anchor>" filters out elements outside the resolved anchor (the 23-copy-button case)', () => {
  const doc = docFrom(
    '<button aria-label="Copy code" id="decoy1"></button>' +
    '<button aria-label="Copy code" id="decoy2"></button>' +
    '<section data-testid="conversation-turn-1">' +
    '  <button aria-label="Copy response" id="real"></button>' +
    '</section>'
  );
  const p = {
    anchors: {
      conversationTurn: { strategies: [{ id: 'turn', testid: 'conversation-turn-', op: '^' }] },
      copyBtn: {
        pick: 'last',
        strategies: [{ id: 'copy.aria', css: 'button[aria-label^="Copy"]', requires: ['inside:conversationTurn'] }],
      },
    },
  };
  const r = resolve(p, 'copyBtn', doc);
  assert.equal(r.ok, true);
  assert.equal(r.el.id, 'real');
  assert.equal(r.els.length, 1); // both decoys filtered out
});

test('resolve: requires "inside:<anchor>" — count -2 when the referenced anchor cannot resolve', () => {
  const doc = docFrom('<button aria-label="Copy code"></button>');
  const p = {
    anchors: {
      conversationTurn: { strategies: [{ id: 'turn', testid: 'conversation-turn-', op: '^' }] },
      copyBtn: { strategies: [{ id: 'copy.aria', css: 'button[aria-label^="Copy"]', requires: ['inside:conversationTurn'] }] },
    },
  };
  const r = resolve(p, 'copyBtn', doc);
  assert.equal(r.ok, false);
  assert.equal(r.attempts[0].count, -2);
});

// ---------------------------------------------------------------------------
// Unit tests: expected / state (R2-3) and audit strategy disagreement (R2-4)
// ---------------------------------------------------------------------------

test('resolve: unknown-state — anchor has "expected" but no opts.state was given', () => {
  const doc = docFrom('<button data-testid="send"></button>');
  const p = packWith([{ id: 's1', testid: 'send' }], {
    expected: { idle: { min: 1, max: 1 }, streaming: { min: 0, max: 0 } },
  });
  const r = resolve(p, 'thing', doc); // no opts at all
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-state');
  assert.equal(r.el, null);
});

test('resolve: expected[state] overrides the anchor default min/max', () => {
  const doc = docFrom('<div></div>'); // nothing matches
  const p = packWith([{ id: 's1', attr: 'data-x' }], {
    expected: { idle: { min: 0, max: 0 } },
  });
  const r = resolve(p, 'thing', doc, { state: 'idle' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'absent'); // idle's min:0 applies, not the anchor's implicit min:1
});

test('resolve: unknown-state — a state key NOT present in the anchor\'s "expected" map (typo/whitespace) must not silently fall back to plain min/max (F4 regression)', () => {
  const packs = loadPacks();
  const pack = packs['chatgpt.com'];
  const doc = docFrom('<div></div>'); // stopButton fully rotted: zero matches on every strategy
  const r = resolve(pack, 'stopButton', doc, { state: 'streaming ' }); // trailing-space typo, not a key in expected
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-state');
});

test('audit: status "unknown-state" is counted in summary, separate from "ok"', () => {
  const doc = docFrom('<div></div>');
  const pack = {
    pack: 'test', version: 1,
    anchors: { thing: { strategies: [{ id: 's1', attr: 'data-x' }], expected: { idle: { min: 0, max: 0 } } } },
  };
  const report = audit(pack, doc);
  assert.equal(report.anchors.thing.status, 'unknown-state');
  assert.equal(report.summary['unknown-state'], 1);
  assert.equal(report.summary.ok, 0);
});

test('audit: matchedStrategies/agreeingStrategies/conflictingStrategies — two strategies match different single elements', () => {
  const doc = docFrom('<div id="a"></div><div id="b"></div>');
  const pack = {
    pack: 'test', version: 1,
    anchors: { thing: { strategies: [{ id: 's1', css: '#a' }, { id: 's2', css: '#b' }] } },
  };
  const report = audit(pack, doc);
  const a = report.anchors.thing;
  assert.equal(a.status, 'ok'); // s1 wins (index 0, primary)
  assert.equal(a.matchedStrategies, 2); // both s1 and s2 matched something
  assert.equal(a.agreeingStrategies, 1); // only the winner agrees with itself
  assert.equal(a.conflictingStrategies, 1); // s2 quietly resolved to a DIFFERENT element
});

// ---------------------------------------------------------------------------
// Unit test: discoverFixtures() current/<variant> vs dated-dir flagging (R2-5)
// ---------------------------------------------------------------------------

test('discoverFixtures: current/<variant> fixtures are flagged distinctly from dated dirs', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-fixtures-'));
  try {
    fs.mkdirSync(path.join(tmp, 'testpack', '2026-01-01-old'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'testpack', '2026-01-01-old', 'a.html'), '<div></div>');
    fs.mkdirSync(path.join(tmp, 'testpack', 'current', 'desktop'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'testpack', 'current', 'desktop', 'b.html'), '<div></div>');

    const found = discoverFixtures(tmp);
    const dated = found.find((f) => f.dir === '2026-01-01-old');
    const current = found.find((f) => f.isCurrent);

    assert.ok(dated, 'dated fixture discovered');
    assert.equal(dated.isCurrent, false);
    assert.equal(dated.hasCurrentSibling, true);
    assert.ok(current, 'current fixture discovered');
    assert.equal(current.dir, 'current/desktop');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('missingFixturePacks: flags a pack with zero fixtures even when a sibling pack has coverage (F5 regression: the old ratchet only checked the TOTAL fixture count across all packs, so a newly added empty pack produced no test at all)', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-perpack-'));
  try {
    fs.mkdirSync(path.join(tmp, 'packA', '2026-01-01'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'packA', '2026-01-01', 'a.html'), '<div></div>');
    // packB intentionally has no directory at all — simulates a newly added
    // pack whose fixtures/<pack>/ was never created.
    const found = discoverFixtures(tmp);
    assert.deepEqual(missingFixturePacks(['packA', 'packB'], found), ['packB']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture-driven audit tests — discovered at runtime, skipped gracefully if absent.
// ---------------------------------------------------------------------------

const fixtures = discoverFixtures();
const packs = loadPacks();

// R4: per-pack ratchet table. fixtures/<pack>/expected-status.json maps fixture
// dir -> { anchors: { anchorName: [allowed statuses] }, _notes: { anchor: reason } }.
// "every anchor ok" is never the bar — legitimately-absent anchors (legacy-only
// conversationTurn, state-conditioned sendButton/stopButton, streaming-removed
// editMessageButton) are pinned to `absent` here so they stop reading as drift.
function loadExpectedStatus(packName) {
  const p = path.join(FIXTURES_ROOT, packName, 'expected-status.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const perPackExpected = {};
for (const packName of Object.keys(packs)) perPackExpected[packName] = loadExpectedStatus(packName);

// S2.2: a fixture dir may carry state.json ({"state": "idle"|"composing"|"streaming"}).
// That state MUST reach audit() and every oracle/negative resolve() — a stateless
// call on a state-conditioned anchor returns unknown-state and passes vacuously.
function fixtureState(f) {
  const p = path.join(path.dirname(f.path), 'state.json');
  if (!fs.existsSync(p)) return undefined;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return raw && raw.state ? { state: raw.state } : undefined;
}

// Marker attribute values are space-separated token lists (matched with ~=).
function markerTokens(doc, attr) {
  const out = new Set();
  for (const el of doc.querySelectorAll('[' + attr + ']')) {
    for (const t of (el.getAttribute(attr) || '').split(/\s+/)) if (t) out.add(t);
  }
  return out;
}

function elsSetEqual(a, b) {
  if (a.length !== b.length) return false;
  for (const x of a) if (b.indexOf(x) === -1) return false;
  return true;
}

// Per-pack ratchet (F5): every pack declared in packs/*.json must have at
// least one discoverable fixture. Asserted per pack, not per total count, so
// a newly added pack with zero fixtures fails loudly by name instead of
// silently shipping with no coverage at all.
for (const packName of Object.keys(packs)) {
  test(`fixtures: pack "${packName}" has at least one discoverable fixture`, () => {
    const missing = missingFixturePacks([packName], fixtures);
    assert.deepEqual(missing, [], `packs/${packName}.json has zero fixtures under fixtures/${packName}/`);
  });
}

test('expected-status: a pack with an ratchet table lists every fixture dir (deleting a row silently weakens the ratchet)', () => {
  for (const packName of Object.keys(packs)) {
    const expected = perPackExpected[packName];
    if (!expected) continue;
    for (const f of fixtures.filter((x) => x.pack === packName)) {
      assert.ok(expected[f.dir], `fixtures/${packName}/expected-status.json is missing a row for "${f.dir}"`);
      assert.ok(expected[f.dir].anchors && Object.keys(expected[f.dir].anchors).length > 0,
        `fixtures/${packName}/expected-status.json row "${f.dir}" has no anchors`);
    }
  }
});

test('F3: expected-status.json content rules — no cell anywhere allows "broken" or "ambiguous"; cells under current/ allow only "ok"/"absent"', () => {
  const BANNED = new Set(['broken', 'ambiguous']);
  for (const packName of Object.keys(packs)) {
    const expected = perPackExpected[packName];
    if (!expected) continue;
    for (const [dir, row] of Object.entries(expected)) {
      if (dir.startsWith('_')) continue; // "_comment" etc, not a fixture dir
      const anchors = row && row.anchors ? row.anchors : {};
      for (const [name, allowed] of Object.entries(anchors)) {
        for (const status of allowed) {
          assert.ok(!BANNED.has(status),
            `${packName}/expected-status.json "${dir}"/"${name}" allows "${status}" — broken/ambiguous must never be ratcheted in, fix the pack or the fixture instead`);
        }
        if (dir === 'current' || dir.indexOf('current/') === 0) {
          for (const status of allowed) {
            assert.ok(status === 'ok' || status === 'absent',
              `${packName}/expected-status.json "${dir}"/"${name}" allows "${status}" — cells under current/ may only allow "ok" or "absent"`);
          }
        }
      }
    }
  }
});

test('F6: with current/ fixtures hidden, the chatgpt.com frontier is 2026-07-28-desktop — never a synthetic dir', () => {
  const nonCurrent = fixtures.filter((f) => f.pack === 'chatgpt.com' && !f.isCurrent);
  const newest = computeNewestDatedDirByPack(nonCurrent);
  assert.equal(newest['chatgpt.com'], '2026-07-28-desktop');
});

test('pack lint (R1): no strategy uses inside:exchangeRoot; per-exchange anchors only reference per-exchange anchors; document anchors only reference composerForm', () => {
  for (const [packName, pack] of Object.entries(packs)) {
    assert.ok(pack.anchors && typeof pack.anchors === 'object', `${packName}: no anchors`);
    const perExchange = new Set(
      Object.entries(pack.anchors).filter(([, a]) => a && a.scope === 'exchange').map(([n]) => n)
    );
    for (const [name, a] of Object.entries(pack.anchors)) {
      assert.ok(!a.scope || a.scope === 'exchange',
        `${packName}/${name}: unknown scope "${a.scope}" (only "exchange" is defined)`);
      for (const s of a.strategies || []) {
        for (const req of s.requires || []) {
          if (req.indexOf('inside:') !== 0) continue;
          const target = req.slice(7);
          // An exchange scope root is excluded by inside: (core.js resolves
          // descendants only), so inside:exchangeRoot can never match (R1).
          assert.notEqual(target, 'exchangeRoot',
            `${packName}/${name}: strategy ${s.id} uses inside:exchangeRoot — resolve the anchor with the exchange element as scope instead`);
          if (a.scope === 'exchange') {
            // inside: under an exchange scope may only name strict descendants
            // of the exchange, i.e. other per-exchange anchors (R1 rule 3).
            assert.ok(perExchange.has(target),
              `${packName}/${name}: per-exchange anchor's ${req} targets "${target}", which is not a strict descendant of an exchange`);
          } else {
            // Document-scoped inside: is reserved for singletons (R1 rule 3).
            assert.equal(target, 'composerForm',
              `${packName}/${name}: document-scoped anchor may only use inside:composerForm, not ${req}`);
          }
        }
      }
    }
  }
});

if (fixtures.length === 0) {
  test('fixtures: none discovered yet (skipped)', { skip: 'fixtures/**/*.html not present yet' }, () => {});
} else {
  const newestDatedDirByPack = computeNewestDatedDirByPack(fixtures); // F6: synthetic dirs excluded

  for (const f of fixtures) {
    test(`fixture: ${f.pack}/${f.dir}/${f.file}`, () => {
      const pack = packs[f.pack];
      assert.ok(pack, `no pack definition for "${f.pack}" (expected packs/${f.pack}.json)`);

      const html = fs.readFileSync(f.path, 'utf8');
      const doc = docFrom(html, f.pack);
      const opts = fixtureState(f); // S2.2: {state} from the fixture's state.json
      const report = audit(pack, doc, opts);
      // fixtures/<pack>/current/<variant>/ is always the strict frontier (several
      // variants can be "current" at once: mobile, streaming, logged-out...). Dated
      // dirs only get the strict ratchet as a fallback when no current/ exists yet.
      const isNewest = f.isCurrent || (!f.hasCurrentSibling && f.dir === newestDatedDirByPack[f.pack]);

      // A fixture is a DOM slice, not always a full page. Its declared scope is the
      // union of every oracle marker token (document, per-exchange and collection):
      // only those anchors are status-checked unless the R4 expected-status table
      // names the anchor explicitly. No markers and no table -> full-page check.
      const expected = perPackExpected[f.pack] && perPackExpected[f.pack][f.dir];
      const expectedRow = expected && expected.anchors ? expected.anchors : null;
      if (expectedRow) {
        for (const name of Object.keys(expectedRow)) {
          assert.ok(pack.anchors[name], `${f.dir}: expected-status.json lists unknown anchor "${name}"`);
        }
      }
      const scopedAnchors = new Set([
        ...markerTokens(doc, 'data-oracle'),
        ...markerTokens(doc, 'data-oracle-exchange'),
        ...markerTokens(doc, 'data-oracle-collection'),
      ]);

      for (const [name, a] of Object.entries(report.anchors)) {
        const allowed = expectedRow && expectedRow[name];
        if (allowed) {
          // R4: the ratchet bar is "status is in its allowed set", never "all ok".
          assert.ok(allowed.includes(a.status),
            `${f.dir}: anchor "${name}" status "${a.status}" not in allowed [${allowed.join(', ')}]` +
            ` — winner ${a.strategyId}, tried ${a.attempts.map((x) => `${x.id}×${x.count}`).join(', ')}`);
          continue;
        }
        if (scopedAnchors.size > 0 && !scopedAnchors.has(name)) continue;
        if (a.status === 'absent') continue;

        if (a.status === 'unknown-state') {
          const tried = a.attempts.map((x) => `${x.id}×${x.count}`).join(', ');
          assert.fail(`${f.dir}: anchor "${name}" is unknown-state — the fixture's state.json is missing or its "state" isn't a key in this anchor's expected map (F7) — tried ${tried}`);
        }

        if (a.status === 'broken' || a.status === 'ambiguous') {
          const tried = a.attempts.map((x) => `${x.id}×${x.count}`).join(', ');
          assert.fail(`${name}: ${a.status} — tried ${tried}`);
        }

        if (isNewest && a.status !== 'ok') {
          assert.fail(`reorder the pack; won with ${a.strategyId}`);
        }
      }

      // Exchange enumeration is the ONLY document-wide resolution consumers
      // perform for per-exchange concepts (R1 rule 1).
      const exchangeEls = resolve(pack, 'exchangeRoot', doc, opts).els;
      const perExchangeAnchors = new Set(
        Object.entries(pack.anchors).filter(([, a]) => a && a.scope === 'exchange').map(([n]) => n)
      );

      // Oracle identity — document-scoped singletons (data-oracle), resolved WITH
      // the fixture's state: the marked element must be exactly resolve()'s el.
      for (const el of Array.from(doc.querySelectorAll('[data-oracle]'))) {
        for (const anchorName of (el.getAttribute('data-oracle') || '').split(/\s+/).filter(Boolean)) {
          const r = resolve(pack, anchorName, doc, opts);
          assert.strictEqual(r.el, el, `oracle mismatch for anchor "${anchorName}"`);
        }
      }

      // Oracle identity — per-exchange anchors (data-oracle-exchange): the scope is
      // the marker's own exchange (el.closest('[data-turn-key]')); the resolver must
      // never jump to a neighbouring exchange.
      for (const el of Array.from(doc.querySelectorAll('[data-oracle-exchange]'))) {
        for (const anchorName of (el.getAttribute('data-oracle-exchange') || '').split(/\s+/).filter(Boolean)) {
          const ex = el.closest('[data-turn-key]');
          assert.ok(ex, `exchange oracle "${anchorName}": marker sits outside any [data-turn-key] exchange`);
          const r = resolve(pack, anchorName, ex, opts);
          assert.strictEqual(r.el, el, `exchange oracle mismatch for anchor "${anchorName}"`);
        }
      }

      // Collection oracles (S2.5): resolve('exchangeRoot', doc).els is set-equal to
      // the marked collection; userUnit/assistantUnit (marked per exchange via
      // data-oracle-exchange) and codeBlock (data-oracle-collection) are set-equal
      // per exchange, and the union over exchanges equals every marked element.
      const markedExchangeRoots = Array.from(doc.querySelectorAll('[data-oracle-collection~="exchangeRoot"]'));
      if (markedExchangeRoots.length > 0) {
        assert.ok(elsSetEqual(exchangeEls, markedExchangeRoots),
          `exchangeRoot enumeration [${exchangeEls.length}] != marked collection [${markedExchangeRoots.length}]`);
      }
      for (const ex of exchangeEls) {
        for (const [name, sel] of [
          ['userUnit', '[data-oracle-exchange~="userUnit"]'],
          ['assistantUnit', '[data-oracle-exchange~="assistantUnit"]'],
          ['codeBlock', '[data-oracle-collection~="codeBlock"]'],
        ]) {
          if (!pack.anchors[name]) continue;
          const marked = Array.from(ex.querySelectorAll(sel));
          const r = resolve(pack, name, ex, opts);
          assert.ok(elsSetEqual(r.els, marked),
            `${name}: per-exchange resolve [${r.els.length}] != marked [${marked.length}] in this exchange`);
        }
      }
      for (const [name, sel] of [
        ['userUnit', '[data-oracle-exchange~="userUnit"]'],
        ['assistantUnit', '[data-oracle-exchange~="assistantUnit"]'],
        ['codeBlock', '[data-oracle-collection~="codeBlock"]'],
      ]) {
        if (!pack.anchors[name]) continue;
        const markedAll = Array.from(doc.querySelectorAll(sel));
        if (markedAll.length === 0 && exchangeEls.length === 0) continue;
        const resolvedUnion = new Set();
        for (const ex of exchangeEls) for (const el of resolve(pack, name, ex, opts).els) resolvedUnion.add(el);
        assert.equal(resolvedUnion.size, markedAll.length,
          `${name}: per-exchange union [${resolvedUnion.size}] != every marked element [${markedAll.length}]`);
        for (const el of markedAll) {
          assert.ok(resolvedUnion.has(el), `${name}: a marked element was not resolved in its own exchange`);
        }
      }

      // S2.4 (F8): per-exchange resolution must succeed in EVERY exchange that
      // actually carries a same-kind data-oracle-exchange/data-oracle-collection
      // marker for that anchor — not just >=2 of ALL exchanges regardless of
      // marking. The old blind floor let a fixture with (say) one Copy-less
      // exchange and one real one pass on a 1-of-2 fluke, and forced every
      // >=2-exchange fixture to fully mark userUnit/assistantUnit everywhere,
      // even decoy fixtures only exercising composerForm/responseActionBar.
      // The >=2 floor is kept at the MARKED-exchange level: fewer than 2
      // exchanges carrying the marker is too sparse to assert scoping
      // behavior on, so that anchor is skipped for this fixture.
      if (exchangeEls.length >= 2) {
        for (const name of ['userUnit', 'assistantUnit', 'assistantMarkdownRoot', 'responseActionBar', 'codeBlock', 'copyResponseButton']) {
          if (!pack.anchors[name]) continue;
          const markerAttr = name === 'codeBlock' ? 'data-oracle-collection' : 'data-oracle-exchange';
          const sel = '[' + markerAttr + '~="' + name + '"]';
          const markedExchanges = exchangeEls.filter((ex) => ex.querySelector(sel));
          if (markedExchanges.length < 2) continue; // too sparse to assert scoping on
          let okCount = 0;
          for (const ex of markedExchanges) if (resolve(pack, name, ex, opts).ok) okCount += 1;
          assert.equal(okCount, markedExchanges.length,
            `${f.dir}: per-exchange anchor "${name}" resolved ok in only ${okCount} of ${markedExchanges.length} MARKED exchanges (need ALL of them)`);
        }
      }

      // Negative oracle: a decoy element must never appear in ANY anchor's els —
      // document-scoped anchors resolved on the document, per-exchange anchors
      // resolved per exchange, always with the fixture's declared state (S2.2).
      for (const el of Array.from(doc.querySelectorAll('[data-oracle-negative]'))) {
        for (const name of Object.keys(pack.anchors)) {
          if (perExchangeAnchors.has(name)) {
            for (const ex of exchangeEls) {
              const r = resolve(pack, name, ex, opts);
              assert.ok(!r.els.includes(el),
                `${f.dir}: per-exchange anchor "${name}" matched a data-oracle-negative decoy element`);
            }
          } else {
            const r = resolve(pack, name, doc, opts);
            assert.ok(!r.els.includes(el),
              `${f.dir}: anchor "${name}" matched a data-oracle-negative decoy element`);
          }
        }
      }
    });
  }
}
