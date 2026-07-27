#!/usr/bin/env node
// Privacy guard. Raw saved-page captures are secrets: they carry conversation text,
// account identifiers and session data. Only sanitized attribute-only fixtures belong
// in this repo. Runs in CI and in `npm test` so a capture can never land silently.
//
// Rules, applied to every fixtures/**/*.html:
//   1. size must be under MAX_BYTES  (real captures are 100s of KB)
//   2. no non-whitespace text nodes  (sanitized fixtures are structure only)
//   3. no attributes outside the allowlist (no class/style/href/src/session ids)
//   4. no attribute VALUE that looks like page content (email, digit run, token,
//      long value, or a multi-word phrase) — an allowed attribute name says
//      nothing about what's stuffed inside its value.
// Anything else tracked in the repo must not be .html at all.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 50 * 1024;

// Mirrors the convention in Tampermonkey/fixtures/chatgpt.com/2026-07-10-composer/composer.html
const ALLOWED_ATTRS = new Set([
  'id', 'role', 'contenteditable', 'type', 'placeholder', 'dir', 'disabled', 'hidden',
  'aria-label', 'aria-hidden', 'aria-expanded', 'aria-live',
  'data-testid', 'data-message-author-role', 'data-turn', 'data-turn-id',
  'data-turn-id-container', 'data-scroll-anchor', 'data-virtualkeyboard',
  'data-oracle', 'data-oracle-negative', 'data-state',
]);

// Attribute-value checks. Tuned against the two real committed fixtures
// (fixtures/chatgpt.com/*/turns.html): aria-labels are short phrases (<=6 words,
// well under 80 chars), and the only long-looking values are the sanitizer's own
// UUID-shaped placeholders (e.g. data-turn-id="request-WEB:<uuid>-0") — those are
// stripped out before the digit-run check so they don't false-positive.
const MAX_ATTR_VALUE_LEN = 80;
const MAX_ATTR_VALUE_WORDS = 6;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const DIGIT_RUN_RE = /\d{7,}/;
const TOKEN_PREFIX_RE = /\bsk-[A-Za-z0-9]|\beyJ[A-Za-z0-9]/;
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function decodeAttrEntities(v) {
  return v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// Returns a short reason string if `value` looks like it carries real page
// content (an identifier, a token, prose), or null if it's a safe structural
// value (a short slug/id/aria-label).
function suspiciousValueReason(value) {
  if (EMAIL_RE.test(value)) return 'looks like an email address';
  // Sanitizer-generated placeholders are UUID-shaped digit runs, not a leak —
  // strip them before checking for a long run of real digits.
  const withoutUuids = value.replace(UUID_ANYWHERE_RE, '');
  if (DIGIT_RUN_RE.test(withoutUuids)) return 'contains a 7+ digit run';
  if (TOKEN_PREFIX_RE.test(value)) return 'looks like a token (sk-/eyJ prefix)';
  if (value.length > MAX_ATTR_VALUE_LEN) return `exceeds ${MAX_ATTR_VALUE_LEN} chars (${value.length})`;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length > MAX_ATTR_VALUE_WORDS) return `${words.length} words exceeds the ${MAX_ATTR_VALUE_WORDS}-word cap`;
  return null;
}

// Short, non-reversible-looking excerpt for the failure message — never the full value.
function redactExcerpt(value) {
  const shown = value.slice(0, 16);
  return JSON.stringify(shown) + (value.length > 16 ? `…(${value.length} chars total)` : '');
}

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

const ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;

// Runs every rule against every fixtures/**/*.html under `root`. Returns the
// (deduped) list of failure strings — empty means clean.
export function runGuard(root) {
  const failures = [];
  for (const file of walk(root)) {
    if (!file.endsWith('.html')) continue;
    const rel = relative(root, file).replace(/\\/g, '/');

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
      for (const [, attr, rawValue] of tag.matchAll(ATTR_RE)) {
        const name = attr.toLowerCase();
        if (!ALLOWED_ATTRS.has(name)) {
          failures.push(`${rel}: disallowed attribute "${attr}" — add it to ALLOWED_ATTRS only if it carries no personal data`);
          continue;
        }
        const value = decodeAttrEntities(rawValue);
        const reason = suspiciousValueReason(value);
        if (reason) {
          failures.push(`${rel}: attribute "${attr}" value ${reason} — ${redactExcerpt(value)}`);
        }
      }
    }
  }
  return [...new Set(failures)];
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === thisFile) {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const failures = runGuard(ROOT);
  if (failures.length) {
    console.error('capture guard FAILED:\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log('capture guard ok');
}
