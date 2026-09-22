// driftwatch canary: run an audit, persist only when the drift picture actually
// changes, and hand the caller a report to react to. No timer here on purpose —
// callers already have a poll loop (MutationObserver debounce, setInterval, etc.).
(function (root) {
  'use strict';

  // ponytail: single shared closure state (one canary "session" per page). Multi-pack
  // isolation would need a Map keyed by pack name; add if a consumer ever needs it.
  var dw = (root && root.driftwatch) || (typeof require === 'function' ? require('./core.js') : null);
  var lastFingerprint = null;
  var ring = [];

  function fingerprint(report) {
    var names = Object.keys(report.anchors);
    var parts = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var a = report.anchors[name];
      parts.push(name + ':' + a.status + a.strategyIndex);
    }
    return parts.join('|');
  }

  function persist(value) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ 'driftwatch:drift': value });
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue('driftwatch:drift', value);
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('driftwatch:drift', value);
      }
    } catch (e) { /* nowhere left to persist; drop it */ }
  }

  // opts is passed straight to dw.audit (e.g. { state } for state-conditioned
  // anchors). Legacy callers pass onDegrade as the 3rd argument — keep working.
  function canary(pack, doc, opts, onDegrade) {
    if (typeof opts === 'function') {
      onDegrade = opts;
      opts = undefined;
    }
    var report = dw.audit(pack, doc, opts);
    var fp = fingerprint(report);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      ring.push(report);
      if (ring.length > 20) ring.shift();
      persist(JSON.stringify(report));
      var s = report.summary;
      if ((s.degraded || s.broken || s.ambiguous) && typeof onDegrade === 'function') {
        onDegrade(report);
      }
    }
    return report;
  }

  canary.history = function () { return ring.slice(); };

  if (typeof module !== 'undefined' && module.exports) module.exports.canary = canary;
  if (root) {
    root.driftwatch = root.driftwatch || {};
    root.driftwatch.canary = canary;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
