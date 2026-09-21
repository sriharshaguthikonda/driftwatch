'use strict';
// Pack-data lint: a pack's top-level "data" object carries site-specific
// selector lists (exclusion lists, allowlists, CSS-injection targets) that
// consumers read verbatim — the engine never compiles them. Every value must
// be a non-empty array of strings, each parsing as a selector, so a typo'd
// entry fails here instead of silently matching nothing on the live site.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const doc = new JSDOM('<!DOCTYPE html><body></body>').window.document;

for (const f of fs.readdirSync(PACKS_DIR).filter((x) => x.endsWith('.json')).sort()) {
  const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
  if (!pack.data) continue;
  test(`pack data lint: ${pack.pack || f}`, () => {
    assert.ok(Object.keys(pack.data).length > 0, '"data" must declare at least one key');
    for (const [key, value] of Object.entries(pack.data)) {
      assert.ok(Array.isArray(value), `${key}: must be an array of selector strings`);
      assert.ok(value.length > 0, `${key}: must be non-empty (drop dead lists at the source)`);
      for (const sel of value) {
        assert.equal(typeof sel, 'string', `${key}: entries must be strings`);
        assert.ok(sel.trim().length > 0, `${key}: no empty selector string`);
        let threw = null;
        try { doc.querySelectorAll(sel); } catch (e) { threw = e; }
        assert.equal(threw, null, `${key}: selector does not parse: ${sel} (${threw && threw.message})`);
      }
    }
  });
}
