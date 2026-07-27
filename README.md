# driftwatch

Zero-runtime-dependency JavaScript library for detecting and surviving DOM selector churn in browser extensions. MIT licensed. Works identically in MV3 content scripts, Tampermonkey userscripts, and Node + jsdom.

## The Problem

Browser extensions hardcode CSS selectors for sites like chatgpt.com. These sites redesign constantly. When a selector breaks, the extension fails **silently** — no error, no log, no diagnostic. Just a hang or a no-op. Nobody learns which selector rotted.

### Real Example

chatgpt.com changed the conversation turn element:

```html
<!-- Before -->
<article data-testid="conversation-turn-1">...</article>

<!-- After -->
<section data-turn-id="..." data-testid="conversation-turn-1" data-turn="user">...</section>
```

An extension targeting `article[data-testid^="conversation-turn-"]` matched zero elements and hung forever. A tag-agnostic selector `[data-testid^="conversation-turn-"]` survived both versions.

**Core insight:** Generic strategies outlast qualified ones. driftwatch ranks them that way by default and detects when the DOM contract changes so you can update your pack.

## Install

```bash
npm install driftwatch
```

## Quick Start

### MV3 Content Script

```javascript
import { driftwatch } from 'driftwatch';
import conversationPack from './packs/chatgpt.json';

const dw = driftwatch(conversationPack);

// Resolve a named anchor from the pack
const result = dw.resolve('sendButton', document);
if (result.ok) {
  result.el.click(); // the element that matched
  if (result.degraded) {
    console.warn('Selector degraded; strategy index:', result.strategyIndex);
  }
} else {
  console.error('Could not find send button:', result.reason);
}

// Audit the current state
const audit = dw.audit(document);
console.log(audit); // { ok: number, degraded: number, broken: number, ... }

// Set up canary polling and storage reporting
dw.canary({
  pollIntervalMs: 5000,
  storage: chrome.storage
});
```

### Userscript with @require

```javascript
// ==UserScript==
// @name        My Extension
// @namespace   http://example.com/
// @version     1.0
// @require      https://cdn.jsdelivr.net/npm/driftwatch@latest/dist/driftwatch.js
// ==/UserScript==

(function() {
  const dw = window.driftwatch(GM_conversationPack); // pack bundled or injected globally
  const result = dw.resolve('sendButton', document);
  if (result.ok) {
    result.el.click();
  }
})();
```

### Node + jsdom

```javascript
import { driftwatch } from 'driftwatch';
import { JSDOM } from 'jsdom';
import conversationPack from './packs/chatgpt.json';

const html = '...'; // or fetch from live site
const dom = new JSDOM(html);
const dw = driftwatch(conversationPack);

const result = dw.resolve('conversationTurn', dom.window.document);
console.log(result);
// { ok: true, reason: null, el: <Element>, els: [...], 
//   strategyIndex: 1, strategyId: 'attr-role-role', matchedCount: 3, 
//   degraded: true, attempts: [...] }
```

## Writing a Pack

A pack is data-only JSON per site. No code changes needed to support a new site.

```json
{
  "site": "chatgpt.com",
  "anchors": {
    "conversationTurn": {
      "riskClass": "observe",
      "strategies": [
        {
          "id": "css-article-data-testid",
          "kind": "css",
          "value": "article[data-testid^='conversation-turn-']",
          "minMatches": 1
        },
        {
          "id": "css-section-data-testid",
          "kind": "css",
          "value": "section[data-testid^='conversation-turn-']",
          "minMatches": 1
        },
        {
          "id": "attr-data-testid-prefix",
          "kind": "testid",
          "value": "conversation-turn-",
          "op": "^",
          "minMatches": 1
        }
      ]
    },
    "sendButton": {
      "riskClass": "action",
      "degradeLimit": 1,
      "strategies": [
        {
          "id": "css-send-button-aria-label",
          "kind": "css",
          "value": "button[aria-label*='Send']",
          "maxMatches": 1
        },
        {
          "id": "role-button-name-send",
          "kind": "role",
          "value": "button",
          "name": "Send",
          "maxMatches": 1
        }
      ]
    }
  }
}
```

### Strategy Kinds

- **css** — standard CSS selector
- **testid** — matches `[data-testid]` with operator: `=` (equals), `^` (starts), `*` (contains)
- **attr** — matches any attribute, with optional `value` and operator
- **role** — matches ARIA `role`, with optional `name` matching

### Anchor Risk Classes

- **action** — elements you click. Fail closed; return null after `degradeLimit` strategies. Safe to click.
- **observe** — elements you read. Degrade freely down the strategy list. Safe to examine.

### Constraints

- `minMatches` — strategy fails if fewer matches (default 1)
- `maxMatches` — strategy fails if more matches (no default; use for unambiguous elements)
- `degradeLimit` — for action anchors, how many strategies can degrade before fail (default 1)

## Audit Report

```javascript
const audit = dw.audit(document);

// Returns:
{
  "anchors": {
    "conversationTurn": {
      "status": "ok",           // ok | degraded | broken | absent | ambiguous
      "strategyIndex": 0,
      "strategyId": "css-article-data-testid",
      "matchedCount": 5,
      "reason": null
    },
    "sendButton": {
      "status": "degraded",
      "strategyIndex": 1,
      "strategyId": "role-button-name-send",
      "matchedCount": 1,
      "reason": "Strategy 0 failed; fell back to index 1"
    }
  },
  "summary": {
    "ok": 1,
    "degraded": 1,
    "broken": 0,
    "absent": 0,
    "ambiguous": 0
  }
}
```

### Status Values

- **ok** — first strategy matched exactly
- **degraded** — first strategy failed; a fallback succeeded (churn signal)
- **broken** — all strategies failed
- **absent** — element transient or not expected (e.g., stop button mid-stream)
- **ambiguous** — matched more than `maxMatches`

## Privacy

Reports contain only pack-authored ids, statuses, and match counts. Never page text, URLs beyond hostname, or raw DOM captures. The library is designed to be privacy-preserving by construction.

```javascript
dw.canary({
  pollIntervalMs: 5000,
  storage: chrome.storage, // or GM_setValue for userscripts
  onReport: (audit) => {
    // audit.summary and audit.anchors contain only safe data
    // upload to your endpoint if needed
  }
});
```

## Contributing Fixtures

Fixtures live in `test/fixtures/[site-name]/[YYYY-MM-DD]/` directories. Add a new dated fixture to extend test coverage without changing engine code. Degradation on a new fixture fails CI, ensuring strategy[0] always describes today's DOM.

```bash
test/fixtures/
  chatgpt.com/
    2025-01-15/
      page.html              # sanitized, attribute-only DOM
      audit-golden.json      # expected audit result
    2025-02-01/
      page.html
      audit-golden.json
```

## Non-Goals

- **No auto-healing:** strategies must be manually updated in the pack
- **No LLM selector inference:** selectors are human-authored
- **No network reporting:** reports stay local or go to your own endpoint
- **No shadow DOM piercing:** light DOM only
- **No XPath:** CSS and ARIA only
- **No text-content matching:** fragile and language-dependent

## License

MIT
