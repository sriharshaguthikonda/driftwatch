# driftwatch roadmap

## Where it stands

- Built: resolve / audit / canary / use / compile; chatgpt.com pack v1 in packs/chatgpt.com.json; fixture ratchet with a current frontier fixtures/<pack>/current/<variant>/; privacy guard tools/check-no-captures.mjs.
- Consumers: Tampermonkey edge-extension (vendored as edge-extension/modules/22-driftwatch.js) and Prompt-queue (vendor/driftwatch.js).

## Active: churn event #2 (chatgpt.com, 2026-09)

The September 2026 redesign broke pack v1 and the repair runs through this repo.

Master plan: [Tampermonkey churn plan](file:///C:/Windows_software/Tampermonkey/docs/plans/chatgpt-2026-09-churn/PLAN.md). Evidence: [live probe, inventory, gap analysis, DOM diff](file:///C:/Windows_software/Tampermonkey/docs/Research/chatgpt-2026-09-churn/).

- [ ] move July current/desktop → fixtures/chatgpt.com/2026-07-28-desktop/ FIRST and verify the ratchet still passes on it (dated dirs may show degraded, never broken/ambiguous; date = upstream pack-refresh commit 98c59cc, 2026-07-28)
- [ ] extend BOTH allowlists (tools/sanitize-capture.mjs and tools/check-no-captures.mjs) for data-turn-key, data-content-search-unit-key (values redacted to <uuid>:<n>:<role>), data-markdown-text-style, data-markdown-copy, data-composer-markdown, plus a redaction test for compound unit-key values; fix the dead default --select (sanitize-capture.mjs line 22)
- [ ] capture sanitized September fixtures with explicit capture roots and configurable limits: all exchanges (>=3), the composer form, and decoys (code-block editor + code-block Copy from real exchanges; sidebar Stop only if S0.4 finds it live, else a synthetic adversarial fixture per churn-resistant TESTING.md) — variants current/desktop (idle, empty composer, Send absent), current/composing (Send exactly 1), current/streaming (Stop exactly 1, Send 0), each with state.json {"state":"..."}
- [ ] fixture ratchet passes each fixture's state.json state to BOTH audit() and oracle resolution (test/audit.fixtures.test.js:475 audit, :504-518 oracles)
- [ ] expected-status table per fixture dir x anchor (ok / absent / degraded allowed) drives the ratchet — "every anchor ok" is not the bar; required anchors still fail hard
- [ ] pack v2 — new anchors exchangeRoot, userUnit, assistantUnit, assistantMarkdownRoot, responseActionBar, codeBlock, composerForm; retarget composer / sendButton / stopButton / copyResponseButton; sendButton/stopButton expected gains a composing key; September strategies first, March/July kept as fallbacks; conversationTurn legacy-only; bare contenteditable-textbox composer strategy dropped; responseActionBar keeps a Copy-independent fallback strategy
- [ ] pack-v2 inside: rule + lint: no strategy uses inside:exchangeRoot; per-exchange anchors resolve with the exchange element as scope (resolve('exchangeRoot', document).els enumerates); inside: under an exchange scope may only reference strict descendants of the exchange; document-scoped inside: only for singletons (composer/sendButton/stopButton inside:composerForm)
- [ ] positive copyResponseButton oracle (must resolve to that exact button) + collection oracles (all user/assistant units across exchanges, all code blocks)
- [ ] re-vendor staleness check so consumers notice an outdated vendored copy

## Active: consumer contract (field test, 2026-09-22)

The Model MCP Bridge's ChatGPT channel died, and it served as this engine's first field test. The pack stayed healthy on the September DOM (vendored-pack audit ok 11–12 / broken 0). But Prompt-queue's composer-ready and reply capture bypass it with dead literals, and nothing caught that. Re-vendoring passed jest 219/219 while the job path was dead. Coordination plan: [Tampermonkey S8](file:///C:/Windows_software/Tampermonkey/docs/plans/chatgpt-2026-09-churn/S8-bridge-recovery.md); consumer side: [Prompt-queue incident plan](file:///C:/Windows_software/Chrome_extensions/Prompt-queue/plans/incident-2026-09-22-bridge-channel-dead.md).

- [ ] S8.2 lives in the CONSUMER first. Prompt-queue `tests/consumer-selector-audit.test.js` reads this repo's `fixtures/chatgpt.com/{current/*,2026-09-21-synthetic-*}` by path and fails when a consumer route:
  - picks a `data-oracle-negative` element first;
  - has no match in a required state;
  - ignores `pendingComposerInput`;
  - yields an empty reply union.
  Nothing is added here yet.
- [ ] S8.9 (deferred until a second consumer adopts the same contract; the Tampermonkey edge-extension is the candidate): lift it into `consumerAudit({ document, state, routes }) -> { results, failures }` here, with the page-text-free JSON output of `audit()`. No CLI until then.

## Deferred (not needed to unbreak users)

- repair assistance / candidate selectors (Tampermonkey churn roadmap Phase F; prior-art record [docs/Research/landscape.yaml](Research/landscape.yaml))
- remote packs, overlays, pin/kill (Phase D/E)
- locale-aware accessible names and dom-accessibility-api
- inside: accepting a matching scope root (not needed: per-exchange anchors resolve with the exchange as scope)
- canary state passing + badge refresh on recovery (Tampermonkey plan S7, post-release)

## Related

- [DESIGN.md](../DESIGN.md)
- [external review 2026-07-27](REVIEW-2026-07-27-external.md)
- [chatgpt.com anatomy](chatgpt-com-anatomy.md)
- [Tampermonkey churn-resistant roadmap](file:///C:/Windows_software/Tampermonkey/docs/plans/churn-resistant-framework/01-ROADMAP.md)
