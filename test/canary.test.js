'use strict';
// S7.1 (churn 2026-09 plan, review finding 16): canary forwards opts to
// dw.audit so state-conditioned anchors stop reporting unknown-state, while
// the legacy 3-argument form (onDegrade in the opts slot) keeps working.
// canary owns one fingerprint per process (single shared closure state), so
// each test here uses a DIFFERENT document to force fingerprint changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dw = require('../dist/driftwatch.cjs');

// Minimal pack: `sender` is state-conditioned like chatgpt.com's sendButton,
// `widget` is a plain observe anchor used to force a degraded/broken summary.
const PACK = {
  pack: 'mini',
  version: 1,
  anchors: {
    widget: {
      risk: 'observe',
      strategies: [{ id: 'w.attr', attr: 'data-widget' }],
    },
    sender: {
      risk: 'action',
      degradeLimit: 0,
      min: 0,
      expected: { on: { min: 1, max: 1 }, off: { min: 0, max: 0 } },
      strategies: [{ id: 's.css', css: 'button[data-x="send"]' }],
    },
  },
};

function docOf(html) {
  return new JSDOM(html).window.document;
}

test('canary forwards opts to audit: a state-conditioned anchor is not unknown-state when a state is passed', () => {
  const doc = docOf('<button data-x="send"></button>');
  const report = dw.canary(PACK, doc, { state: 'on' });
  assert.equal(report.anchors.sender.status, 'ok', 'state must reach audit (ok, not unknown-state)');
  assert.equal(report.anchors.sender.strategyIndex, 0);
  // Negative control on the SAME document: stateless audit reports unknown-state.
  const stateless = dw.audit(PACK, doc);
  assert.equal(stateless.anchors.sender.status, 'unknown-state');
});

test('canary legacy 3-argument call still works (function in the opts slot)', () => {
  const doc = docOf('<div data-widget="a"></div><button data-x="send"></button>');
  let fired = 0;
  const report = dw.canary(PACK, doc, () => { fired += 1; });
  assert.ok(report && report.anchors, 'legacy call must still return a report');
  assert.equal(report.anchors.sender.status, 'unknown-state', 'legacy call passes no state, as before');
  assert.equal(fired, 0, 'nothing is degraded on this document, so onDegrade stays quiet');
  assert.ok(Array.isArray(dw.canary.history()));
});

test('onDegrade fires on a newly degraded legacy-call report (fingerprint change)', () => {
  const doc = docOf('<button data-x="send"></button>'); // widget missing -> broken
  let fired = 0;
  const report = dw.canary(PACK, doc, () => { fired += 1; });
  assert.equal(report.anchors.widget.status, 'broken');
  assert.equal(fired, 1, 'a broken-in-new-fingerprint report must call onDegrade once');
});
