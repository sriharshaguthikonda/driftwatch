'use strict';
// Pins tools/oracles-chatgpt.js: window.__dwMarkOracles(state) stamps the
// data-oracle* anchor contract on a synthetic chatgpt.com DOM BEFORE the
// sanitizer runs. It is idempotent (wipes stale markers first), state-gated
// (only 'idle' | 'composing' | 'streaming'), returns { exchanges, marked,
// negatives, warnings }, and never reads element text content. These cases
// cover the state matrix, stale-state removal, no token duplication, per-
// exchange anchors, collections, negative markers, the return summary, invalid
// states, and a mismatched exchange that must raise a warning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ORACLE_PATH = path.join(__dirname, '..', 'tools', 'oracles-chatgpt.js');

// Build one synthetic page string. Every visible glyph is the placeholder "x";
// no real page content and no assertions ever touch textContent. The second
// exchange e1 repeats e0's inner shape with its own keys.
const EXCHANGE_INNER = (key) =>
  '<div data-content-search-unit-key="' + key + ':0:user">' +
  '<button aria-label="Copy message">x</button>' +
  '<button aria-label="Edit message">x</button>' +
  '</div>' +
  '<div data-content-search-unit-key="' + key + ':1:assistant">' +
  '<div data-markdown-text-style="assistant-message">' +
  '<div data-markdown-copy="code-block"><button>x</button></div>' +
  '</div>' +
  '</div>' +
  '<div>' +
  '<span><button aria-label="Copy">x</button></span>' +
  '<button aria-label="Regenerate response">x</button>' +
  '<button aria-label="More actions">x</button>' +
  '</div>';

const SYNTHETIC_PAGE =
  '<form data-chatgpt-composer>' +
  '<div data-composer-markdown contenteditable="true">x</div>' +
  '<button aria-label="Dictate">x</button>' +
  '<button aria-label="Add files and more">x</button>' +
  '<button aria-label="Send">x</button>' +
  '<button aria-label="Stop">x</button>' +
  '</form>' +
  '<div data-turn-key="e0">' + EXCHANGE_INNER('e0') + '</div>' +
  '<div data-turn-key="e1">' + EXCHANGE_INNER('e1') + '</div>';

// One exchange with a single :user unit and TWO :assistant units (same inner
// shapes) — deliberately mismatched so the oracle must warn.
const MISMATCHED_PAGE =
  '<form data-chatgpt-composer>' +
  '<button aria-label="Send">x</button>' +
  '</form>' +
  '<div data-turn-key="m0">' +
  EXCHANGE_INNER('m0') +
  '<div data-content-search-unit-key="m0:2:assistant">' +
  '<div data-markdown-text-style="assistant-message"></div>' +
  '</div>' +
  '</div>';

function load(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://chatgpt.example/' });
  dom.window.eval(fs.readFileSync(ORACLE_PATH, 'utf8'));
  assert.equal(typeof dom.window.__dwMarkOracles, 'function',
    'oracle script must define window.__dwMarkOracles');
  return dom;
}

test('state matrix: composing / streaming / idle gate send vs stop buttons', () => {
  const dom = load(SYNTHETIC_PAGE);
  const w = dom.window;

  w.__dwMarkOracles('composing');
  assert.ok(dom.window.document.querySelector('[data-oracle~="sendButton"]'),
    'composing marks the Send button');
  assert.equal(dom.window.document.querySelector('[data-oracle~="stopButton"]'), null,
    'composing does not mark the Stop button');

  w.__dwMarkOracles('streaming');
  assert.ok(dom.window.document.querySelector('[data-oracle~="stopButton"]'),
    'streaming marks the Stop button');
  assert.equal(dom.window.document.querySelector('[data-oracle~="sendButton"]'), null,
    'streaming does not mark the Send button');

  w.__dwMarkOracles('idle');
  assert.equal(dom.window.document.querySelector('[data-oracle~="sendButton"]'), null,
    'idle marks neither send nor stop');
  assert.equal(dom.window.document.querySelector('[data-oracle~="stopButton"]'), null,
    'idle marks neither send nor stop');
});

test('stale-state removal: composing then idle clears the Send marker', () => {
  const dom = load(SYNTHETIC_PAGE);
  dom.window.__dwMarkOracles('composing');
  assert.ok(dom.window.document.querySelector('[data-oracle~="sendButton"]'),
    'precondition: send marked while composing');
  dom.window.__dwMarkOracles('idle');
  assert.equal(dom.window.document.querySelector('[data-oracle~="sendButton"]'), null,
    're-running idle wipes the stale send marker');
});

test('no token duplication: re-running composing keeps exact single tokens', () => {
  const dom = load(SYNTHETIC_PAGE);
  const form = dom.window.document.querySelector('form[data-chatgpt-composer]');
  const send = dom.window.document.querySelector('button[aria-label="Send"]');

  dom.window.__dwMarkOracles('composing');
  dom.window.__dwMarkOracles('composing');

  assert.equal(form.getAttribute('data-oracle'), 'composerForm',
    'form data-oracle is exactly composerForm, not duplicated');
  assert.equal(send.getAttribute('data-oracle'), 'sendButton',
    'Send button data-oracle is exactly sendButton, not duplicated');
});

test('per-exchange anchors land on the right element in each exchange', () => {
  const dom = load(SYNTHETIC_PAGE);
  dom.window.__dwMarkOracles('idle');
  const exchanges = Array.from(dom.window.document.querySelectorAll('[data-turn-key]'));

  for (const ex of exchanges) {
    assert.equal(ex.querySelectorAll('[data-oracle-exchange~="userUnit"]').length, 1,
      'exactly one userUnit per exchange');
    assert.equal(ex.querySelectorAll('[data-oracle-exchange~="assistantUnit"]').length, 1,
      'exactly one assistantUnit per exchange');
    assert.equal(ex.querySelectorAll('[data-oracle-exchange~="assistantMarkdownRoot"]').length, 1,
      'exactly one assistantMarkdownRoot per exchange');
    assert.equal(ex.querySelectorAll('[data-oracle-exchange~="responseActionBar"]').length, 1,
      'exactly one responseActionBar per exchange');
    assert.equal(ex.querySelectorAll('[data-oracle-exchange~="copyResponseButton"]').length, 1,
      'exactly one copyResponseButton per exchange');
    assert.equal(ex.querySelectorAll('[data-oracle-exchange~="editMessageButton"]').length, 1,
      'exactly one editMessageButton per exchange');

    // responseActionBar is the parent of the More actions button.
    const more = ex.querySelector('button[aria-label="More actions"]');
    assert.equal(ex.querySelector('[data-oracle-exchange~="responseActionBar"]'), more.parentElement,
      'responseActionBar lands on the More actions parent div');

    // copyResponseButton is the Copy button inside that same parent span/div.
    assert.equal(ex.querySelector('[data-oracle-exchange~="copyResponseButton"]'),
      more.parentElement.querySelector('button[aria-label="Copy"]'),
      'copyResponseButton lands on the Copy button in the action bar');
  }
});

test('collections: codeBlock and exchangeRoot counts, singular exchangeRoot', () => {
  const dom = load(SYNTHETIC_PAGE);
  dom.window.__dwMarkOracles('idle');
  const doc = dom.window.document;

  assert.equal(doc.querySelectorAll('[data-oracle-collection~="codeBlock"]').length, 2,
    'two code-block collections');
  assert.equal(doc.querySelectorAll('[data-oracle-collection~="exchangeRoot"]').length, 2,
    'both exchanges carry the exchangeRoot collection token');
  assert.equal(doc.querySelectorAll('[data-oracle~="exchangeRoot"]').length, 1,
    'only one singular exchangeRoot data-oracle anchor');

  const firstAnchor = doc.querySelector('[data-oracle~="exchangeRoot"]');
  const firstTurn = doc.querySelector('[data-turn-key]');
  assert.equal(firstAnchor, firstTurn,
    'the singular exchangeRoot is the FIRST [data-turn-key] element');
});

test('negatives: marked elements carry no positive anchor and counts match', () => {
  const dom = load(SYNTHETIC_PAGE);
  const doc = dom.window.document;
  dom.window.__dwMarkOracles('idle');

  // The four negative anchors per exchange (8), plus Dictate, Add files and
  // the idle Send/Stop decoys on the composer form.
  const negate = (sel) => assert.ok(doc.querySelector(sel), 'precondition: ' + sel);
  negate('form button[aria-label="Dictate"]');
  negate('form button[aria-label="Add files and more"]');
  negate('[data-content-search-unit-key="e0:0:user"] button[aria-label="Copy message"]');
  negate('[data-content-search-unit-key="e1:0:user"] button[aria-label="Copy message"]');
  negate('[data-turn-key="e0"] [data-markdown-copy="code-block"] button');
  negate('[data-turn-key="e1"] [data-markdown-copy="code-block"] button');

  const negativeEls = doc.querySelectorAll('[data-oracle-negative]');
  assert.equal(negativeEls.length, 12, 'exactly twelve negatively-marked elements (8 in exchanges, Dictate, Add files, idle Send, idle Stop)');

  // None of the negative anchors carries a positive data-oracle / exchange token.
  for (const el of [...negativeEls]) {
    assert.equal(el.hasAttribute('data-oracle'), false,
      'negative element has no data-oracle attribute: ' + el.getAttribute('aria-label'));
    assert.equal(el.hasAttribute('data-oracle-exchange'), false,
      'negative element has no data-oracle-exchange attribute');
  }

  const result = dom.window.__dwMarkOracles('idle');
  // Re-running idle must not change the negative count (wipes then re-marks).
  assert.equal(result.negatives, 12, 'result.negatives is 12');

  const composing = dom.window.__dwMarkOracles('composing');
  assert.equal(composing.negatives, 11, 'composing: Send is positive, Stop stays negative');
  assert.equal(doc.querySelector('button[aria-label="Send"]').hasAttribute('data-oracle-negative'), false);
  assert.equal(doc.querySelector('button[aria-label="Stop"]').getAttribute('data-oracle-negative'), '1');
});

test('return summary for a composing run on the main page', () => {
  const dom = load(SYNTHETIC_PAGE);
  const result = dom.window.__dwMarkOracles('composing');

  assert.equal(result.exchanges, 2, 'two exchanges reported');
  assert.equal(result.warnings.length, 0, 'no warnings on a well-formed page');
  assert.equal(result.marked.composerForm, 1, 'composerForm marked once');
  assert.equal(result.marked.sendButton, 1, 'sendButton marked once');
  assert.equal(result.marked.userUnit, 2, 'userUnit marked in both exchanges');
  assert.equal(result.marked.codeBlock, 2, 'codeBlock marked twice');
  assert.equal(result.marked.assistantUnit, 2, 'assistantUnit marked in both exchanges');
});

test('invalid state throws: bogus string and null', () => {
  const dom = load(SYNTHETIC_PAGE);

  assert.throws(() => dom.window.__dwMarkOracles('bogus'), /state must be/,
    'an unknown state string must throw');
  assert.throws(() => dom.window.__dwMarkOracles(null), /state must be/,
    'null must throw');
});

test('mismatched exchange: two assistant units throws (F5: warnings are capture-blocking, not silent)', () => {
  const dom = load(MISMATCHED_PAGE);

  assert.throws(() => dom.window.__dwMarkOracles('idle'),
    /assistantUnit exchange 0: found 2, expected 1/,
    'warning text surfaces in the thrown error, not element text');

  // Per-exchange marking happens before the end-of-function throw, so the DOM
  // is still mutated: the mismatched assistant units are left unmarked, but
  // the single (unambiguous) user unit in the same exchange IS marked.
  assert.equal(dom.window.document.querySelectorAll('[data-oracle-exchange~="assistantUnit"]').length, 0,
    'no assistantUnit anchor when count != 1');
  assert.equal(
    dom.window.document.querySelectorAll('[data-oracle-exchange~="assistantMarkdownRoot"]').length, 0,
    'no assistantMarkdownRoot anchor when count != 1');
  assert.ok(dom.window.document.querySelector('[data-oracle-exchange~="userUnit"]'),
    'the single user unit is still marked despite the mismatch');
});
