#!/usr/bin/env node
// Privacy guard. Raw saved-page captures are secrets: they carry conversation text,
// account identifiers and session data. Only sanitized attribute-only fixtures belong
// in this repo. Runs in CI and in `npm test` so a capture can never land silently.
//
// Rules, applied to every fixtures/**/*.html:
//   1. size must be under MAX_BYTES  (real captures are 100s of KB)
//   2. no non-whitespace text nodes  (sanitized fixtures are structure only)
//   3. no attributes outside the allowlist (no class/style/href/src/session ids)
// Anything else tracked in the repo must not be .html at all.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MAX_BYTES = 50 * 1024;

// Mirrors the convention in Tampermonkey/fixtures/chatgpt.com/2026-07-10-composer/composer.html
const ALLOWED_ATTRS = new Set([
  'id', 'role', 'contenteditable', 'type', 'placeholder', 'dir', 'disabled', 'hidden',
  'aria-label', 'aria-hidden', 'aria-expanded', 'aria-live',
  'data-testid', 'data-message-author-role', 'data-turn', 'data-turn-id',
  'data-turn-id-container', 'data-scroll-anchor', 'data-virtualkeyboard',
  'data-oracle', 'data-oracle-negative', 'data-state',
]);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const failures = [];
for (const file of walk(ROOT)) {
  if (!file.endsWith('.html')) continue;
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  if (!rel.startsWith('fixtures/')) {
    failures.push(`${rel}: HTML outside fixtures/ — captures must never be committed`);
    continue;
  }

  const raw = readFileSync(file, 'utf8');
  if (raw.length > MAX_BYTES) {
    failures.push(`${rel}: ${(raw.length / 1024).toFixed(0)} KB exceeds ${MAX_BYTES / 1024} KB — looks like a raw capture, not a sanitized fixture`);
  }

  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '');
  const text = stripped.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  if (text.length > 0) {
    failures.push(`${rel}: contains ${text.length} chars of text content — fixtures must be structure only (found: ${JSON.stringify(text.slice(0, 60))})`);
  }

  for (const [, tag] of stripped.matchAll(/<([a-zA-Z][^>]*)>/g)) {
    for (const [, attr] of tag.matchAll(/([a-zA-Z-]+)\s*=/g)) {
      if (!ALLOWED_ATTRS.has(attr.toLowerCase())) {
        failures.push(`${rel}: disallowed attribute "${attr}" — add it to ALLOWED_ATTRS only if it carries no personal data`);
      }
    }
  }
}

const unique = [...new Set(failures)];
if (unique.length) {
  console.error('capture guard FAILED:\n' + unique.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('capture guard ok');
