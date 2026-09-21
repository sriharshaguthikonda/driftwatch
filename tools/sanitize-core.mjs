// Pure DOM-walking sanitize core, shared by the node CLI (tools/sanitize-capture.mjs)
// and the generated in-page snippet (tools/sanitize-inpage.js, built by
// tools/gen-inpage.mjs). No imports, no node globals — it must run unchanged
// under node, under jsdom, and inside a browser page. The generator strips the
// leading `export` keyword from each declaration, so keep every declaration at
// column 0 and never start a comment line with the word "export".

export const ALLOWED_ATTRS = new Set([
  'id', 'role', 'contenteditable', 'type', 'placeholder', 'dir', 'disabled', 'hidden',
  'aria-label', 'aria-hidden', 'aria-expanded', 'aria-live',
  'data-testid', 'data-message-author-role', 'data-turn', 'data-turn-id',
  'data-turn-id-container', 'data-scroll-anchor', 'data-virtualkeyboard', 'data-state',
  'data-turn-key', 'data-content-search-unit-key', 'data-markdown-text-style',
  'data-markdown-copy', 'data-composer-markdown',
]);
const SKIP_TAGS = new Set(['script', 'style', 'link', 'noscript']);
// Sept 2026 chatgpt.com vocabulary: the exchange root carries data-turn-key.
// The old default ('[data-testid^="conversation-turn-"]') is dead on the live DOM.
export const DEFAULT_SELECT = '[data-turn-key]';
// Max matched subtrees kept per selector. The old value 2 under-captured
// multi-exchange conversations; 10 covers a >=3-exchange capture plus the
// composer-form root.
export const DEFAULT_LIMIT = 10;

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
// (e.g. "request-WEB:<uuid>-0", "sess:<hex>-x", "<uuid>:2:assistant"),
// preserving everything else in the value verbatim (prefix, suffix,
// separators) — the Sept unit-key index and role suffix survive.
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

// Match up to `limit` elements per selector (document order), deduped across
// selectors. A string argument is treated as a single selector — the old
// comma-joined CLI behavior.
export function selectRoots(doc, selectors, limit = DEFAULT_LIMIT) {
  const list = typeof selectors === 'string' ? [selectors] : selectors;
  const out = [];
  const seen = new Set();
  for (const sel of list) {
    for (const m of [...doc.querySelectorAll(sel)].slice(0, limit)) {
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
  }
  return out;
}

// Sanitize already-matched root elements into a fresh implementation-provided
// document and serialize them. Works with roots from any DOM (jsdom or a live
// page); returns { body, stats } exactly like the CLI path.
export function sanitizeRoots(roots) {
  const stats = { elements: 0, attrs: 0 };
  if (!roots || roots.length === 0) return { body: '', stats };
  const outDoc = roots[0].ownerDocument.implementation.createHTMLDocument('driftwatch-sanitize');
  const redact = makeRedactor();
  const sanitizedRoots = roots.map((m) => sanitizeElement(m, outDoc, redact, stats)).filter(Boolean);
  const body = sanitizedRoots.map((el) => serialize(el, 0)).join('');
  return { body, stats };
}
