'use strict';
// Pack-data lint: a pack's top-level "data" object carries site-specific
// selector lists (exclusion lists, allowlists, CSS-injection targets) and
// regex-source lists that consumers read verbatim. Every value must be a
// non-empty array of strings that parses as its declared data type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const doc = new JSDOM('<!DOCTYPE html><body></body>').window.document;
const REGEX_KEYS = new Set(['conversationPathPatterns']);

for (const f of fs.readdirSync(PACKS_DIR).filter((x) => x.endsWith('.json')).sort()) {
  const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
  if (!pack.data) continue;
  test(`pack data lint: ${pack.pack || f}`, () => {
    assert.ok(Object.keys(pack.data).length > 0, '"data" must declare at least one key');
    for (const [key, value] of Object.entries(pack.data)) {
      assert.ok(Array.isArray(value), `${key}: must be an array of strings`);
      assert.ok(value.length > 0, `${key}: must be non-empty (drop dead lists at the source)`);
      for (const sel of value) {
        assert.equal(typeof sel, 'string', `${key}: entries must be strings`);
        assert.ok(sel.trim().length > 0, `${key}: no empty string`);
        let threw = null;
        try {
          if (REGEX_KEYS.has(key)) new RegExp(sel);
          else doc.querySelectorAll(sel);
        } catch (e) { threw = e; }
        assert.equal(threw, null, `${key}: entry does not parse: ${sel} (${threw && threw.message})`);
      }
    }
  });
}
