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

// ---------------------------------------------------------------------------
// Fixture-driven audit tests — discovered at runtime, skipped gracefully if absent.
// ---------------------------------------------------------------------------

const fixtures = discoverFixtures();

if (fixtures.length === 0) {
  test('fixtures: none discovered yet (skipped)', { skip: 'fixtures/**/*.html not present yet' }, () => {});
} else {
  const packs = loadPacks();
  const newestDatedDirByPack = {};
  for (const f of fixtures) {
    if (!f.isCurrent) newestDatedDirByPack[f.pack] = f.dir; // last write per pack wins = newest (sorted ascending)
  }

  for (const f of fixtures) {
    test(`fixture: ${f.pack}/${f.dir}/${f.file}`, () => {
      const pack = packs[f.pack];
      assert.ok(pack, `no pack definition for "${f.pack}" (expected packs/${f.pack}.json)`);

      const html = fs.readFileSync(f.path, 'utf8');
      const doc = docFrom(html, f.pack);
      const report = audit(pack, doc);
      // fixtures/<pack>/current/<variant>/ is always the strict frontier (several
      // variants can be "current" at once: mobile, streaming, logged-out...). Dated
      // dirs only get the strict ratchet as a fallback when no current/ exists yet.
      const isNewest = f.isCurrent || (!f.hasCurrentSibling && f.dir === newestDatedDirByPack[f.pack]);

      // A fixture is a DOM slice, not always a full page (e.g. "*-turns" fixtures
      // capture only the conversation-turn subtree, never composer/send/stop). If the
      // fixture declares oracle targets, that IS its declared scope: only anchors named
      // by a data-oracle marker are checked here. No oracle markers at all → full-page
      // fixture, check every anchor (original behavior).
      const scopedAnchors = new Set(
        Array.from(doc.querySelectorAll('[data-oracle]')).map((el) => el.getAttribute('data-oracle'))
      );

      for (const [name, a] of Object.entries(report.anchors)) {
        if (scopedAnchors.size > 0 && !scopedAnchors.has(name)) continue;
        if (a.status === 'absent') continue;

        if (a.status === 'broken' || a.status === 'ambiguous') {
          const tried = a.attempts.map((x) => `${x.id}×${x.count}`).join(', ');
          assert.fail(`${name}: ${a.status} — tried ${tried}`);
        }

        if (isNewest && a.status !== 'ok') {
          assert.fail(`reorder the pack; won with ${a.strategyId}`);
        }
      }

      // Oracle identity: the element a fixture marks as the true anchor target
      // must be exactly the element resolve() returns.
      for (const el of Array.from(doc.querySelectorAll('[data-oracle]'))) {
        const anchorName = el.getAttribute('data-oracle');
        const r = resolve(pack, anchorName, doc);
        assert.strictEqual(r.el, el, `oracle mismatch for anchor "${anchorName}"`);
      }

      // Negative oracle: a decoy element must never appear in any anchor's match set.
      for (const el of Array.from(doc.querySelectorAll('[data-oracle-negative]'))) {
        for (const name of Object.keys(pack.anchors)) {
          const r = resolve(pack, name, doc);
          assert.ok(!r.els.includes(el), `anchor "${name}" matched a data-oracle-negative decoy element`);
        }
      }
    });
  }
}
