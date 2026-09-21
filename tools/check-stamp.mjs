#!/usr/bin/env node
// Re-vendor staleness check (S2.6, hardened F1). build.js stamps the dist
// header with every baked pack's version and a content hash over EVERY byte
// that follows the stamp line — engine (src/*.js) + baked packs together:
//
//   // driftwatch-stamp: chatgpt.com@2 dist-sha256=0123456789abcdef
//
// A pack-only hash (the old scheme) missed an engine-only change: same packs,
// same stamp, stale engine still passed. Consumers hand-copy dist/driftwatch.js;
// this tool lets them assert WHAT their vendored copy carries:
//
//   node tools/check-stamp.mjs path/to/vendored-driftwatch.js \
//     --expect chatgpt.com@2 --expect-sha 0123456789abcdef
//
// Every run also RECOMPUTES dist-sha256 from the file's own bytes after its
// last stamp line and fails on mismatch — this alone catches a hand edit or a
// partial copy, no --expect flags needed. Consumer header lines pasted ABOVE
// the stamp never affect the hash (only bytes after the stamp line count),
// and the hash is taken over LF-normalized bytes so a CRLF-saved copy still
// verifies. `--against <fresh dist/driftwatch.js>` compares the vendored
// stamp to a freshly-built one and fails when they differ — the "stale copy"
// check a consumer runs at vendor time.
//
// Exits 0 when every check holds (and a stamp exists at all), 1 otherwise.
// Reads files only — no network, no repo layout assumptions.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const STAMP_RE = /^\/\/\s*driftwatch-stamp:\s*(.+?)\s*$/m;

// Parses "chatgpt.com@2 dist-sha256=0123..." into { packs: {name: version}, distSha256 }.
export function parseStamp(line) {
  const packs = {};
  let distSha256 = null;
  for (const token of line.split(/\s+/).filter(Boolean)) {
    const hash = token.match(/^dist-sha256=([0-9a-f]{16})$/);
    if (hash) { distSha256 = hash[1]; continue; }
    const pv = token.match(/^([A-Za-z0-9.-]+)@(\d+)$/);
    if (pv) { packs[pv[1]] = Number(pv[2]); continue; }
    return null; // unknown token: not a stamp we wrote — refuse rather than guess
  }
  if (Object.keys(packs).length === 0 || distSha256 === null) return null;
  return { packs, distSha256 };
}

// Splits the raw file into [lines-up-to-and-including-the-last-stamp-line,
// the-rest]. Shared by readStamp() and computeDistSha256() so both agree on
// exactly which line is "the" stamp (the LAST one — a hand-merged copy may
// keep older headers).
function splitAtLastStamp(raw) {
  const lines = raw.split(/\r?\n/);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (STAMP_RE.test(lines[i])) idx = i;
  if (idx === -1) return null;
  return { stampLine: lines[idx], after: lines.slice(idx + 1).join('\n') };
}

export function readStamp(file) {
  const split = splitAtLastStamp(readFileSync(file, 'utf8'));
  if (!split) return null;
  const m = split.stampLine.match(STAMP_RE);
  return parseStamp(m[1]);
}

// Recomputes dist-sha256 from the file's own bytes after its last stamp line
// (LF-normalized, per the split above already having stripped \r). Returns
// null when the file has no stamp line at all.
export function computeDistSha256(file) {
  const split = splitAtLastStamp(readFileSync(file, 'utf8'));
  if (!split) return null;
  return createHash('sha256').update(split.after).digest('hex').slice(0, 16);
}

function usage() {
  console.error('usage: node tools/check-stamp.mjs <dist-or-vendored-file.js> [--expect <pack>@<version>]... [--expect-sha <16-hex>] [--against <fresh-dist-file.js>]');
}

function runCli() {
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const expects = [];
let expectSha = null;
let against = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--expect') expects.push(argv[++i]);
  else if (argv[i] === '--expect-sha') expectSha = argv[++i];
  else if (argv[i] === '--against') against = argv[++i];
}

if (!file || expects.some((e) => e == null) || expectSha === '') { usage(); process.exit(1); }

const stamp = (() => {
  try { return readStamp(file); } catch { return undefined; } // unreadable file
})();

const failures = [];
if (stamp === undefined) failures.push(`cannot read ${file}`);
else if (stamp === null) failures.push(`${file}: no parsable driftwatch-stamp line — pre-stamp or hand-mangled build`);
else {
  // (a) Self-consistency, always checked: the bytes after the stamp line must
  // hash to what the stamp claims — catches a hand edit or a partial copy
  // even with no --expect flags at all.
  const computed = computeDistSha256(file);
  if (computed !== stamp.distSha256) {
    failures.push(`dist-sha256: file bytes after the stamp hash to ${computed}, stamp claims ${stamp.distSha256} — hand-edited or partially copied`);
  }

  for (const e of expects) {
    const at = e.indexOf('@');
    const name = e.slice(0, at), ver = Number(e.slice(at + 1));
    if (!(name in stamp.packs)) failures.push(`stamp has no pack "${name}" (has: ${Object.keys(stamp.packs).join(', ')})`);
    else if (stamp.packs[name] !== ver) failures.push(`${name}: stamped @${stamp.packs[name]}, expected @${ver}`);
  }
  // (b) --expect-sha compares against the stamp's own claimed hash.
  if (expectSha != null && stamp.distSha256 !== expectSha) {
    failures.push(`dist-sha256: stamped ${stamp.distSha256}, expected ${expectSha}`);
  }
  // (c) --against <fresh dist file>: the "stale copy" check a consumer runs at
  // vendor time — does the vendored stamp match what a fresh build produces?
  if (against != null) {
    const freshStamp = (() => {
      try { return readStamp(against); } catch { return undefined; }
    })();
    if (freshStamp === undefined) failures.push(`cannot read --against file ${against}`);
    else if (freshStamp === null) failures.push(`${against}: no parsable driftwatch-stamp line`);
    else if (JSON.stringify(stamp) !== JSON.stringify(freshStamp)) {
      failures.push(`stale copy: ${file} does not match the fresh stamp in ${against} — vendored ${JSON.stringify(stamp)}, fresh ${JSON.stringify(freshStamp)}`);
    }
  }
}

if (failures.length) {
  console.error('stamp check FAILED:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ file, ok: true, ...stamp }));
}

// CLI only when executed directly (importing the module from tests must not exit).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runCli();
