// The recorder every web fixture loads. It reports each interaction and a snapshot of the page's own state to the fixture
// server (POST /api/state?run=<id>). A page sets bench.snapshot to a function that returns its state.
(function () {
  var run = new URLSearchParams(location.search).get('run') || 'default';
  var pending = [];
  var timer = null;
  var seq = 0;
  // Put here by the fixture server when it serves this script for a run. The server takes state only with it.
  var nonce = '__BENCH_NONCE__';
  // One id per load of the page: the server counts them, so a reload shows.
  var page = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  function flush() {
    timer = null;
    var body = JSON.stringify({ nonce: nonce, page: page, seq: ++seq, state: bench.snapshot(), events: pending });
    pending = [];
    fetch('/api/state?run=' + encodeURIComponent(run), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true,
    }).catch(function () { /* the server is gone: the run is over */ });
  }

  function record(type, target, value, trusted) {
    var e = { type: type, target: target };
    if (value !== undefined) e.value = value;
    if (trusted !== undefined) e.trusted = trusted;
    pending.push(e);
    if (!timer) timer = setTimeout(flush, 30);
  }

  function nameOf(el) {
    if (!el || !el.closest) return 'document';
    var named = el.closest('[data-bench]');
    return named ? named.dataset.bench : (el.id || el.tagName.toLowerCase());
  }

  var bench = window.bench = { record: record, snapshot: function () { return {}; }, flush: flush };

  // Capture phase on the document: every interaction is seen, whatever the page does with it.
  // Raw input too (mouse, keys, wheel): an action that changes nothing the page tracks (a click on empty space, a key
  // the page ignores) still reached the page, and must not be scored as a false success.
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'wheel', 'input', 'change', 'focusin', 'toggle'].forEach(function (type) {
    document.addEventListener(type, function (e) { record(type, nameOf(e.target), undefined, e.isTrusted); }, true);
  });
  var moved = 0;
  document.addEventListener('pointermove', function (e) {
    var now = Date.now();
    if (now - moved > 250) { moved = now; record('pointermove', nameOf(e.target), undefined, e.isTrusted); }
  }, true);
  var scrolled = 0;
  document.addEventListener('scroll', function () {
    var now = Date.now();
    if (now - scrolled > 250) { scrolled = now; record('scroll', 'document'); }
  }, true);
  // A value set through the accessibility API need not fire an input event: a changed snapshot is an effect too.
  var lastState = null;
  setInterval(function () {
    var now = JSON.stringify(bench.snapshot());
    if (lastState !== null && now !== lastState) record('state', 'snapshot');
    lastState = now;
  }, 200);
  window.addEventListener('focus', function () { record('focus', 'window'); });
  window.addEventListener('load', function () { record('load', 'page'); });
})();
