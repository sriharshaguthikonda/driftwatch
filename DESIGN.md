# driftwatch Design Rationale

## The Silent Failure Problem

Browser extensions bind to DOM selectors at development time. The sites they target redesign constantly, sometimes monthly. When a selector becomes invalid, the extension silently stops working. No exceptions are thrown. No logs are written. The user experiences hangs, missed messages, or no-ops — but has no way to know the root cause.

Traditional monitoring looks for network errors or runtime exceptions. Selector churn produces neither. It is structural: the code runs perfectly; the data it expects has moved.

driftwatch solves this by:

1. **Detecting churn** — the DOM contract changed if fallback strategies were needed
2. **Reporting safely** — exporting only pack-authored IDs and match counts, never page text
3. **Persisting evidence** — timestamping audit snapshots to the browser's local storage so you know when degradation started
4. **Acting locally** — no network calls, all logic runs on the client

## Why Generic Strategies Beat Newest-First

Most selector libraries rank strategies by specificity or recency. driftwatch ranks by genericity.

### The Evidence: article → section

chatgpt.com changed:

```
article[data-testid^="conversation-turn-"] → section[data-testid^="conversation-turn-"]
```

If strategies were ranked newest-first:
- Strategy 0: `section[data-testid^="conversation-turn-"]` ← fails on old versions
- Strategy 1: `article[data-testid^="conversation-turn-"]` ← fails on new versions

Both old and new versions would report degradation, making the signal useless.

If strategies are ranked generic-first:
- Strategy 0: `[data-testid^="conversation-turn-"]` ← survives both versions
- Strategy 1: `article[data-testid^="conversation-turn-"]` ← survives old
- Strategy 2: `section[data-testid^="conversation-turn-"]` ← survives new

Old versions use strategy 0 (no degradation). New versions use strategy 0 (no degradation). Only when the attribute value itself changes (e.g., `data-testid` is removed) does the library fall through and signal degradation.

**Principle:** Generic strategies have longer shelf lives. Rank them first. Specific strategies are breakdowns, not upgrades.

## Action vs. Observe Risk Classes

Two anchor types require different degradation policies.

### Action Anchors (Clickable Elements)

An action anchor is an element the extension code intends to click or interact with. Clicking the wrong element is worse than not clicking at all.

- **Policy:** Fail closed after `degradeLimit` strategies (default 1). `resolve()` returns `null` rather than guessing.
- **Rationale:** Silent wrong-element clicks can delete data, archive conversations, or trigger unintended actions. Better to hang than corrupt state.

### Observe Anchors (Readable Elements)

An observe anchor is an element the extension reads from (text content, attributes, computed styles). Returning stale or nearby data is recoverable.

- **Policy:** Degrade freely down the strategy list. No `degradeLimit`.
- **Rationale:** Extracting text or checking a flag is lower-risk. Fallback strategies that match nearby elements are informative and safe.

## Fail-Closed for Clickable Elements

The `degradeLimit` mechanism ensures action anchors do not guess. If the first `degradeLimit` strategies fail, `resolve()` returns:

```javascript
{
  ok: false,
  reason: "Degraded beyond limit",
  el: null,
  strategyIndex: -1
}
```

The extension code explicitly checks `result.ok` before calling `.click()`. No implicit fallback; no accidental interactions.

## Text-Free Reports by Construction

driftwatch reports contain only:

- Pack-authored anchor and strategy IDs (strings)
- Statuses (`ok`, `degraded`, `broken`, `absent`, `ambiguous`)
- Integer match counts and strategy indices
- Timestamps (if using canary polling)

They never contain:

- Page text or quoted HTML
- Full URLs (only hostname extracted if needed)
- Attribute values from the live page
- DOM snapshots

This is enforced structurally: the audit API cannot access page text. It counts matches and returns IDs. If you want a raw DOM capture for debugging, that is logged locally only and blocked from storage by the `tools/check-no-captures.mjs` linter.

## The Ratchet: Fixtures Drive Honesty

Fixtures live in dated directories:

```
test/fixtures/chatgpt.com/
  2025-01-15/
    page.html
    audit-golden.json
  2025-02-01/
    page.html
    audit-golden.json
```

The ratchet mechanism works like this:

1. **Old fixture degrades:** If a test runs against the 2025-01-15 fixture and strategy[0] no longer matches, the test marks it `degraded` but passes (old is expected to degrade over time).
2. **New fixture degrades:** If strategy[0] fails on the 2025-02-01 fixture, the test fails. This is not allowed.
3. **Adding a fixture:** Drop in a new dated directory. Zero code changes needed. Existing strategies are re-validated against today's DOM.

**Why this works:** Developers often update packs reactively (only when a user complains). The ratchet makes proactive updates obvious: if you have a 2025-02-01 fixture, your strategy[0] MUST match it. This forces the pack to stay fresh.

The ratchet is not a test runner; it is a discipline enforcer. It prevents strategy drift.

## Pack JSON Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `site` | string | yes | Hostname or domain (e.g., `chatgpt.com`). Used for organizing fixtures and reports. |
| `anchors` | object | yes | Map of anchor name → anchor definition. At least one anchor required. |
| `anchors[*].riskClass` | `"action"` or `"observe"` | yes | Controls degradation policy. Action anchors fail closed; observe anchor degrade freely. |
| `anchors[*].degradeLimit` | number | no | Max strategies to try for action anchors before failing closed. Default: 1. Ignored for observe anchors. |
| `anchors[*].strategies` | array | yes | Ordered list of strategy objects. Tried in order; first match wins. |
| `anchors[*].strategies[*].id` | string | yes | Unique telemetry key for this strategy. Used in audit reports. Example: `css-article-testid`. |
| `anchors[*].strategies[*].kind` | string | yes | Strategy type: `css`, `testid`, `attr`, or `role`. |
| `anchors[*].strategies[*].value` | string | yes | Selector value (CSS string for `css`; testid substring for `testid`; attribute name for `attr`; role name for `role`). |
| `anchors[*].strategies[*].op` | string | no | For `testid` and `attr` kinds: `=` (exact), `^` (starts), `*` (contains). Default: `=`. |
| `anchors[*].strategies[*].minMatches` | number | no | Strategy fails if fewer than this many elements match. Default: 1. Use 0 to allow zero matches. |
| `anchors[*].strategies[*].maxMatches` | number | no | Strategy fails if more than this many elements match. Omit for no upper bound. Useful for ensuring unambiguous elements. |
| `anchors[*].strategies[*].name` | string | no | For `role` kind only. ARIA name (accessible name) to match. Exact match. |
| `anchors[*].strategies[*].value` (role) | string | no | For `role` kind only. The ARIA role value (e.g., `button`, `menuitem`). |

### Example: Full Pack Structure

```json
{
  "site": "example.com",
  "anchors": {
    "submitButton": {
      "riskClass": "action",
      "degradeLimit": 1,
      "strategies": [
        {
          "id": "role-button-submit",
          "kind": "role",
          "value": "button",
          "name": "Submit",
          "maxMatches": 1
        },
        {
          "id": "css-input-type-submit",
          "kind": "css",
          "value": "input[type='submit']",
          "maxMatches": 1
        }
      ]
    },
    "messageList": {
      "riskClass": "observe",
      "strategies": [
        {
          "id": "css-messages-role",
          "kind": "role",
          "value": "list",
          "minMatches": 1
        },
        {
          "id": "css-messages-class",
          "kind": "css",
          "value": "[class*='messages']",
          "minMatches": 1
        }
      ]
    }
  }
}
```

## YAGNI (You Aren't Gonna Need It)

Explicit non-goals, with one-line justifications:

| Feature | Why Not |
|---------|---------|
| Auto-healing (algorithmic selector repair) | Selectors are site-specific; only humans can author trustworthy ones. |
| LLM-based selector inference | Reduces to black-box guessing; no auditability or reproducibility. |
| Network reporting | Privacy risk and operationally complex; local storage is simpler and sufficient. |
| Shadow DOM piercing | Minority use case; complicates traversal logic without clear payoff. |
| XPath support | CSS is more readable and equally powerful for the target domain. |
| Text-content matching | Language-dependent and brittle; moved elements break instantly. |
| Hybrid CSS+JS selectors | Mixing concerns; CSS-only is declarative and testable. |
| Strategy auto-ranking by age | Leads to churn; generic strategies outlive specific ones regardless of date. |
| Retry loops with backoff | Extension runs synchronously; timeout is simpler than polled retry. |
| Caching resolved elements | Extensions deal with dynamic DOM; caches mask churn and must be invalidated anyway. |
| In-pack comments (JSON5) | driftwatch packs are data, not code; migrations tool can inject metadata if needed. |

## Resolve API Shape

```javascript
dw.resolve(anchorName, rootElement)
  → {
      ok: boolean,                   // true iff element was found within constraints
      reason: string | null,         // if !ok, one of: "Ambiguous", "No match", "Degraded beyond limit"
      el: Element | null,            // matched element, or null if !ok
      els: Element[],                // all elements that matched the winning strategy
      strategyIndex: number,         // 0 for first strategy, -1 if !ok
      strategyId: string | null,     // pack-authored ID of winning strategy, or null if !ok
      matchedCount: number,          // total elements matched by winning strategy
      degraded: boolean,             // true iff strategyIndex > 0 (churn signal)
      attempts: Array<{              // debug trace of each strategy tried
        strategyId: string,
        kind: string,
        ok: boolean,
        matchedCount: number,
        reason: string | null
      }>
    }
```

## Audit API Shape

```javascript
dw.audit(rootElement)
  → {
      anchors: {
        [anchorName]: {
          status: "ok" | "degraded" | "broken" | "absent" | "ambiguous",
          strategyIndex: number,
          strategyId: string | null,
          matchedCount: number,
          reason: string | null
        }
      },
      summary: {
        ok: number,
        degraded: number,
        broken: number,
        absent: number,
        ambiguous: number
      },
      timestamp?: number             // if audit called with options.timestamp: true
    }
```

## Canary Polling

The canary runs a poll on an interval (default 5000 ms) and writes a snapshot to storage only when the audit result changes:

```javascript
dw.canary({
  pollIntervalMs: 5000,              // interval between audits
  storage: chrome.storage.local      // or GM_setValue for userscripts
  maxSnapshots: 50,                  // keep N most recent snapshots
  onReport: (audit, delta) => {}     // callback when status changes
});
```

Storage key: `driftwatch:${packSite}:snapshots`. Each snapshot is timestamped and includes the full audit summary. Old snapshots are pruned to stay within `maxSnapshots`.

## Implementation Constraints

- **No runtime dependencies:** driftwatch is ~10 KB minified, zero external imports
- **Universal environment:** runs in MV3 content scripts (no `document` globals), userscripts (GM_* APIs), and Node + jsdom
- **Synchronous resolution:** `resolve()` and `audit()` do not async/await; they scan the live DOM immediately
- **No mutation:** reading anchors does not modify the page or trigger reflows beyond what the browser already does
- **Single-pass matching:** each strategy is evaluated once per call; no backtracking
