# driftwatch design rationale

This is the "why", not the "how" — see `README.md` for the API. Every claim below is
backed by something in `src/`, `test/`, `packs/chatgpt.com.json`, or
`docs/REVIEW-2026-07-27-external.md`, which is the authoritative record of what an
external design review found and what this project accepted, deferred, or rejected.

## Why silent failure is the real enemy

A selector-driven extension doesn't crash when the site it targets changes. It just stops
matching. `document.querySelectorAll(...)` returns an empty list, the code that expected
one element does nothing, and no exception is thrown anywhere. There is no log line to
grep for and no stack trace to file a bug against — the failure mode is "the feature quietly
does nothing," which is the hardest kind of bug to notice, let alone diagnose.

driftwatch's job is to turn that silence into a signal: rank selector strategies so the
most durable one is tried first, record which one actually won, and expose that as a
status (`ok` / `degraded` / `broken` / ...) instead of a boolean. `degraded` means "this
still works, but the DOM contract moved" — it is the whole point of the library, and it
does not exist in a plain `try { el.click() } catch {}`.

## Generic-before-qualified — but only for collections, not singletons

The original rule was "rank generic selectors ahead of qualified ones, always." The
evidence for that rule is real: chatgpt.com's conversation-turn element moved from
`article` to `section`.

```
2026-03-19 fixture: article[data-testid^="conversation-turn-"]  → 2 matches
2026-07-15 fixture: article[data-testid^="conversation-turn-"]  → 0 matches
2026-07-15 fixture: [data-testid^="conversation-turn-"]         → 2 matches (unchanged)
```

Dropping the tag entirely (`turn.testid-prefix` in `packs/chatgpt.com.json`) is what
survived. That's `conversationTurn` — an **observe collection**: many elements, read-only,
and the tag around them is incidental decoration.

But the external review (`docs/REVIEW-2026-07-27-external.md`, A2) measured a
counter-example on the same live site: `button[aria-label^="Copy"]` matches **23**
elements (every "Copy code" button inside every code block in the conversation), while
`[data-testid="copy-turn-action-button"]` matches 2. Stripping the tag here doesn't make
the selector more durable — it makes it match the wrong thing 21 times out of 23.

The corrected rule, encoded directly in `packs/chatgpt.com.json`:

- **Observe collections** (`conversationTurn`, `assistantMessage`) — generic first. The
  wrapping tag is decoration; nothing in the observation depends on it.
- **Action singletons** (`sendButton`, `stopButton`, `composer`, `copyResponseButton`) —
  tag-qualified and scoped. `button[...]` here isn't decoration, it's a semantic
  precondition: it asserts the matched node is natively clickable, not just some `<div>`
  that happens to carry a similar `aria-label`. `copyResponseButton`'s second strategy
  goes further and adds `requires: ["inside:conversationTurn"]` — see below.

## Why action anchors fail closed

`risk: "action"` anchors are things the caller intends to `.click()`. Clicking a
plausible-but-wrong element (a copy-code button instead of copy-response, a stale send
button from a detached DOM subtree) is worse than not clicking anything, because the
caller has no way to tell the difference from the result alone.

The policy, implemented in `resolveInternal` (`src/core.js`):

```javascript
var degraded = i > 0;
if (degraded && a.risk === 'action' && i > (a.degradeLimit || 0)) {
  return { ok: false, reason: 'fail-closed', el: null, ... };
}
```

`degradeLimit` defaults to `0` — an action anchor gets exactly one fallback strategy
before `resolve()` refuses outright rather than guess. Observe anchors have no such limit;
they degrade all the way down the strategy list, because reading from a slightly-wrong
element is recoverable in a way that clicking one is not.

## The `min: 0` bug — a caught defect, not a hypothetical

The single most instructive bug in this repo's history. An anchor with `min: 0` (meaning
"legitimately absent sometimes," e.g. `stopButton` when nothing is generating) hit a path
where every strategy matched zero elements. The old logic let a zero-length match set
satisfy `0 <= 0 <= max` and return early:

```javascript
ok: true, el: els[0], ...   // els is [], els[0] is undefined
```

`ok: true` with `el: undefined`. Every caller trusts `ok` and skips its own null check —
that's the entire point of `result.ok`. So this shipped a landmine: call `.click()` on it
and you get `Cannot read properties of undefined`, at a call site nowhere near the actual
defect.

Fixed in `resolveInternal` by special-casing the zero-match case before the min/max check
ever runs:

```javascript
if (els.length === 0 || els.length < min || els.length > max) continue;
```

Zero matches now never resolves, full stop — `min: 0` only changes what happens *after*
every strategy has been tried (`absent` vs `broken`), never whether an empty result can
satisfy a strategy in-flight. `test/audit.fixtures.test.js` pins this with a named
regression test: *"absent — min:0, zero plain matches (regression: was ok/primary with el
undefined)"*, and a repo-wide invariant test walks every anchor in every real pack against
an empty scope asserting `ok: true` never pairs with a falsy `el`.

## Why `requires` exists

Cardinality — "exactly 1 element matched" — proves a count, never an identity. Two
strategies can each report exactly one match and still be looking at two completely
different elements, and cardinality alone cannot detect that.

`requires` is a small, fixed vocabulary evaluated on the elements a strategy already
matched: `connected`, `enabled`, `visible`, `inside:<anchorName>`. It is deliberately not
"arbitrary JS predicate" — packs stay pure data, and an untrusted pack can only reach
these four checks, not run code. `inside:` is the load-bearing one: it is exactly what
stops `copyResponseButton`'s generic `button[aria-label^="Copy"]` strategy from resolving
to one of the 23 code-block copy buttons instead of the one inside the actual conversation
turn — `requires: ["inside:conversationTurn"]` filters the match set down to elements the
resolved `conversationTurn` anchor actually contains.

## Why expectations are state-conditioned

`min: 0` alone has a second failure mode, independent of the bug above: if `stopButton`
is *unconditionally* allowed to match zero elements, then a stop-button selector that has
completely rotted — broken in every browser session, for every user, forever — reports
`absent` on every single audit. `absent` and "rotted" are indistinguishable from outside,
because both look like "zero matches, and that's allowed." That is the exact silent
failure this library exists to catch, reintroduced through the escape hatch meant to
prevent it.

The fix is that "legitimately zero" is only true in a specific state, not always:

```json
"stopButton": {
  "min": 0,
  "expected": { "idle": { "min": 0, "max": 0 }, "streaming": { "min": 1, "max": 1 } }
}
```

`resolve`/`audit` take an `opts.state`. Without one, an anchor that declares `expected`
returns `unknown-state` rather than silently reusing the anchor's unconditional default —
so a caller that forgets to pass `state` gets a visibly different status, not a false
`ok`. With `state: 'streaming'`, `stopButton` matching zero is now `broken`, not `absent` —
the selector rotted and the report says so.

## Why the ratchet uses a "current frontier," not a single newest fixture

The original ratchet rule was "strategy[0] must win on the single most-recently-dated
fixture." That breaks down as soon as a site has more than one simultaneous "now": desktop
vs. mobile layout, streaming vs. idle, logged-in vs. logged-out, a long conversation vs. a
short one. Picking one dated directory as *the* newest and requiring strategy[0] to win
there causes strategy-order thrash — a pack reordered to satisfy the mobile fixture starts
failing the desktop one, and vice versa.

`test/audit.fixtures.test.js` replaces "newest dated dir" with a **frontier directory**,
`fixtures/<pack>/current/<variant>/`. Every variant under `current/` is equally "now," and
every anchor found in every current variant must resolve `ok` (not `degraded`) — anything
less fails the test. Dated directories (`2026-03-19-turns/`, `2026-07-15-turns/`) remain
as a fallback ratchet only when a pack has no `current/` fixtures yet: they're allowed to
show `degraded` (expected, as the DOM moves on from them) but never `broken` or
`ambiguous`. A fixture can also declare `data-oracle`/`data-oracle-negative` markers to
pin exact element identity, not just status — see `README.md`.

## Deferred, with reasons

From the external review triage (`docs/REVIEW-2026-07-27-external.md`) — accepted as real
concerns, deliberately not built:

| Suggestion | Why not now |
|---|---|
| Per-strategy `risk` + `capabilities` tiers, `resolve(name, {maximumRisk})` | Overlaps what `requires` + anchor-level `risk` already do. Shipping both is two vocabularies for one job. Revisit only if `requires` proves insufficient. |
| Playwright real-browser test layer | Real gap — jsdom has no layout engine, so `visible`, geometry, and occlusion can't be evaluated there. Mitigated for now: `visible` reports `unchecked` under jsdom instead of silently passing or failing. Add the browser layer when an anchor actually breaks on a visibility condition in practice. |
| Bucketed counts instead of exact numbers/timestamps | Only matters once reports leave the device. They don't — there is no network path, by design. Documented here as the precondition for ever adding one. |
| Pack signing / trusted-capability packs | Real threat: a malicious pack could aim a click at the wrong element. Currently moot because packs are baked into `dist/` at build time — there is no remote pack fetch. This is the blocker to ever shipping remote packs. |
| Structural fixture assertions (e.g. "turns[1] has `data-turn=\"assistant\"`") | Partially covered already by `data-oracle` markers, which pin element identity. Extend that mechanism rather than add a second one. |

Also recorded, but explicitly out of scope for this library: bounding how long a caller
waits on a `resolve()` result is the caller's problem, not driftwatch's — driftwatch
resolves elements, it does not own timers or wait loops (see `src/canary.js`'s own
comment: "No timer here on purpose"). Nothing in the review was rejected outright as
wrong; everything above is a scope call.
