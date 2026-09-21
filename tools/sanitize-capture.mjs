#!/usr/bin/env node
// Convert a raw saved-page capture into a tiny structure-only fixture.
// Raw captures are secrets (conversation text, account ids, session data) and
// must never be copied into this repo verbatim — this strips everything
// except element nesting and a fixed attribute allowlist.
//
// The DOM-walking core lives in tools/sanitize-core.mjs (dependency-free) so the
// in-page snippet (tools/sanitize-inpage.js, generated) shares one implementation.
//
// Usage:
//   node tools/sanitize-capture.mjs --in <raw capture.html> --out <fixture.html>
//                                   [--select <css>] [--max-matches <n>]

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { ALLOWED_ATTRS, DEFAULT_SELECT, DEFAULT_LIMIT, selectRoots, sanitizeRoots } from './sanitize-core.mjs';

// Re-exported for tests and downstream tooling (these used to live in this file).
export { makeRedactor, redactValue, sanitizeElement } from './sanitize-core.mjs';

function parseArgs(argv) {
  const args = { select: DEFAULT_SELECT, maxMatches: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--select') args.select = argv[++i];
    else if (a === '--max-matches') args.maxMatches = Number(argv[++i]);
  }
  if (!args.in || !args.out) {
    console.error('Usage: node tools/sanitize-capture.mjs --in <raw.html> --out <fixture.html> [--select <css>] [--max-matches <n>]');
    process.exit(1);
  }
  return args;
}

// Parses `html`, picks up to `maxMatches` elements matching `select` per
// selector, and returns the sanitized body markup plus element/attr counts.
// Pure function (no filesystem access) so it's reusable from the CLI and tests.
export function sanitizeCapture(html, { select = DEFAULT_SELECT, maxMatches = DEFAULT_LIMIT } = {}) {
  const doc = new JSDOM(html).window.document;
  return sanitizeRoots(selectRoots(doc, select, maxMatches));
}

function captureDate(inPath, outPath) {
  const dateInDirName = /(\d{4}-\d{2}-\d{2})/.exec(dirname(outPath));
  if (dateInDirName) return dateInDirName[1];
  return statSync(inPath).mtime.toISOString().slice(0, 10);
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const html = readFileSync(args.in, 'utf8');
  const { body, stats } = sanitizeCapture(html, { select: args.select, maxMatches: args.maxMatches });

  const header = `<!--
Sanitized structure-only fixture. Source capture: "${basename(args.in)}", captured ${captureDate(args.in, args.out)}.
Attributes stripped to a fixed allowlist (${[...ALLOWED_ATTRS].join(', ')}) — no classes, no href/src,
no session/cookie/query-string data. All text content and svg internals dropped; identifier-shaped
attribute values (UUIDs, long hex/base64 tokens) replaced with stable synthetic placeholders.
data-oracle / data-oracle-negative markers added by hand afterward.
-->
`;

  const outputHtml = header + body;
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, outputHtml, 'utf8');

  console.log(
    `${stats.elements} elements, ${stats.attrs} attributes, ${Buffer.byteLength(outputHtml, 'utf8')} bytes -> ${args.out}`
  );
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === thisFile) {
  runCli();
}
