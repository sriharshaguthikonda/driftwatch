# chatgpt.com anatomy

Structure-only field notes for agents automating chatgpt.com. Captured live on
2026-07-28 by driving a signed-in session and sampling the DOM every 250 ms across one
generation. Attribute names, counts and shapes only — no page text, no conversation URLs,
no account data.

This exists because the same class of bug has now cost several debugging rounds: the DOM
is not what the selectors assume, and nothing tells you so.

## The composer action button

**One node does both jobs, and it disappears.**

`button#composer-submit-button` is Send and Stop at different times. The id is stable across
both. What changes is the accessible name and the test id:

| Phase | `aria-label` | `data-testid` | `disabled` | opacity | rect | node exists |
|---|---|---|---|---|---|---|
| Idle, composer empty | `Send prompt` | `send-button` | yes | 0.35 | 36×36 | yes |
| Idle, text entered | `Send prompt` | `send-button` | no | 1 | 36×36 | yes |
| Generating | `Stop answering` | `stop-button` | no | 1 | 36×36 | yes |
| Generation complete | — | — | — | — | — | **no** |

The last row is the trap. When generation ends chatgpt.com **removes the button from the
DOM entirely** — it is not hidden, not disabled, not relabelled. `querySelector` returns
`null`. It reappears only once the composer has content again.

Consequences:

- Treating "the Stop control is gone" as a completion signal is correct, but only if your
  lookup cannot silently rebind to some other element once the node vanishes.
- `type` is **not** set on this button (it is `null`, despite the id containing "submit").
  Do not fold `type` into a "looks like send" test.
- `aria-label` is sometimes supplied through `aria-labelledby` rather than directly, so
  resolve the accessible name properly instead of reading `textContent`.

### The failure this caused

A stop-button candidate list that ends in a loose fallback like `button[aria-label*="Stop"]`
will, the instant the composer button is removed, match **a sidebar conversation whose
title contains the word "Stop"** — the history entry renders as
`button[aria-label="Pin <conversation title>"]`. Observed live: `Pin Ollama Stop Usage`.

A generic "has stop, has no send" classifier then reports that generation is still running,
forever. Every waiting job hangs until its tab closes.

**Rule: a generation Stop control is always inside the composer.** Require containment
(`closest('form')`, or `main`) before any element that is not the uniquely-identified
composer button may claim generation is running. Whitelist the composer region; do not
blacklist the sidebar.

## Conversation turns — the `article` → `section` churn

Turns moved from `<article>` to `<section>`. Measured on a live two-turn conversation:

| Selector | Matches |
|---|---|
| `article[data-testid^="conversation-turn-"]` | **0** |
| `[data-testid^="conversation-turn-"]` | 2 |
| `section[data-testid^="conversation-turn-"]` | 2 |
| `article[data-turn-id]` | 0 |

The tag-agnostic form survived; the tag-qualified form did not. This is the single most
useful lesson in this document: **never qualify a turn selector by tag.**

Current turn shape:

```
section[data-testid="conversation-turn-N"][data-turn-id][data-turn="user"|"assistant"]
  └── [data-message-author-role="user"|"assistant"]        <- inner message
  └── (response action bar, assistant turns only)
```

Author role is available structurally in two places — `data-turn` on the turn and
`data-message-author-role` on the inner message. Use either; never infer author from text.

### Scope resolution: `closest()` matches the element itself

If you resolve a response scope with a single combined selector list like

```js
candidate.closest('[data-testid^="conversation-turn-"], [data-turn-id], [data-message-author-role="assistant"]')
```

and your candidate *is* the inner `[data-message-author-role="assistant"]` node, `closest()`
returns that node, not the turn. The response action bar lives in the **turn**, outside the
inner message div, so it falls out of scope.

Measured on the same completed answer: turn scope finds **4** completion markers, inner-div
scope finds **0**. Resolve the turn first, then fall back:

```js
candidate.closest('[data-testid^="conversation-turn-"], [data-turn-id]')
  || candidate.closest('[data-message-author-role="assistant"]')
  || candidate
```

## Completion markers

These appear on an assistant turn once its answer is finished:

- `button[data-testid="copy-turn-action-button"]`
- `button[aria-label="Copy response"]`
- `button[aria-label="Good response"]`
- `button[aria-label="Bad response"]`

Count them **within the turn**, never document-wide: a copy button was already present
document-wide mid-generation (belonging to an earlier turn), so a document-level count
signals nothing about the answer you are waiting on.

## Observed generation timeline

One trivial prompt, 250 ms sampling, times relative to submit:

| t | State |
|---|---|
| 0.3 s | `Send prompt`, enabled |
| 11.0 s | `Stop answering`, `data-testid="stop-button"` — generation running |
| 11.7 s | Turn sections appear (2), streaming |
| 15.7 s | `main .markdown` present |
| 18.9 s | **Composer button removed**, stop gone, 4 response action markers present |

Time-to-first-token varies with routing and can exceed 10 s. Do not treat a quiet first
10 seconds as failure.

`.loading-shimmer`, `[class*="thinking"]` and `[class*="tool-message"]` were all absent
throughout a plain text generation — they belong to tool/reasoning flows, so do not require
their absence as a general completion precondition without scoping them to the current turn.

## Regions

```
main
  └── form[data-type="unified-composer"]      <- composer; Send/Stop lives here
nav[aria-label="Chat history"]
  └── #history > ul > li
        └── a[aria-label="<conversation title>"]
              └── button[aria-label="Pin <conversation title>"]     <- NOT a stop control
```

The sidebar is outside both `main` and the composer form. That is the containment fact the
Stop-button guard depends on.

## Anchors

The `chatgpt.com` pack in this repo tracks these. `sendButton` and `stopButton` are
`action`-risk and state-conditioned, so `resolve()` needs a `state` argument or it returns
`unknown-state` rather than `ok`.

| Anchor | Leading strategy | Notes |
|---|---|---|
| `conversationTurn` | `[data-testid^="conversation-turn-"]` | never tag-qualified |
| `assistantMessage` | `[data-message-author-role="assistant"]` | inner node, not the turn |
| `copyResponseButton` | `button[data-testid="copy-turn-action-button"]` | scope to the turn |
| `composer` | `#prompt-textarea` | ProseMirror contenteditable, not a textarea |
| `sendButton` | `button[data-testid="send-button"]` | same node as stop |
| `stopButton` | `#composer-submit-button` | absent once generation ends |

## Two rules worth carrying elsewhere

1. **A logged transition must never be weaker than the decision it names.** A completion
   log that fires on a subset of the real gate's conditions makes the log unfalsifiable —
   the transition appears, the job still hangs, and post-mortems chase the wrong component.
2. **Fail closed on action anchors.** A wrong "still generating" verdict costs an entire
   job silently. Refusing to resolve is cheaper than resolving to a plausible wrong element.
