'use strict';
// S1.3 (2026-09 churn): tools/sanitize-inpage.js is the browser-runnable twin of
// the node sanitizer, generated from the shared core (tools/sanitize-core.mjs).
// These tests pin the twin to the core: byte-freshness, no top-level
// import/export (must run as a plain <script>), behaviour identical to the node
// tool under jsdom, and output the privacy guard accepts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const INPAGE_PATH = path.join(__dirname, '..', 'tools', 'sanitize-inpage.js');

// Synthetic RFC-4122 example UUID — never real data.
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const SYNTHETIC_PAGE =
  '<div data-turn-key="' + UUID + '">' +
  '<span data-content-search-unit-key="' + UUID + ':2:assistant" data-markdown-text-style="assistant-message">' +
  '<div data-markdown-copy="code-block"><div contenteditable="true" role="textbox" aria-label="Edit code"></div></div>' +
  '</span>' +
  '<span data-content-search-unit-key="' + UUID + ':0:user"></span>' +
  '</div>' +
  '<form><div data-composer-markdown contenteditable="true" role="textbox" aria-label="Ask anything"></div>' +
  '<button type="submit" aria-label="Send"></button></form>';

function loadInPage(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://chatgpt.example/' });
  dom.window.eval(fs.readFileSync(INPAGE_PATH, 'utf8'));
  assert.equal(typeof dom.window.__dwSanitize, 'function', 'snippet must define window.__dwSanitize');
  return dom;
}

test('in-page snippet is byte-identical to what gen-inpage.mjs generates from the core', async () => {
  const { generateInpageSource } = await import('../tools/gen-inpage.mjs');
  assert.strictEqual(fs.readFileSync(INPAGE_PATH, 'utf8'), generateInpageSource(),
    'tools/sanitize-inpage.js is stale — regenerate with: node tools/gen-inpage.mjs');
});

test('in-page snippet is a plain script: no top-level import/export statements', () => {
  const src = fs.readFileSync(INPAGE_PATH, 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m, 'a top-level import/export would break a <script> paste');
  assert.ok(/window\.__dwSanitize\s*=/.test(src), 'defines window.__dwSanitize');
});

test('__dwSanitize returns exactly what the node tool returns for the same document', async () => {
  const { sanitizeCapture } = await import('../tools/sanitize-capture.mjs');
  const dom = loadInPage(SYNTHETIC_PAGE);
  const inPage = dom.window.__dwSanitize('[data-turn-key]', { limit: 10 });
  const nodeTool = sanitizeCapture(SYNTHETIC_PAGE, { select: '[data-turn-key]', maxMatches: 10 }).body;
  assert.strictEqual(inPage, nodeTool);
  assert.ok(!inPage.includes(UUID), 'raw uuid must not survive');
  assert.ok(inPage.includes(':2:assistant') && inPage.includes(':0:user'), 'index+role suffixes preserved');
});

test('__dwSanitize accepts an array of root selectors with a per-selector limit', () => {
  const dom = loadInPage(SYNTHETIC_PAGE);
  const out = dom.window.__dwSanitize(['[data-turn-key]', 'form'], { limit: 1 });
  assert.ok(out.includes('data-turn-key='), 'first exchange root captured');
  assert.ok(out.includes('data-composer-markdown'), 'composer form captured as a separate root');
});

test('__dwSanitize defaults to limit 10 per selector (MAX_MATCHES raised from 2)', () => {
  const exchanges = Array.from({ length: 12 }, (_, i) => '<div data-turn-key="ex-' + i + '"></div>').join('');
  const dom = loadInPage(exchanges);
  const out = dom.window.__dwSanitize('[data-turn-key]');
  assert.equal((out.match(/<div data-turn-key=/g) || []).length, 10);
});

test('__dwSanitize output passes the privacy guard (check-no-captures)', async () => {
  const { runGuard } = await import('../tools/check-no-captures.mjs');
  const dom = loadInPage(SYNTHETIC_PAGE);
  const html = dom.window.__dwSanitize(['[data-turn-key]', 'form'], { limit: 10 });
  assert.ok(html.length > 0, 'expected a non-empty sanitized document');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'driftwatch-inpage-'));
  try {
    const dir = path.join(tmp, 'fixtures', 'testpack', '2026-01-01-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f.html'), html, 'utf8');
    assert.deepEqual(runGuard(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
