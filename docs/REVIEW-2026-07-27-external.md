# External design review — 2026-07-27

Source: ChatGPT (GPT-5 thinking), prompted with the v1 design. Retrieved via browser because the
bridge's own completion detection is the bug this project exists to fix.

Triage below is the authoritative record of what we accepted, what we deferred, and why. The rule
applied: take correctness fixes, refuse framework-building.

## Accepted — correctness

### A1. Zero matches must never resolve (already fixed)
`min: 0` anchors returned `ok: true, el: undefined` on zero matches. Independently found in review
before this critique arrived. Fixed: zero matches always fall through to the next strategy.

### A2. "Generic before qualified" is not universal
The reviewer is right, and live data proves it: on chatgpt.com today,
`button[aria-label^="Copy"]` matches **23** elements (every "Copy code" button in every code block),
while `[data-testid="copy-turn-action-button"]` matches 2.

Corrected rule, split by anchor kind:
- **observe collections** (`conversationTurn`, `assistantMessage`) — generic first. The tag is
  incidental decoration; dropping it is what survived `article` → `section`.
- **action singletons** (`sendButton`, `stopButton`, `copyResponseButton`) — tag-qualified and
  scoped. `button[…]` is a *semantic safety condition*, not decoration: it asserts the thing is
  natively clickable.

### A3. Cardinality does not catch plausible-but-wrong matches
Counting 1 match proves nothing about *which* element. Adding a small fixed `requires` vocabulary —
`connected`, `visible`, `enabled`, `inside:<anchorName>` — evaluated after a strategy matches.
Fixed vocabulary, not arbitrary JS, so packs stay data-only and untrusted-pack risk stays bounded.

`inside:` is the important one: it is what stops `copyResponseButton` resolving to a code-block copy
button.

### A4. `min: 0` permanently hides broken transient anchors
Serious, and the sharpest point in the review. If `stopButton` always permits zero matches, a
completely rotted stop-button selector reports `absent` forever and never `broken` — the exact
silent failure this library exists to detect. Absence is only valid *in a given state*.

Fix: state-conditioned expectations.
```json
"stopButton": { "expected": { "idle": {"min":0,"max":0}, "streaming": {"min":1,"max":1} } }
```
`audit(pack, doc, { state })`. Without a state the anchor is reported `unknown-state`, not `ok`.

### A5. `audit` should record strategy disagreement
`resolve` short-circuits at the first success — correct, it is on the hot path. But `audit` is a
diagnostic where cost does not matter, so it evaluates **all** strategies and reports when they
disagree. Two strategies each matching exactly 1 element but *different* elements is drift evidence
that cardinality alone cannot see.

### A6. The ratchet's "newest fixture" is not one truth
A/B variants, mobile vs desktop, logged-out, streaming vs idle, long vs short chats can all be
current simultaneously. Requiring strategy[0] to win on the single newest dated dir causes strategy
thrash. Replaced with a **current frontier**: `fixtures/<pack>/current/<variant>/`, and the rule
becomes "every current fixture resolves within its permitted risk tier".

### A7. Privacy claim was overstated
"Privacy-safe by construction" → **"page-text-free"**. A report still reveals which site is open,
roughly how long the conversation is, whether generation is active, and which UI experiment the user
is in. That is materially different from "safe". Docs corrected; reports stay on-device.

## Accepted — but belongs to the consumer, not driftwatch

### A8. Completion detection needs a bounded state machine
"No library wait should be capable of running forever." Correct, and it is precisely the second bug
in Prompt-queue: `isFiniteResponseTimeoutEnabled` is inverted, so `maxWaitMs` never fires. Fixing
selectors alone would not have fixed the hang.

This lives in the consumer. driftwatch resolves elements; it does not own waits. Recorded here so
the Prompt-queue migration treats the timeout un-inversion as mandatory, not optional, and so every
wait terminates as one of: matched / ambiguous / broken / aborted / timed-out / navigation-changed.

## Deferred — with reasons

| Suggestion | Why not now |
|---|---|
| Per-strategy `risk` + `capabilities` tiers, `resolve(name, {maximumRisk})` | Overlaps `requires` + anchor-level `risk`. Shipping both is two vocabularies for one job. Revisit only if `requires` proves insufficient. |
| Playwright real-browser test layer | Real gap — jsdom cannot evaluate `visible`, geometry or occlusion. Mitigation for now: `visible` reports `unchecked` under jsdom rather than silently passing. Add the browser layer when an anchor actually breaks on a visibility condition. |
| Bucketed counts, no exact timestamps | Only matters if reports leave the device. They do not — there is no network path, by design. Documented as a precondition for ever adding one. |
| Pack signing / trusted-capability packs | Real threat: a malicious pack can aim a click. Currently moot — packs are baked in at build time, no remote fetch. This is the blocker to ever shipping remote packs. |
| Structural fixture assertions (`turns[1]` has `data-turn="assistant"`) | Partially covered by the existing `data-oracle` markers, which already pin element identity. Extend the oracle rather than add a second mechanism. |

## Not accepted

Nothing was rejected outright as wrong. The deferrals above are scope calls, not disagreements.
