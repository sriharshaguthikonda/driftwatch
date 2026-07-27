#!/usr/bin/env node
// Convert a raw saved-page capture into a tiny structure-only fixture.
// Raw captures are secrets (conversation text, account ids, session data) and
// must never be copied into this repo verbatim — this strips everything
// except element nesting and a fixed attribute allowlist.
//
// Usage:
//   node tools/sanitize-capture.mjs --in <raw capture.html> --out <fixture.html> [--select <css>]

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ALLOWED_ATTRS = new Set([
  'id', 'role', 'contenteditable', 'type', 'placeholder', 'dir', 'disabled', 'hidden',
  'aria-label', 'aria-hidden', 'aria-expanded', 'aria-live',
  'data-testid', 'data-message-author-role', 'data-turn', 'data-turn-id',
  'data-turn-id-container', 'data-scroll-anchor', 'data-virtualkeyboard', 'data-state',
]);
const SKIP_TAGS = new Set(['script', 'style', 'link', 'noscript']);
const DEFAULT_SELECT = '[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"]';
const MAX_MATCHES = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same shape, unanchored + global: catches a UUID embedded in a compound value
// like "request-WEB:<uuid>-0" — real captures do this for data-turn-id.
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Hex/base64 token passes, global just like UUID_G: a token embedded in a
// compound value (e.g. "sess:<hex>-x") must be redacted too, not just a value
// that is ENTIRELY hex/base64 top to bottom. 16+ minimum keeps short
// structural slugs ("conversation-turn-1", "composer-submit-button") out of
// scope — none of them have a 16-char run without a hyphen/space breaking it.
const HEX_G = /[0-9a-f]{16,}/gi;
const B64_G = /[A-Za-z0-9+/]{16,}={0,2}/g;
// Tried in this order at every position via alternation: a UUID-shaped run
// wins over a plain hex run over a plain base64 run, so a value is never
// redacted twice and the UUID's dashed shape is preserved as before.
const SECRET_G = new RegExp(`${UUID_G.source}|${HEX_G.source}|${B64_G.source}`, 'gi');

function parseArgs(argv) {
  const args = { select: DEFAULT_SELECT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--select') args.select = argv[++i];
  }
  if (!args.in || !args.out) {
    console.error('Usage: node tools/sanitize-capture.mjs --in <raw.html> --out <fixture.html> [--select <css>]');
    process.exit(1);
  }
  return args;
}

// Stable synthetic placeholder generator: the same source value always maps
// to the same placeholder; values are numbered in first-seen order so the
// output is deterministic across runs on the same capture.
export function makeRedactor() {
  const seen = new Map();
  let counter = 0;
  return function redact(value) {
    if (seen.has(value)) return seen.get(value);
    counter += 1;
    const placeholder = UUID_RE.test(value)
      ? `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
      : String(counter).padStart(value.length, '0').slice(-value.length);
    seen.set(value, placeholder);
    return placeholder;
  };
}

// Redact every UUID/hex/base64-shaped run found anywhere inside `value`
// (e.g. "request-WEB:<uuid>-0", "sess:<hex>-x"), preserving everything else
// in the value verbatim (prefix, suffix, separators).
export function redactValue(value, redact) {
  return value.replace(SECRET_G, (m) => redact(m));
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Rebuild a matched subtree into `outDoc`, keeping only tag names, nesting,
// and allowlisted attributes. Text nodes, comments, and everything else are
// dropped by construction (they are simply never visited/copied).
export function sanitizeElement(srcEl, outDoc, redact, stats) {
  const tag = srcEl.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;

  const outEl = outDoc.createElement(tag);
  stats.elements += 1;

  if (tag === 'svg') return outEl; // bare <svg></svg>: no attrs, no children

  for (const attr of [...srcEl.attributes]) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) continue;
    // data-testid values like "conversation-turn-1" are semantic constants,
    // not identifiers — always preserved verbatim.
    const value = name === 'data-testid' ? attr.value : redactValue(attr.value, redact);
    outEl.setAttribute(name, value);
    stats.attrs += 1;
  }

  for (const child of [...srcEl.children]) {
    const sanitizedChild = sanitizeElement(child, outDoc, redact, stats);
    if (sanitizedChild) outEl.appendChild(sanitizedChild);
  }
  return outEl;
}

function serialize(el, depth = 0) {
  const indent = '  '.repeat(depth);
  const attrs = [...el.attributes].map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
  const tag = el.tagName.toLowerCase();
  const children = [...el.children];
  if (children.length === 0) return `${indent}<${tag}${attrs}></${tag}>\n`;
  let out = `${indent}<${tag}${attrs}>\n`;
  for (const c of children) out += serialize(c, depth + 1);
  out += `${indent}</${tag}>\n`;
  return out;
}

// Parses `html`, picks up to `maxMatches` elements matching `select`, and
// returns the sanitized body markup plus element/attr counts. Pure function
// (no filesystem access) so it's reusable from the CLI and from tests.
export function sanitizeCapture(html, { select = DEFAULT_SELECT, maxMatches = MAX_MATCHES } = {}) {
  const dom = new JSDOM(html);
  const matches = [...dom.window.document.querySelectorAll(select)].slice(0, maxMatches);

  const outDom = new JSDOM('<!doctype html><html><body></body></html>');
  const outDoc = outDom.window.document;
  const redact = makeRedactor();
  const stats = { elements: 0, attrs: 0 };

  const sanitizedRoots = matches
    .map((m) => sanitizeElement(m, outDoc, redact, stats))
    .filter(Boolean);

  const body = sanitizedRoots.map((el) => serialize(el, 0)).join('');
  return { body, stats };
}

function captureDate(inPath, outPath) {
  const dateInDirName = /(\d{4}-\d{2}-\d{2})/.exec(dirname(outPath));
  if (dateInDirName) return dateInDirName[1];
  return statSync(inPath).mtime.toISOString().slice(0, 10);
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const html = readFileSync(args.in, 'utf8');
  const { body, stats } = sanitizeCapture(html, { select: args.select });

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
