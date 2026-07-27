// driftwatch core: resolve pack-declared "anchors" against the live DOM, ranked
// generic-before-qualified, and report drift without ever touching page content.
// Runs unmodified as a plain script (window.driftwatch) or CommonJS (module.exports).
(function (root) {
  'use strict';

  var OPS = { '=': '=', '^': '^=', '*': '*=' };

  function compile(s) {
    if (s.css) return s.css;
    if (s.testid) return '[data-testid' + (OPS[s.op] || '=') + '"' + s.testid + '"]';
    if (s.attr) return s.value == null ? '[' + s.attr + ']' : '[' + s.attr + '="' + s.value + '"]';
    if (s.role) return '[role="' + s.role + '"]' + (s.name ? '[aria-label="' + s.name + '"]' : '');
    throw new Error('bad strategy: ' + s.id);
  }

  function ownerDoc(scope) {
    return scope.nodeType === 9 ? scope : (scope.ownerDocument || scope);
  }

  // jsdom has no layout engine: <html> itself always reports zero client rects there,
  // never on a real rendered page. Lets "visible" tell "can't check" from "actually hidden".
  function hasLayout(doc) {
    try {
      var html = doc.documentElement;
      return !!(html && html.getClientRects && html.getClientRects().length > 0);
    } catch (e) { return false; }
  }

  function isEnabled(el) {
    return !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
  }

  // Filters raw selector matches down to elements passing every `requires` entry.
  // Mutates attemptMeta with diagnostic flags (unchecked / insideUnresolved) as it goes.
  function applyRequires(els, reqs, scope, pack, opts, resolving, attemptMeta) {
    if (!reqs || !reqs.length) return els;
    var doc = ownerDoc(scope);
    var insideCache = {};
    return els.filter(function (el) {
      for (var i = 0; i < reqs.length; i++) {
        var req = reqs[i];
        if (req === 'connected') {
          if (!el.isConnected) return false;
        } else if (req === 'enabled') {
          if (!isEnabled(el)) return false;
        } else if (req === 'visible') {
          if (hasLayout(doc)) {
            if (!(el.getClientRects().length > 0)) return false;
          } else {
            attemptMeta.unchecked = attemptMeta.unchecked || [];
            if (attemptMeta.unchecked.indexOf('visible') === -1) attemptMeta.unchecked.push('visible');
          }
        } else if (req.indexOf('inside:') === 0) {
          var anchorName = req.slice(7);
          if (!(anchorName in insideCache)) {
            if (resolving.has(anchorName)) {
              insideCache[anchorName] = null; // recursion guard: treat as unresolved
            } else {
              resolving.add(anchorName);
              var r = resolveInternal(pack, anchorName, scope, opts, resolving);
              resolving.delete(anchorName);
              insideCache[anchorName] = r.ok ? r.el : null;
            }
          }
          var anchorEl = insideCache[anchorName];
          if (!anchorEl || anchorEl === el || !anchorEl.contains(el)) {
            attemptMeta.insideUnresolved = attemptMeta.insideUnresolved || !anchorEl;
            return false;
          }
        }
      }
      return true;
    });
  }

  // Runs one strategy: selector match + requires filter. Shared by resolve() (hot path,
  // stops at the first winner) and audit()'s diagnostic all-strategies pass.
  function runStrategy(pack, s, scope, opts, resolving) {
    var attemptMeta = { id: s.id };
    var raw;
    try {
      raw = Array.prototype.slice.call(scope.querySelectorAll(compile(s)));
    } catch (e) {
      attemptMeta.count = -1; // selector unsupported here
      return { els: [], attemptMeta: attemptMeta };
    }
    var els = applyRequires(raw, s.requires, scope, pack, opts, resolving, attemptMeta);
    if (attemptMeta.insideUnresolved) {
      attemptMeta.count = -2; // an "inside:" anchor could not resolve
      return { els: [], attemptMeta: attemptMeta };
    }
    attemptMeta.count = els.length;
    return { els: els, attemptMeta: attemptMeta };
  }

  function effectiveRange(a, opts) {
    var min = a.min == null ? 1 : a.min;
    // Action anchors are singletons by definition: two matches at any strategy
    // index is ambiguous cardinality, not a pick-the-first-one decision. Only
    // an explicit pack-level max overrides this; observe anchors are unaffected.
    var max = a.max != null ? a.max : (a.risk === 'action' ? 1 : Infinity);
    if (a.expected && opts && opts.state && a.expected[opts.state]) {
      var st = a.expected[opts.state];
      if (st.min != null) min = st.min;
      if (st.max != null) max = st.max;
    }
    return { min: min, max: max };
  }

  function resolveInternal(pack, name, root, opts, resolving) {
    var a = pack.anchors[name];
    if (!a) return { ok: false, reason: 'unknown-anchor', el: null, els: [], attempts: [] };
    // A state-conditioned anchor demands opts.state be a KEY in its `expected`
    // map, not merely truthy. A typo'd or unrecognized state (e.g. a trailing
    // space) must be as loud as an omitted one — never silently fall through
    // to the anchor's plain min/max.
    if (a.expected && !(opts && opts.state && Object.prototype.hasOwnProperty.call(a.expected, opts.state))) {
      return {
        ok: false, reason: 'unknown-state', el: null, els: [], attempts: [],
        strategyIndex: -1, strategyId: null, matchedCount: 0, degraded: false,
      };
    }
    var scope = root || document;
    var range = effectiveRange(a, opts);
    var min = range.min, max = range.max;
    var attempts = [];
    for (var i = 0; i < a.strategies.length; i++) {
      var s = a.strategies[i];
      var run = runStrategy(pack, s, scope, opts, resolving);
      attempts.push(run.attemptMeta);
      var els = run.els;
      // Zero matches never resolves, even when min:0 (transient anchors). min:0 only
      // changes the terminal status below (absent vs broken) once all strategies run dry.
      if (els.length === 0 || els.length < min || els.length > max) continue;
      var degraded = i > 0;
      if (degraded && a.risk === 'action' && i > (a.degradeLimit || 0)) {
        return {
          ok: false, reason: 'fail-closed', el: null, els: [], strategyIndex: i,
          strategyId: s.id, matchedCount: els.length, degraded: true, attempts: attempts,
        };
      }
      return {
        ok: true, reason: degraded ? 'degraded' : 'primary',
        el: a.pick === 'last' ? els[els.length - 1] : els[0], els: els,
        strategyIndex: i, strategyId: s.id, matchedCount: els.length, degraded: degraded, attempts: attempts,
      };
    }
    var zero = attempts.every(function (t) { return t.count <= 0; });
    return {
      ok: false, el: null, els: [], strategyIndex: -1, strategyId: null, matchedCount: 0,
      degraded: true, attempts: attempts,
      reason: (min === 0 && zero) ? 'absent' : attempts.some(function (t) { return t.count > max; }) ? 'ambiguous' : 'broken',
    };
  }

  function resolve(pack, name, root, opts) {
    return resolveInternal(pack, name, root, opts, new Set());
  }

  var REASON_TO_STATUS = {
    primary: 'ok', degraded: 'degraded', 'fail-closed': 'broken',
    absent: 'absent', ambiguous: 'ambiguous', broken: 'broken', 'unknown-anchor': 'broken',
    'unknown-state': 'unknown-state',
  };

  function setsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) === -1) return false;
    return true;
  }

  function audit(pack, doc, opts) {
    var scope = doc || document;
    var summary = { ok: 0, degraded: 0, broken: 0, absent: 0, ambiguous: 0, 'unknown-state': 0 };
    var anchors = {};
    var names = Object.keys(pack.anchors);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var a = pack.anchors[name];
      var r = resolveInternal(pack, name, scope, opts, new Set());
      var status = REASON_TO_STATUS[r.reason] || 'broken';
      summary[status] = (summary[status] || 0) + 1;

      // Diagnostic-only, full pass over every strategy — no short-circuit, no min/max
      // gating. Exists purely to catch strategies quietly resolving to DIFFERENT elements
      // than the winner: cardinality (a count) can't see that, element identity can.
      var winnerSet = r.ok ? r.els : [];
      var matchedStrategies = 0, agreeingStrategies = 0;
      for (var j = 0; j < a.strategies.length; j++) {
        var run = runStrategy(pack, a.strategies[j], scope, opts, new Set());
        if (run.els.length > 0) {
          matchedStrategies++;
          if (r.ok && setsEqual(run.els, winnerSet)) agreeingStrategies++;
        }
      }

      anchors[name] = {
        status: status,
        risk: a.risk,
        strategyId: r.strategyId,
        strategyIndex: r.strategyIndex,
        matchedCount: r.matchedCount,
        attempts: r.attempts,
        matchedStrategies: matchedStrategies,
        agreeingStrategies: agreeingStrategies,
        conflictingStrategies: matchedStrategies - agreeingStrategies,
      };
    }
    return {
      pack: pack.pack,
      packVersion: pack.version,
      host: (scope.location && scope.location.host) || (root.location && root.location.host) || null,
      ts: Date.now(),
      anchors: anchors,
      summary: summary,
    };
  }

  function use(pack) {
    return {
      resolve: function (name, root, opts) { return resolve(pack, name, root, opts); },
      audit: function (doc, opts) { return audit(pack, doc, opts); },
    };
  }

  var api = { compile: compile, resolve: resolve, audit: audit, use: use };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.driftwatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
