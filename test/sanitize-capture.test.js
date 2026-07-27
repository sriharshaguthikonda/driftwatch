'use strict';
// F2 regression: tools/sanitize-capture.mjs's HEX_RE/B64_RE were anchored
// (^...$) and only tested the WHOLE attribute value, so a hex/base64 secret
// embedded inside a compound value (e.g. "request-WEB:<hex>-0") shipped
// verbatim. redactValue() must catch it as a global substring pass, the same
// way UUID_G already does.
const test = require('node:test');
const assert = require('node:assert/strict');

test('redactValue: redacts a 32-char hex token embedded in a compound value', async () => {
  const { redactValue, makeRedactor } = await import('../tools/sanitize-capture.mjs');
  const redact = makeRedactor();
  const input = 'request-WEB:a1b2c3d4e5f60718a1b2c3d4e5f60718-0';
  const result = redactValue(input, redact);
  assert.notEqual(result, input, 'hex token must not survive verbatim');
  assert.ok(result.startsWith('request-WEB:'), 'prefix shape must be preserved');
  assert.ok(result.endsWith('-0'), 'suffix shape must be preserved');
});

test('redactValue: redacts a base64-shaped token embedded in a compound value', async () => {
  const { redactValue, makeRedactor } = await import('../tools/sanitize-capture.mjs');
  const redact = makeRedactor();
  const input = 'sess:QWxhZGRpbjpvcGVuc2VzYW1lMTIz-x';
  const result = redactValue(input, redact);
  assert.notEqual(result, input, 'base64 token must not survive verbatim');
  assert.ok(result.startsWith('sess:'), 'prefix shape must be preserved');
  assert.ok(result.endsWith('-x'), 'suffix shape must be preserved');
});

test('redactValue: still redacts a UUID embedded in a compound value (no regression)', async () => {
  const { redactValue, makeRedactor } = await import('../tools/sanitize-capture.mjs');
  const redact = makeRedactor();
  const input = 'request-WEB:00000000-0000-4000-8000-000000000002-0';
  const result = redactValue(input, redact);
  assert.ok(result.startsWith('request-WEB:'));
  assert.ok(result.endsWith('-0'));
});

test('redactValue: leaves short structural slugs untouched', async () => {
  const { redactValue, makeRedactor } = await import('../tools/sanitize-capture.mjs');
  const redact = makeRedactor();
  assert.equal(redactValue('conversation-turn-1', redact), 'conversation-turn-1');
  assert.equal(redactValue('composer-submit-button', redact), 'composer-submit-button');
});
