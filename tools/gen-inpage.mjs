#!/usr/bin/env node
// Generates tools/sanitize-inpage.js — the browser-runnable twin of the node
// sanitizer — from tools/sanitize-core.mjs, so both share ONE implementation.
// The core is dependency-free; stripping its leading `export ` keywords makes
// it a valid plain-script body. test/sanitize-inpage.test.js fails if the
// committed twin ever drifts from the core.
//
// Usage: node tools/gen-inpage.mjs   (run after every edit to sanitize-core.mjs)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(TOOLS_DIR, 'sanitize-core.mjs');
const OUT_PATH = join(TOOLS_DIR, 'sanitize-inpage.js');

const HEADER = `// GENERATED FILE — do not edit by hand. Regenerate with: node tools/gen-inpage.mjs
// In-page sanitizer (clipboard-bridge capture path, 2026-09 churn S1.3): defines
// window.__dwSanitize(rootSelectors, opts) returning the sanitized HTML string,
// using the SAME allowlist/redaction core as the node CLI (tools/sanitize-capture.mjs).
// Runs as a plain <script> — no top-level import/export, no node globals.`;

const WRAPPER = `// In-page entry point (generated wrapper; edit tools/gen-inpage.mjs, not this file).
// rootSelectors: one CSS selector string or an array of them. Each selector
// contributes at most opts.limit matched subtrees in document order (default 10);
// an element matched by several selectors is emitted only once.
window.__dwSanitize = function (rootSelectors, opts) {
  if (rootSelectors == null) return '';
  var limit = opts && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  return sanitizeRoots(selectRoots(document, rootSelectors, limit)).body;
};`;

export function generateInpageSource() {
  const core = readFileSync(CORE_PATH, 'utf8').replace(/^export /gm, '').trimEnd();
  return `${HEADER}

(function () {
'use strict';

${core}

${WRAPPER}
})();
`;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === thisFile) {
  writeFileSync(OUT_PATH, generateInpageSource(), 'utf8');
  console.log('wrote ' + OUT_PATH);
}
