# driftwatch

Zero-runtime-dependency JavaScript library for detecting DOM selector churn in browser
extensions and userscripts before it turns into a silent failure. MIT licensed. Runs
identically in MV3 content scripts, Tampermonkey userscripts, and Node + jsdom.

## The problem

A selector-driven extension fails **silently**. When the target site redesigns a page,
`querySelectorAll` just returns nothing (or the wrong thing) — no exception, no log entry.
The extension hangs, no-ops, or clicks the wrong element, and nobody learns which selector
rotted or when.

### The motivating example

chatgpt.com changed its conversation-turn element from `article` to `section`:

```html
<!-- before -->
<article data-testid="conversation-turn-1">...</article>

<!-- after -->
<section data-turn-id="..." data-testid="conversation-turn-1" data-turn="user">...</section>
```

Measured against this repo's own fixtures (`fixtures/chatgpt.com/2026-03-19-turns/` and
`fixtures/chatgpt.com/2026-07-15-turns/`):

| selector | 2026-03-19 | 2026-07-15 |
|---|---|---|
| `article[data-testid^="conversation-turn-"]` | 2 matches | **0 matches** |
| `[data-testid^="conversation-turn-"]` | 2 matches | 2 matches |

The tag-qualified selector survived one redesign and then died on the next. The
tag-agnostic form survived both. That is the whole thesis of this library: rank the
selector that outlives the markup first, and tell the caller when even that stops working.

## Getting started

There is no published package. Clone the repo and build it:

```bash
git clone https://github.com/sriharshaguthikonda/driftwatch.git
cd driftwatch
npm install
npm run build   # writes dist/driftwatch.js and dist/driftwatch.cjs
```

**MV3 content script** — copy `dist/driftwatch.js` into your extension and load it as a
content script (or bundle it), then:

```javascript
const dw = window.driftwatch;
const pack = /* your pack JSON, or dw.packs['chatgpt.com'] if you shipped the built-in one */;
const site = dw.use(pack);

const result = site.resolve('composer', document);
if (result.ok) {
  result.el.focus();
}
```

**Tampermonkey userscript** — `@require` the built file from wherever you host it, or
inline it:

```javascript
// ==UserScript==
// @name        My Extension
// @require     file:///path/to/dist/driftwatch.js
// ==/UserScript==

(function () {
  const site = window.driftwatch.use(myPack);
  const result = site.resolve('sendButton', document, { state: 'idle' });
  if (result.ok) result.el.click();
})();
```

**Node + jsdom** (tests, fixture audits, CI):

```javascript
const dw = require('./dist/driftwatch.cjs');
const { JSDOM } = require('jsdom');

const pack = dw.packs['chatgpt.com']; // packs built into dist by build.js
const doc = new JSDOM(html).window.document;

const site = dw.use(pack);
const report = site.audit(doc);
console.log(report.summary);
```

`compile`, `resolve`, `audit`, `use`, and `canary` are also available as top-level
exports (`dw.resolve(pack, name, root, opts)`) if you don't want the `use()` wrapper.

## Writing a pack

A pack is plain JSON. No code changes needed to support a new site.

```json
{
  "pack": "chatgpt.com",
  "version": 1,
  "anchors": {
    "conversationTurn": {
      "risk": "observe",
      "pick": "last",
      "max": 400,
      "strategies": [
        { "id": "turn.testid-prefix", "testid": "conversation-turn-", "op": "^" },
        { "id": "turn.data-turn-id", "attr": "data-turn-id" },
        { "id": "turn.legacy-article", "css": "article[data-testid^=\"conversation-turn-\"]" }
      ]
    },
    "sendButton": {
      "risk": "action",
      "degradeLimit": 1,
      "min": 0,
      "expected": {
        "idle": { "min": 1, "max": 1 },
        "streaming": { "min": 0, "max": 0 }
      },
      "strategies": [
        { "id": "send.testid", "css": "button[data-testid=\"send-button\"]", "requires": ["connected", "enabled"] }
      ]
    }
  }
}
```

### Anchor fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `risk` | `"observe"` \| `"action"` | `"observe"` | `observe` degrades freely down the strategy list. `action` fails closed past `degradeLimit`. |
| `degradeLimit` | number | `0` | For `action` anchors, how many strategies past the first may be tried before `resolve()` refuses with `fail-closed`. |
| `min` | number | `1` | Minimum matches for a strategy attempt to count as a hit. `min: 0` allows an anchor to legitimately match nothing. |
| `max` | number | `Infinity` | Maximum matches allowed before a strategy attempt is `ambiguous`. |
| `pick` | `"first"` \| `"last"` | `"first"` | Which element of the winning strategy's match set becomes `result.el`. |
| `expected` | object keyed by state | — | Per-state `{min, max}` overrides (see below). Enables `resolve(pack, name, root, { state })`. |
| `strategies` | array | required | Ordered list, tried in order; first that satisfies `min`/`max` (and isn't past `degradeLimit` for an action anchor) wins. |

### Strategy forms

Exactly one of these four shapes per strategy:

| Form | Fields | Compiles to |
|---|---|---|
| CSS | `css` | used verbatim |
| test id | `testid`, `op` (`=`\|`^`\|`*`, default `=`) | `[data-testid<op>="value"]` |
| attribute | `attr`, `value` (optional) | `[attr]` or `[attr="value"]` |
| ARIA role | `role`, `name` (optional) | `[role="value"]` or `[role="value"][aria-label="name"]` |

Every strategy may also carry:

- `id` — string, required, identifies the strategy in reports.
- `requires` — array combining any of `connected`, `enabled`, `visible`, `inside:<anchorName>`. Evaluated *after* the selector matches, to filter plausible-but-wrong elements that raw cardinality can't see.

### `expected` / state

An anchor's default `min`/`max` can be overridden per named state:

```json
"expected": { "idle": { "min": 1, "max": 1 }, "streaming": { "min": 0, "max": 0 } }
```

Calling `resolve`/`audit` without a `state` on an anchor that declares `expected` returns
status `unknown-state` — it never silently falls back to the anchor's unconditional
default.

## The audit report

```javascript
const report = site.audit(document, { state: 'idle' });
```

Top-level fields: `pack`, `packVersion`, `host`, `ts`, `summary`, `anchors`.

Per-anchor fields:

| Field | Meaning |
|---|---|
| `status` | One of `ok`, `degraded`, `broken`, `absent`, `ambiguous`, `unknown-state` (see below). |
| `risk` | Copied from the pack (`observe` \| `action`). |
| `strategyId` / `strategyIndex` | Which strategy won, or `null`/`-1` if none did. |
| `matchedCount` | How many elements the winning strategy matched. |
| `attempts` | One entry per strategy tried, `{ id, count }` (count is `-1` for an unsupported selector, `-2` when a referenced `inside:` anchor didn't resolve). |
| `matchedStrategies` | How many strategies matched *anything*, evaluated in full — not short-circuited like `resolve()`. |
| `agreeingStrategies` | Of those, how many matched the exact same element set as the winner. |
| `conflictingStrategies` | `matchedStrategies - agreeingStrategies` — strategies that quietly matched a *different* element. Cardinality (a count) can't see this; element-identity comparison can. |

### Status values

- **ok** — the winning strategy is index 0 (no fallback needed).
- **degraded** — a later strategy won (churn signal — update the pack).
- **broken** — every strategy failed `min`/`max`, and `min` was not `0`.
- **absent** — every strategy matched zero, and `min` was `0` for the active state (legitimately not present right now).
- **ambiguous** — a strategy matched, but exceeded `max`.
- **unknown-state** — the anchor declares `expected` and no `state` was passed.

## Continuous checking (canary)

`canary` deliberately owns no timer. It runs one audit, and only acts when the drift
picture actually changed since the last call — you call it from a poll you already run:

```javascript
const dw = require('./dist/driftwatch.cjs');

setInterval(() => {
  dw.canary(pack, document, (report) => {
    console.warn('drift detected:', report.summary);
  });
}, 5000);
```

On a changed fingerprint it appends the report to an in-memory ring buffer (last 20,
via `dw.canary.history()`), persists the JSON to `chrome.storage.local` (falling back to
`GM_setValue`, then `localStorage`) under the key `driftwatch:drift`, and — only if the
new summary has any `degraded`, `broken`, or `ambiguous` count — calls `onDegrade(report)`.
An unchanged fingerprint does nothing: no persistence, no callback.

## Two things worth being precise about

**`visible` cannot be evaluated without a layout engine.** jsdom has none — `<html>` there
always reports zero client rects, on every document, not because anything is hidden. So
under jsdom, a `requires: ["visible"]` strategy reports the element as passing and records
`unchecked: ["visible"]` in that attempt, rather than silently passing *or* silently
failing. In a real browser it evaluates for real.

**"page-text-free" is the accurate claim, not "privacy-safe".** Reports never contain page
text, but they still reveal which site is open, roughly how long the conversation is
(match counts), and whether generation is active (`stopButton` present vs not). That is
useful signal for debugging churn — but it is not nothing, so don't call it safe.

## Fixtures and the ratchet

`test/audit.fixtures.test.js` discovers every `fixtures/<pack>/**/*.html` file and runs
`audit()` against it. Fixtures are sanitized DOM slices (structure and allow-listed
attributes only — enforced by `tools/check-no-captures.mjs`), not full page captures.

`fixtures/<pack>/current/<variant>/` is the frontier: every variant in it (desktop,
mobile, streaming, logged-out, ...) is treated as equally "now", and every anchor in it
must resolve `ok` (not `degraded`) or the test fails. Older, dated fixture directories
(`fixtures/<pack>/2026-03-19-turns/`, etc.) are allowed to show `degraded` — that's
expected as the DOM moves on — but never `broken` or `ambiguous`.

A fixture can mark the elements it cares about with `data-oracle="<anchorName>"` (must
resolve to exactly that element) and `data-oracle-negative` (must never appear in any
anchor's match set). A fixture with no oracle markers is checked on every anchor in the
pack; one with markers is scoped to only the anchors it names.

## Privacy

`tools/check-no-captures.mjs` runs in `npm test` and CI. It rejects any `.html` file
outside `fixtures/`, any fixture over 50 KB, any fixture containing non-whitespace text
content, and any attribute not on a small allow-list (`id`, `role`, `data-testid`,
`aria-label`, ...). Raw page captures — which carry conversation text and account/session
identifiers — can never land in this repo, even by accident.

At runtime, `audit()` and `resolve()` only ever read element existence, attributes on the
allow-list implied by the pack's own strategies, and match counts. They do not read
`textContent`, `innerHTML`, or send anything over the network.

## Non-goals

- No auto-healing — a broken strategy is a pack you update, not a selector the library guesses.
- No LLM selector inference — strategies are human-authored and auditable.
- No network reporting — everything stays local; `canary()`'s only I/O is `chrome.storage.local` / `GM_setValue` / `localStorage`.
- No shadow DOM piercing — light DOM only.
- No XPath — CSS, test-id, attribute, and ARIA-role strategies only.
- No text-content matching — fragile and language-dependent.
- No polling loop — `canary(pack, doc, onDegrade)` runs once per call; the caller supplies the interval (`setInterval`, `MutationObserver` debounce, whatever they already run).

## License

MIT
