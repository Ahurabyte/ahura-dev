/* w-traitor (s-05): four generals, one traitor, OM(1) majority voting (c-05, c-07).

   Model (c-07, Lamport, Shostak & Pease 1982, algorithm OM(1) with n = 4):
     round 1  the commander C sends an order to each lieutenant L1, L2, L3;
     round 2  each lieutenant tells each other lieutenant "C told me X";
     decide   each loyal lieutenant takes the majority of his three values
              (the order he got + the two reports). Binary values, so no ties.
   Loyal generals send the truth; the traitor sends whatever the reader sets.
   Goal 1 (IC1): every loyal lieutenant decides the same.
   Goal 2 (IC2): if C is loyal, they all decide C's order (n/a when C is the traitor).
   With 4 generals and 1 traitor both goals hold for all 32 traitor choices; MODEL.enumerate()
   lists them and the builder's test asserts it. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ model (pure) */
  var LTS = ['L1', 'L2', 'L3'];
  var NAME = { C: 'فرمانده', L1: 'ستوان ۱', L2: 'ستوان ۲', L3: 'ستوان ۳' };
  var WORD = { A: 'حمله', R: 'عقب‌نشینی' };
  function pd(n) { return String(n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[+d]; }); }

  function flip(v) { return v === 'A' ? 'R' : 'A'; }
  function others(l) { return LTS.filter(function (x) { return x !== l; }); }
  function orderTo(s, l) { return s.traitor === 'C' ? s.orders[l] : s.order; }
  // What lieutenant `from` tells lieutenant `to` in round 2: the truth, unless he is the traitor.
  function report(s, from, to) { return s.traitor === from ? s.lies[to] : orderTo(s, from); }
  function count(vals, v) { return vals.filter(function (x) { return x === v; }).length; }
  function majority(vals) { return count(vals, 'A') >= 2 ? 'A' : 'R'; }

  function outcome(s) {
    var loyal = LTS.filter(function (l) { return l !== s.traitor; });
    var ballots = {};
    loyal.forEach(function (l) {
      var items = [{ from: 'C', v: orderTo(s, l) }].concat(others(l).map(function (o) { return { from: o, v: report(s, o, l) }; }));
      var vals = items.map(function (i) { return i.v; });
      ballots[l] = { items: items, decision: majority(vals), a: count(vals, 'A'), r: count(vals, 'R') };
    });
    var ds = loyal.map(function (l) { return ballots[l].decision; });
    var goal1 = ds.every(function (d) { return d === ds[0]; });
    var goal2 = s.traitor === 'C' ? null : ds.every(function (d) { return d === s.order; });
    return { loyal: loyal, ballots: ballots, goal1: goal1, goal2: goal2 };
  }

  function clone(s) { return { traitor: s.traitor, order: s.order, orders: Object.assign({}, s.orders), lies: Object.assign({}, s.lies) }; }
  function key(s) {
    return s.traitor === 'C' ? 'C:' + LTS.map(function (l) { return s.orders[l]; }).join('')
      : s.traitor + ':' + s.order + others(s.traitor).map(function (l) { return s.lies[l]; }).join('');
  }
  // Case A (x-03): loyal C orders ATTACK; traitor L3 tells L1 and L2 "C told me RETREAT".
  function caseA() { return { traitor: 'L3', order: 'A', orders: { L1: 'A', L2: 'R', L3: 'A' }, lies: { L1: 'R', L2: 'R' } }; }
  // Case B (x-03): traitor C sends ATTACK / RETREAT / ATTACK; everyone else relays honestly.
  function caseB() { return { traitor: 'C', order: 'A', orders: { L1: 'A', L2: 'R', L3: 'A' }, lies: {} }; }
  // Put the mask on general g. A new traitor starts with the most obvious lie.
  function makeTraitor(s, g) {
    var n = clone(s);
    n.traitor = g;
    n.lies = {};
    if (g === 'C') n.orders = { L1: 'A', L2: 'R', L3: 'A' };
    else others(g).forEach(function (o) { n.lies[o] = flip(n.order); });
    return n;
  }
  // Every choice the traitor (and the loyal commander's order) can make: 8 + 3 × 8 = 32.
  function enumerate() {
    var out = [], bits = [0, 1, 2, 3, 4, 5, 6, 7];
    bits.forEach(function (b) {
      out.push({ traitor: 'C', order: 'A', orders: { L1: b & 1 ? 'R' : 'A', L2: b & 2 ? 'R' : 'A', L3: b & 4 ? 'R' : 'A' }, lies: {} });
    });
    LTS.forEach(function (t) {
      bits.forEach(function (b) {
        var o = others(t), lies = {};
        lies[o[0]] = b & 1 ? 'R' : 'A'; lies[o[1]] = b & 2 ? 'R' : 'A';
        out.push({ traitor: t, order: b & 4 ? 'R' : 'A', orders: { L1: 'A', L2: 'A', L3: 'A' }, lies: lies });
      });
    });
    return out;
  }

  var MODEL = { LTS: LTS, flip: flip, others: others, orderTo: orderTo, report: report, majority: majority, outcome: outcome,
    key: key, caseA: caseA, caseB: caseB, makeTraitor: makeTraitor, enumerate: enumerate, clone: clone };
  if (typeof module === 'object' && module.exports) module.exports = MODEL;
  if (typeof window === 'undefined' || !window.Didactician || !window.Didactician.widget) return;

  /* ------------------------------------------------------------------ widget */
  window.Didactician.widget('w-traitor', function (el, ctx) {
    var NS = 'http://www.w3.org/2000/svg';
    var reduce = ctx.reducedMotion;
    var TOTAL = enumerate().length;   // 32

    var TABS = [
      { n: 1, label: 'مورد A', state: caseA,
        text: 'فرمانده وفادار است و فرمان <b>حمله</b> می‌دهد. خائن، ستوان ۳، به بقیه می‌گوید: «فرمانده به من گفت <b>عقب‌نشینی</b>». برگه‌ی رأی ستوان ۲ را بخوان.' },
      { n: 2, label: 'مورد B', state: caseB,
        text: 'فرمانده خائن است: فرمان‌های <b>حمله</b>، <b>عقب‌نشینی</b>، <b>حمله</b> را می‌فرستد. ستوان‌ها آن‌ها را صادقانه بازگو می‌کنند، پس هر برگه‌ی رأی هر سه مقدار یکسان را دارد.',
        short: 'فرمانده‌ی خائن <b>حمله</b>، <b>عقب‌نشینی</b>، <b>حمله</b> می‌فرستد. بازگویی صادقانه به هر برگه همان سه مقدار را می‌دهد.' },
      { n: 3, label: 'تو خائنی', state: caseA,
        text: '<b>تو خائنی.</b> سعی کن ژنرال‌های وفادار را به اختلاف بیندازی. روی یک ژنرال بزن تا نقاب خائن را بگیرد، بعد روی پیام‌های نقاب‌دارش بزن تا برعکس شوند.',
        short: '<b>تو خائنی.</b> وفادارها را به اختلاف بینداز. روی یک ژنرال بزن تا نقاب بگیرد؛ روی پیام‌های ⇄ او بزن تا برعکس شوند.' }
    ];

    /* --- tiny DOM helpers --- */
    function h(tag, attrs, parent, html) {
      var e = document.createElement(tag);
      for (var k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      if (html != null) e.innerHTML = html;
      if (parent) parent.appendChild(e);
      return e;
    }
    function s(tag, attrs, parent) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(e);
      return e;
    }
    function icon(id, cls) { return '<svg class="' + (cls || 'wt-ic') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>'; }
    // a decision: sword / U-turn + the word
    function valHtml(v) { return icon(v === 'A' ? 'i-attack' : 'i-retreat') + '<span>' + WORD[v] + '</span>'; }
    // a message carried by a rider: envelope (in the value's colour) + the quoted word
    function msgHtml(v) { return icon('i-msg') + '<span>«' + WORD[v] + '»</span>'; }

    /* --- build --- */
    el.innerHTML = '';
    var root = h('div', { class: 'wt', 'data-carousel': '' }, el);

    var tabsEl = h('div', { class: 'wt-tabs', role: 'tablist', 'aria-label': 'موردها' }, root);
    var tabBtns = TABS.map(function (t, i) {
      return h('button', { type: 'button', class: 'wt-tab', role: 'tab', id: 'wt-tab-' + i, 'aria-controls': 'wt-panel', 'data-tab': i,
        'data-carousel-goto': i, 'aria-selected': 'false', tabindex: '-1' }, tabsEl,
        '<span class="wt-tab-n" aria-hidden="true">' + t.n + '</span>' + (i === 2 ? icon('i-mask', 'wt-tab-mask') : '') + '<span class="wt-tab-l">' + t.label + '</span>');
    });

    var panel = h('div', { class: 'wt-panel', id: 'wt-panel', role: 'tabpanel', 'aria-labelledby': 'wt-tab-0' }, root);
    var casesEl = h('div', { class: 'wt-cases' }, panel);
    var caseEls = TABS.map(function (t) { return h('p', { class: 'wt-case', 'data-carousel-page': '' }, casesEl, t.text); });

    var stage = h('div', { class: 'wt-stage', 'data-anim': 'once' }, panel);
    var svg = s('svg', { class: 'wt-svg', 'aria-hidden': 'true', focusable: 'false' }, stage);
    var gRoads = s('g', { class: 'wt-roads' }, svg), gArrows = s('g', { class: 'wt-arrows' }, svg), gRiders = s('g', { class: 'wt-riders' }, svg);

    var cname = h('span', { class: 'wt-name wt-name-C', 'aria-hidden': 'true' }, stage, 'فرمانده');
    var camps = {}, names = {};
    ['C', 'L1', 'L2', 'L3'].forEach(function (g) {
      camps[g] = h('button', { type: 'button', class: 'wt-camp', 'data-g': g }, stage,
        '<span class="wt-mono" aria-hidden="true">' + g + '</span>' + icon('i-mask', 'wt-mask') +
        '<span class="wt-pill" aria-hidden="true">' + icon('i-mask', 'wt-pill-ic') + 'خائن</span>');
      if (g !== 'C') names[g] = h('span', { class: 'wt-name', 'aria-hidden': 'true' }, stage, NAME[g]);
    });
    names.C = cname;
    var orderBtn = h('button', { type: 'button', class: 'wt-order' }, stage);

    var cols = {};
    LTS.forEach(function (l) {
      var col = h('div', { class: 'wt-col', 'data-g': l }, stage);
      var ballot = h('div', { class: 'wt-ballot', role: 'group', 'aria-label': 'برگه‌ی رأی ' + NAME[l] }, col);
      var chips = {};
      ['C'].concat(others(l)).forEach(function (from) {
        chips[from] = h('button', { type: 'button', class: 'wt-chip', 'data-from': from, 'data-to': l }, ballot);
      });
      var dec = h('p', { class: 'wt-dec' }, col);
      var tcard = h('div', { class: 'wt-tcard' }, col,
        icon('i-mask', 'wt-tcard-ic') + '<p class="wt-tcard-h">خائن</p><p class="wt-tcard-t">رأی خودش شمرده نمی‌شود.</p>' +
        '<p class="wt-tcard-hint">پیام‌های نقاب‌دارش را در برگه‌های دیگر برگردان.</p>');
      cols[l] = { col: col, ballot: ballot, chips: chips, dec: dec, tcard: tcard };
    });

    var foot = h('div', { class: 'wt-foot' }, panel);
    var goalsEl = h('div', { class: 'wt-goals' }, foot);
    var goal1 = h('p', { class: 'wt-goal', 'data-goal': '1' }, goalsEl);
    var goal2 = h('p', { class: 'wt-goal', 'data-goal': '2' }, goalsEl);
    var ctl = h('div', { class: 'wt-ctl' }, foot);
    var counter = h('span', { class: 'wt-count' }, ctl);
    var resetBtn = h('button', { type: 'button', class: 'wt-btn wt-reset' }, ctl, 'از اول');
    h('button', { type: 'button', class: 'd-replay wt-btn wt-replay', 'data-replay': '', 'aria-label': 'پخش دوباره‌ی پیک‌ها' }, ctl, 'پخش دوباره');
    var live = h('p', { class: 'wt-sr', 'aria-live': 'polite' }, root);

    /* --- state --- */
    var tab = 0;
    var state = caseA();
    var shown = clone(state);       // what the ballots currently display (lags `state` while riders travel)
    var phase = 2;                  // 0 = ballots empty, 1 = orders arrived, 2 = everything arrived
    var visited = {}, splits = 0;
    var narrow = false, W = 0, P = {};
    var timers = [], played = false, visible = false;

    /* --- layout: positions from the container width --- */
    function layout(width) {
      W = Math.round(stage.clientWidth || width);
      narrow = W < 600;
      root.classList.toggle('is-narrow', narrow);
      caseEls.forEach(function (c, i) { c.innerHTML = narrow && TABS[i].short ? TABS[i].short : TABS[i].text; });
      var H = stage.clientHeight;
      var r = narrow ? 22 : 26, gap = narrow ? 4 : 24;
      var colW = narrow ? (W - 2 * gap) / 3 : Math.min(260, (W - 2 * gap) / 3);
      var x1 = W / 2 - colW - gap, x2 = W / 2 + colW + gap;
      var cx = { L1: x1, L3: W / 2, L2: x2 };
      P = { r: r, colW: colW, H: H,
        C: { x: W / 2, y: narrow ? 22 : 28 },
        L1: { x: x1, y: narrow ? 74 : 98 }, L2: { x: x2, y: narrow ? 74 : 98 }, L3: { x: W / 2, y: narrow ? 106 : 144 },
        ballotTop: narrow ? 144 : 184 };
      ['C', 'L1', 'L2', 'L3'].forEach(function (g) {
        var c = camps[g], p = P[g];
        c.style.left = (p.x - r) + 'px'; c.style.top = (p.y - r) + 'px';
        c.style.width = c.style.height = (2 * r) + 'px';
      });
      // names: under L1/L2, beside L3 and C (wide); commander's name left of C (narrow); lieutenant names hidden on narrow
      place(names.L1, P.L1.x, P.L1.y + r + 12, 'c');
      place(names.L2, P.L2.x, P.L2.y + r + 12, 'c');
      names.L1.classList.add('is-below'); names.L2.classList.add('is-below');
      root.classList.toggle('is-tight', !narrow && colW < 250);
      place(names.L3, P.L3.x + r + 10, P.L3.y, 'l');
      place(names.C, narrow ? P.C.x - r - 8 : P.C.x + r + 10, P.C.y, narrow ? 'r' : 'l');
      // the loyal commander's order chip: right of C on narrow, left of C on wide
      if (narrow) { orderBtn.style.left = (P.C.x + r + 8) + 'px'; orderBtn.style.right = 'auto'; }
      else { orderBtn.style.left = 'auto'; orderBtn.style.right = (W - (P.C.x - r - 10)) + 'px'; }
      orderBtn.style.top = (P.C.y - 22) + 'px';
      LTS.forEach(function (l) {
        var c = cols[l].col;
        c.style.left = (cx[l] - colW / 2) + 'px'; c.style.width = colW + 'px';
        c.style.top = P.ballotTop + 'px'; c.style.bottom = '0px';
      });
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      drawNet();
      paint();
    }
    function place(e, x, y, anchor) {
      e.style.top = y + 'px';
      e.style.left = x + 'px';
      e.style.transform = 'translate(' + (anchor === 'c' ? '-50%' : anchor === 'r' ? '-100%' : '0') + ', -50%)';
    }

    /* --- the messenger network: order arrows from C, dashed roads between lieutenants --- */
    function shape(g) { return { cx: P[g].x, cy: P[g].y, r: P.r }; }
    function drawNet() {
      while (gRoads.firstChild) gRoads.removeChild(gRoads.firstChild);
      while (gArrows.firstChild) gArrows.removeChild(gArrows.firstChild);
      if (!P.C) return;
      var t = state.traitor;
      [['L1', 'L2'], ['L1', 'L3'], ['L2', 'L3']].forEach(function (pr) {
        var a = P[pr[0]], b = P[pr[1]], d = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / d, uy = (b.y - a.y) / d, o = P.r + 4;
        s('line', { class: 'wt-road' + (pr.indexOf(t) >= 0 ? ' is-lie' : ''), x1: a.x + ux * o, y1: a.y + uy * o, x2: b.x - ux * o, y2: b.y - uy * o }, gRoads);
      });
      var lie = t === 'C';
      LTS.forEach(function (l) {
        if (window.Didactician.arrow) {
          window.Didactician.arrow(svg, shape('C'), shape(l), { color: lie ? 'var(--c5)' : 'var(--ink-3)', width: 2, dashed: lie, parent: gArrows, className: 'wt-arrow' });
        }
      });
    }

    /* --- riders: a small horseman carries each message along its road --- */
    function ride(from, to, v, isLie, delay, dur) {
      if (reduce || !visible) return;
      var a = P[from], b = P[to];
      if (!a || !b) return;
      var g = s('g', { class: 'wt-rider' + (isLie ? ' is-lie' : '') + (v === 'A' ? ' v-a' : ' v-r') }, gRiders);
      s('circle', { cx: 0, cy: 0, r: narrow ? 10 : 12, class: 'wt-rider-bg' }, g);
      var u = s('use', { href: '#i-rider', x: narrow ? -8 : -9, y: narrow ? -8 : -9, width: narrow ? 16 : 18, height: narrow ? 16 : 18, class: 'wt-rider-ic' }, g);
      u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-rider');
      g.style.opacity = '0';
      var anim = g.animate([
        { transform: 'translate(' + a.x + 'px,' + a.y + 'px)', opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { transform: 'translate(' + b.x + 'px,' + b.y + 'px)', opacity: 0 }
      ], { duration: dur, delay: delay, easing: 'ease-in-out', fill: 'both' });
      anim.onfinish = function () { if (g.parentNode) g.parentNode.removeChild(g); };
    }
    function clearRiders() { while (gRiders.firstChild) gRiders.removeChild(gRiders.firstChild); }
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function cancel() { timers.forEach(clearTimeout); timers = []; clearRiders(); }

    // Full two-round sequence: orders out, then every lieutenant relays to the others.
    // Slow enough to follow each rider (user review d-07: ~1.9x the first build's 520ms rides).
    var DUR = 1000, GAP = 260;
    function playRounds() {
      cancel();
      shown = clone(state);
      if (reduce || !visible) { phase = 2; paint(); return; }
      phase = 0; paint();
      LTS.forEach(function (l) { ride('C', l, orderTo(state, l), state.traitor === 'C', 0, DUR); });
      later(function () { phase = 1; paint(['C']); }, DUR - 60);
      LTS.forEach(function (from) {
        others(from).forEach(function (to) { ride(from, to, report(state, from, to), state.traitor === from, DUR + GAP, DUR); });
      });
      later(function () { phase = 2; paint(LTS, true); }, 2 * DUR + GAP + 20);
    }

    // Animate only the messages that changed between what is shown and the new state.
    function playDiff() {
      cancel();
      var before = outcome(shown), after = outcome(state), orders = [], relays = [];
      after.loyal.forEach(function (l) {
        after.ballots[l].items.forEach(function (it) {
          var old = before.ballots[l] && before.ballots[l].items.filter(function (x) { return x.from === it.from; })[0];
          if (!old || old.v !== it.v) (it.from === 'C' ? orders : relays).push({ from: it.from, to: l, v: it.v });
        });
      });
      var changedKeys = orders.concat(relays).map(function (m) { return m.from + '>' + m.to; });
      var lieOf = function (m) { return m.from === state.traitor; };
      if (reduce || !visible) { shown = clone(state); phase = 2; paint(null, true, changedKeys); return; }
      orders.forEach(function (m) { ride(m.from, m.to, m.v, lieOf(m), 0, DUR * 0.8); });
      var d2 = orders.length ? DUR * 0.8 + GAP : 0;
      relays.forEach(function (m) { ride(m.from, m.to, m.v, lieOf(m), d2, DUR * 0.8); });
      later(function () { shown = clone(state); phase = 2; paint(null, true, changedKeys); }, d2 + DUR * 0.8 - 20);
    }

    /* --- paint: render `shown` into the DOM --- */
    function flash(e) {
      e.classList.remove('wt-flash'); void e.offsetWidth; e.classList.add('wt-flash');
    }
    function paint(arrived, final, changedKeys) {
      if (!P.C) return;
      var st = shown, out = outcome(st), t = st.traitor, mine = tab === 2;
      root.setAttribute('data-tab', tab);
      root.setAttribute('data-traitor', t);
      // camps
      ['C', 'L1', 'L2', 'L3'].forEach(function (g) {
        var c = camps[g], isT = g === t;
        c.classList.toggle('is-traitor', isT);
        names[g].classList.toggle('is-traitor', isT);
        c.disabled = !mine;
        c.setAttribute('aria-pressed', isT ? 'true' : 'false');
        c.setAttribute('aria-label', NAME[g] + (isT ? '، خائن' : '، وفادار') + (mine && !isT ? '. بزن تا خائن شود.' : ''));
      });
      // loyal commander's order
      var cLoyal = t !== 'C';
      orderBtn.classList.toggle('is-hidden', !cLoyal);
      orderBtn.disabled = !(mine && cLoyal);
      orderBtn.classList.toggle('is-live', mine && cLoyal);
      orderBtn.innerHTML = '<span class="wt-src">' + (narrow ? 'فرمان او' : 'فرمان فرمانده') + '</span><span class="wt-val v-' + st.order.toLowerCase() + '">' + msgHtml(st.order) + '</span>' +
        (mine && cLoyal ? '<span class="wt-flipi" aria-hidden="true">⇄</span>' : '');
      orderBtn.setAttribute('aria-label', 'فرمان فرمانده: ' + WORD[st.order] + (mine && cLoyal ? '. برای تغییرش بزن.' : ''));
      // ballots
      LTS.forEach(function (l) {
        var C = cols[l], isT = l === t;
        C.col.classList.toggle('is-traitor', isT);
        C.col.classList.toggle('is-focus', tab === 0 && l === 'L2');
        C.col.classList.toggle('is-dim', tab === 0 && l === 'L1');
        var b = out.ballots[l];
        Object.keys(C.chips).forEach(function (from) {
          var chip = C.chips[from];
          if (isT) { chip.disabled = true; chip.tabIndex = -1; return; }
          var it = b.items.filter(function (x) { return x.from === from; })[0];
          var lie = from === t, on = phase === 2 || (phase === 1 && from === 'C');
          var src = from === 'C' ? (narrow ? 'از فرمانده' : 'فرمانده:') : (narrow ? from + ' می‌گوید' : from + ': «فرمانده گفت»');
          chip.className = 'wt-chip' + (lie ? ' is-lie' : '') + (lie && mine ? ' is-live' : '') + (on ? '' : ' is-empty') + ' v-' + it.v.toLowerCase();
          chip.innerHTML = '<span class="wt-src">' + (lie ? icon('i-mask', 'wt-src-ic') : '') + src + '</span>' +
            '<span class="wt-val">' + (on ? msgHtml(it.v) : '<span class="wt-dots">…</span>') + '</span>' +
            (lie && mine ? '<span class="wt-flipi" aria-hidden="true">⇄</span>' : '');
          chip.disabled = !(lie && mine);
          var who = from === 'C' ? 'فرمانده' : NAME[from];
          var what = from === 'C' ? 'فرمان می‌دهد: ' + WORD[it.v] : 'می‌گوید فرمانده به او گفته: ' + WORD[it.v];
          chip.setAttribute('aria-label', who + ' ' + what + ' (به ' + NAME[l] + ')' + (lie ? '، فرستاده‌ی خائن' : '') + (lie && mine ? '. بزن تا برعکس شود.' : ''));
          if (changedKeys && changedKeys.indexOf(from + '>' + l) >= 0) flash(chip);
          else if (arrived && arrived.indexOf(from) >= 0 && on) flash(chip);
        });
        if (isT) { C.dec.innerHTML = ''; return; }
        if (phase < 2) { C.dec.innerHTML = '<span class="wt-dec-wait">در حال شمارش…</span>'; return; }
        C.dec.className = 'wt-dec v-' + b.decision.toLowerCase();
        C.dec.innerHTML = '<span class="wt-dec-arrow" aria-hidden="true">تصمیم:</span><b>' + valHtml(b.decision) + '</b><span class="wt-tally">' +
          pd(Math.max(b.a, b.r)) + '–' + pd(Math.min(b.a, b.r)) + '</span>';
        C.dec.setAttribute('aria-label', NAME[l] + ' تصمیم می‌گیرد: ' + WORD[b.decision] + '، ' + pd(Math.max(b.a, b.r)) + ' رأی به ' + pd(Math.min(b.a, b.r)));
        if (final) flash(C.dec);
      });
      // goals
      var done = phase === 2;
      setGoal(goal1, 1, done ? out.goal1 : undefined, out.goal1 ? 'ژنرال‌های وفادار هم‌نظرند' : 'ژنرال‌های وفادار از هم جدا شدند');
      setGoal(goal2, 2, done ? out.goal2 : undefined, out.goal2 === null ? 'موضوعیت ندارد: فرمانده خائن است' :
        out.goal2 ? 'از فرمانده‌ی وفادار پیروی می‌کنند' : 'از فرمانده‌ی وفادار پیروی نمی‌کنند');
      if (final) { flash(goal1); flash(goal2); }
      // counter
      var n = Object.keys(visited).length;
      var sp = ' · جدایی‌ها: <b class="wt-splits">' + pd(splits) + '</b>';
      counter.innerHTML = n >= TOTAL ? '<b>هر ' + pd(TOTAL) + '</b>' + ' خیانت امتحان شد' + sp
        : 'امتحان‌شده <b>' + pd(n) + '</b>' + (narrow ? '/' + pd(TOTAL) : ' از ' + pd(TOTAL) + ' خیانت') + sp;
      counter.setAttribute('aria-label', pd(n) + ' از ' + pd(TOTAL) + ' خیانت ممکن امتحان شده. جدایی‌ها: ' + pd(splits));
      counter.classList.toggle('is-all', n >= TOTAL);
      if (done) live.textContent = sentence(st, out);
    }
    function setGoal(e, n, ok, text) {
      var cls = ok === undefined ? 'is-wait' : ok === null ? 'is-na' : ok ? 'is-ok' : 'is-bad';
      e.className = 'wt-goal ' + cls;
      var ic = ok === undefined ? '<span class="wt-gdot">…</span>' : ok === null ? '<span class="wt-gdash">—</span>' : icon(ok ? 'i-check' : 'i-x', 'wt-gic');
      e.innerHTML = '<span class="wt-gmark" aria-hidden="true">' + ic + '</span><b>هدف ' + pd(n) + '</b><span class="wt-gtext">' + text + '</span>' +
        '<span class="wt-sr">' + (ok === undefined ? ': در انتظار پیک‌ها' : ok === null ? '' : ok ? ': برآورده شد' : ': برآورده نشد') + '</span>';
    }
    function sentence(st, out) {
      var parts = out.loyal.map(function (l) { return NAME[l] + ' تصمیم می‌گیرد: ' + WORD[out.ballots[l].decision]; });
      return 'خائن: ' + NAME[st.traitor] + '. ' + parts.join('، ') + '. ' +
        (out.goal1 ? 'ژنرال‌های وفادار هم‌نظرند.' : 'ژنرال‌های وفادار از هم جدا شدند.') + ' ' +
        (out.goal2 === null ? 'هدف ۲ موضوعیت ندارد: فرمانده خائن است.' : out.goal2 ? 'از فرمان فرمانده پیروی می‌کنند.' : 'از فرمان فرمانده پیروی نمی‌کنند.') +
        (tab === 2 ? ' ' + pd(Object.keys(visited).length) + ' از ' + pd(TOTAL) + ' خیانت امتحان شده، ' + pd(splits) + ' جدایی.' : '');
    }

    /* --- reader actions --- */
    function record() {
      if (tab !== 2) return;
      var k = key(state);
      if (!visited[k]) { visited[k] = true; if (!outcome(state).goal1) splits++; }
    }
    function selectTab(i, focus) {
      tab = i;
      tabBtns.forEach(function (b, j) {
        b.setAttribute('aria-selected', j === i ? 'true' : 'false');
        b.tabIndex = j === i ? 0 : -1;
      });
      caseEls.forEach(function (c, j) { c.classList.toggle('on', j === i); });
      panel.setAttribute('aria-labelledby', 'wt-tab-' + i);
      if (focus) tabBtns[i].focus();
      state = TABS[i].state();
      drawNet();
      playRounds();
    }
    tabBtns.forEach(function (b, i) {
      b.addEventListener('click', function () { selectTab(i); });
      b.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (e.key === 'Home') d = -i; else if (e.key === 'End') d = 2 - i;
        if (!d) return;
        e.preventDefault();
        selectTab((i + d + 3) % 3, true);
      });
    });
    Object.keys(camps).forEach(function (g) {
      camps[g].addEventListener('click', function () {
        if (tab !== 2 || state.traitor === g) return;
        state = makeTraitor(state, g);
        record();
        drawNet();
        playRounds();
      });
    });
    orderBtn.addEventListener('click', function () {
      if (tab !== 2 || state.traitor === 'C') return;
      state = clone(state); state.order = flip(state.order);
      record();
      playDiff();
    });
    LTS.forEach(function (l) {
      Object.keys(cols[l].chips).forEach(function (from) {
        cols[l].chips[from].addEventListener('click', function () {
          if (tab !== 2 || from !== state.traitor) return;
          state = clone(state);
          if (from === 'C') state.orders[l] = flip(state.orders[l]);
          else state.lies[l] = flip(state.lies[l]);
          record();
          playDiff();
        });
      });
    });
    resetBtn.addEventListener('click', function () {
      visited = {}; splits = 0;
      state = caseA();
      drawNet();
      playRounds();
    });
    ctx.onReplay(function () { playRounds(); });
    ctx.onVisible(function (v) {
      visible = v;
      if (v && !played) { played = true; playRounds(); }
    });

    /* --- start: Case A, fully drawn --- */
    tabBtns[0].setAttribute('aria-selected', 'true'); tabBtns[0].tabIndex = 0;
    caseEls[0].classList.add('on');
    ctx.onResize(function (w) { layout(w); });
  });
})();
