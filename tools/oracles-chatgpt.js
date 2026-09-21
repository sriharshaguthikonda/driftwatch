// Oracle marker script for chatgpt.com captures: defines
// window.__dwMarkOracles(state) — state is 'idle' | 'composing' | 'streaming' —
// which stamps data-oracle* anchor attributes on the live DOM BEFORE
// tools/sanitize-inpage.js runs; the sanitizer's allowlist preserves the four
// data-oracle* attributes so the anchors survive into the sanitized capture.
// Runs as a plain <script> and under jsdom via window.eval — no top-level
// import/export, no node globals, never reads element text content.

(function () {
'use strict';

// Space-separated token lists: append `token` to el's `attr` only if not
// already present, and count every actual addition in `marked`.
function addToken(el, attr, token, marked) {
  const tokens = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
  if (tokens.indexOf(token) !== -1) return;
  tokens.push(token);
  el.setAttribute(attr, tokens.join(' '));
  marked[token] = (marked[token] || 0) + 1;
}

// Negative markers: set data-oracle-negative="1" once per element, counting
// each newly marked element.
function markNegative(el, count) {
  if (el.getAttribute('data-oracle-negative') === '1') return;
  el.setAttribute('data-oracle-negative', '1');
  count.negatives += 1;
}

const NEGATIVE_BUTTON_LABELS = [
  'Copy message', 'Share prompt', 'Share', 'Rate response',
  'Regenerate response', 'More actions', 'Yes', 'No', 'Dismiss rating prompt',
];

// Entry point: mark oracle anchors for the current composer state.
window.__dwMarkOracles = function (state) {
  if (state !== 'idle' && state !== 'composing' && state !== 'streaming') {
    throw new Error("__dwMarkOracles: state must be 'idle', 'composing' or 'streaming'");
  }

  const marked = {};
  const counts = { negatives: 0 };
  const warnings = [];

  // a. Idempotency wipe: drop any stale oracle markers from a previous run.
  const ORACLE_ATTRS = ['data-oracle', 'data-oracle-negative', 'data-oracle-exchange', 'data-oracle-collection'];
  const stamped = document.querySelectorAll(
    ORACLE_ATTRS.map((a) => '[' + a + ']').join(',')
  );
  for (const el of [...stamped]) {
    for (const attr of ORACLE_ATTRS) {
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
    }
  }

  // b. Composer form anchors (state-dependent send/stop button).
  const form = document.querySelector('form[data-chatgpt-composer]');
  if (form) {
    addToken(form, 'data-oracle', 'composerForm', marked);
    const composer = form.querySelector('[data-composer-markdown]');
    if (composer) addToken(composer, 'data-oracle', 'composer', marked);
    // Send is only a sendButton while composing (idle leaves it present but
    // disabled); Stop only while streaming. In every other state it is a decoy.
    const send = form.querySelector('button[aria-label="Send"]');
    if (send) {
      if (state === 'composing') addToken(send, 'data-oracle', 'sendButton', marked);
      else markNegative(send, counts);
    }
    const stop = form.querySelector('button[aria-label="Stop"]');
    if (stop) {
      if (state === 'streaming') addToken(stop, 'data-oracle', 'stopButton', marked);
      else markNegative(stop, counts);
    }
    for (const label of ['Dictate', 'Add files and more', 'Select ChatGPT model']) {
      const btn = form.querySelector('button[aria-label="' + label + '"]');
      if (btn) markNegative(btn, counts);
    }
    for (const btn of [...form.querySelectorAll('button[aria-label]')]) {
      if (/voice/i.test(btn.getAttribute('aria-label'))) markNegative(btn, counts);
    }
  }

  // c. Exchange roots: every exchange gets the collection token; only the
  // first also gets the singular data-oracle anchor.
  const exchanges = document.querySelectorAll('[data-turn-key]');
  for (let i = 0; i < exchanges.length; i += 1) {
    const ex = exchanges[i];
    addToken(ex, 'data-oracle-collection', 'exchangeRoot', marked);
    if (i === 0) addToken(ex, 'data-oracle', 'exchangeRoot', marked);
  }

  // d. Per-exchange anchors and negative markers.
  for (let i = 0; i < exchanges.length; i += 1) {
    const ex = exchanges[i];

    // User unit: exactly one expected, else warn and mark nothing.
    const users = ex.querySelectorAll('[data-content-search-unit-key$=":user"]');
    if (users.length === 1) {
      addToken(users[0], 'data-oracle-exchange', 'userUnit', marked);
      const edit = users[0].querySelector('button[aria-label="Edit message"]');
      if (edit) addToken(edit, 'data-oracle-exchange', 'editMessageButton', marked);
    } else {
      warnings.push('userUnit exchange ' + i + ': found ' + users.length + ', expected 1');
    }

    // Assistant unit: exactly one expected, else warn and mark nothing.
    const assistants = ex.querySelectorAll('[data-content-search-unit-key$=":assistant"]');
    if (assistants.length === 1) {
      addToken(assistants[0], 'data-oracle-exchange', 'assistantUnit', marked);
      const md = assistants[0].querySelector('[data-markdown-text-style="assistant-message"]');
      if (md) addToken(md, 'data-oracle-exchange', 'assistantMarkdownRoot', marked);
    } else {
      warnings.push('assistantUnit exchange ' + i + ': found ' + assistants.length + ', expected 1');
    }

    // Response action bar wrapping the "More actions" button.
    const more = ex.querySelector('button[aria-label="More actions"]');
    if (more && more.parentElement) {
      addToken(more.parentElement, 'data-oracle-exchange', 'responseActionBar', marked);
      const copy = more.parentElement.querySelector('button[aria-label="Copy"]');
      if (copy) addToken(copy, 'data-oracle-exchange', 'copyResponseButton', marked);
    }

    // Code blocks: collection anchor, set-equal to resolve('codeBlock', ex).els.
    for (const cb of [...ex.querySelectorAll('[data-markdown-copy="code-block"]')]) {
      addToken(cb, 'data-oracle-collection', 'codeBlock', marked);
    }

    // Negatives: decoys no anchor may resolve to (message/share/rate buttons,
    // code-block controls).
    for (const btn of [...ex.querySelectorAll('[data-markdown-copy="code-block"] button')]) {
      markNegative(btn, counts);
    }
    for (const ce of [...ex.querySelectorAll('[data-markdown-copy="code-block"] [contenteditable]')]) {
      markNegative(ce, counts);
    }
    for (const btn of [...ex.querySelectorAll('button[aria-label]')]) {
      if (NEGATIVE_BUTTON_LABELS.indexOf(btn.getAttribute('aria-label')) !== -1) {
        markNegative(btn, counts);
      }
    }
  }

  // e. Summary.
  return { exchanges: exchanges.length, marked: marked, negatives: counts.negatives, warnings: warnings };
};
})();
