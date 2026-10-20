/* w-two-worlds (s-04): "Through Lieutenant 1's eyes". A 6-state step-locked canvas (B1 + B4).
   Driven by the page's scrolly: page.js sets data-step on the mount and fires `didactician:step`
   {step, prev, total}; step 0 means "not reached / still locked" and shows step 1's picture.
   Step 6 (the split) is only drawn after the page fires `didactician:reveal` {check: 'k-03'}; the
   k-03 prompt and Reveal button live in the page's step-5 card, not here.

   Model (facts c-04, c-05, c-06; Lamport, Shostak & Pease 1982, Figs. 1 and 2):
   three generals, oral messages that always arrive. A loyal lieutenant passes on exactly the order
   he got; the traitor says whatever suits him. Everything drawn below is computed from WORLDS, so
   the inboxes, the "identical" sign and the decisions follow from the model, not from hand-typed labels. */
(function () {
  'use strict';
  var ID = 'w-two-worlds';
  var NS = 'http://www.w3.org/2000/svg';
  var D = window.Didactician;
  if (!D || !D.widget) return;

  /* ------------------------------------------------------------------ model */
  var WORD = { A: 'حمله', R: 'عقب‌نشینی' };
  var ICON = { A: 'i-attack', R: 'i-retreat' };
  var COL = { A: 'var(--c2)', R: 'var(--c1)' };
  var MSG = 'i-msg';   // a message in transit: envelope + quoted words (the sword / U-turn is for decisions)
  function flip(v) { return v === 'A' ? 'R' : 'A'; }

  var WORLDS = {
    1: { n: 1, traitor: 'L2', orders: { L1: 'A', L2: 'A' } },  // loyal commander; Lieutenant 2 lies (paper Fig. 1)
    2: { n: 2, traitor: 'C', orders: { L1: 'A', L2: 'R' } }    // traitor commander splits his orders (paper Fig. 2)
  };
  function other(L) { return L === 'L1' ? 'L2' : 'L1'; }
  // What lieutenant `from` tells the other lieutenant the commander said.
  function relay(w, from) { var v = w.orders[from]; return w.traitor === from ? flip(v) : v; }
  function inbox(w, L) { return { C: w.orders[L], relay: relay(w, other(L)) }; }
  function sameInbox(a, b) { return a.C === b.C && a.relay === b.relay; }
  // A lieutenant can only act on his inbox. Any inbox where the two messages disagree also arises in a world
  // where the commander is loyal and the other lieutenant lies, and there goal 2 says: follow the commander.
  // So the loyal choice is the commander's word, in every world that looks the same.
  function decide(ib) { return ib.C; }

  var L1_INBOX = inbox(WORLDS[1], 'L1');
  var IDENTICAL = sameInbox(L1_INBOX, inbox(WORLDS[2], 'L1'));
  var L2_INBOX = inbox(WORLDS[2], 'L2');
  var L1_DEC = decide(L1_INBOX), L2_DEC = decide(L2_INBOX);

  /* ------------------------------------------------------------------ steps */
  function spec(step, revealed) {
    var s = step < 1 ? 1 : step > 6 ? 6 : step;
    if (s === 6 && !revealed) s = 5;    // the split is never drawn before Reveal (ac-08)
    var w2 = WORLDS[2];
    var A = '<span class="a">حمله</span>', R = '<span class="r">عقب‌نشینی</span>';
    switch (s) {
      case 1: return { s: 1, view: 'single', world: null, focus: 'L1', dec: {}, goals: {},
        cap: '<b>تو ستوان ۱ هستی.</b> این‌ها پیام‌هایی است که به دستت رسیده. یکی از دو ژنرال دیگر دارد دروغ می‌گوید. کدام‌یک؟',
        live: 'گام ۱ از ۶. تو ستوان ۱ هستی. صندوق تو: پیام فرمانده می‌گوید ' + WORD[L1_INBOX.C] + '؛ پیام ستوان ۲ می‌گوید فرمانده به او گفته ' + WORD[L1_INBOX.relay] + '. یکی از آن‌ها دروغ می‌گوید.' };
      case 2: return { s: 2, view: 'single', world: WORLDS[1], focus: 'L1', dec: { L1: L1_DEC }, goals: { g2: 'hi' }, lie: true,
        cap: '<b>دنیای ۱: ستوان ۲ دروغ می‌گوید.</b> فرمانده واقعاً گفته ' + A + ' و هدف ۲ می‌گوید باید از او پیروی کنی.',
        live: 'گام ۲ از ۶. دنیای ۱: ستوان ۲ خائن است. فرمانده‌ی وفادار برای هر دو ستوان «حمله» می‌فرستد؛ ستوان ۲ به تو دروغ می‌گوید و می‌گوید به او «عقب‌نشینی» گفته شده است. هدف ۲ برقرار است، پس حمله می‌کنی.' };
      case 3: return { s: 3, view: 'single', world: w2, focus: 'L1', dec: {}, goals: {}, lie: true,
        cap: '<b>دنیای ۲: فرمانده دروغ می‌گوید.</b> به هر ستوان یک فرمان متفاوت می‌دهد و ستوان ۲ فرمان خودش را صادقانه بازگو می‌کند.',
        live: 'گام ۳ از ۶. دنیای ۲: فرمانده خائن است. به تو «حمله» و به ستوان ۲ «عقب‌نشینی» می‌فرستد و پیام ستوان ۲ صادقانه می‌گوید به او «عقب‌نشینی» گفته شده است.' };
      case 4: return { s: 4, view: 'pair', focus: 'L1', dec: { L1: L1_DEC }, goals: {},
        cap: (IDENTICAL ? '≡ <b>صندوق یکسان.</b> ' : '') + 'نمی‌توانی بفهمی در کدام دنیایی، پس در هر دو دنیا ' + A + ' می‌کنی.',
        live: 'گام ۴ از ۶. هر دو دنیا کنار هم. در هر کدام، دو پیامی که به تو می‌رسد یکی است: «حمله» از فرمانده و «گفت: عقب‌نشینی» از ستوان ۲. صندوق یکسان است، پس در هر دو دنیا حمله می‌کنی.' };
      case 5: return { s: 5, view: 'single', world: w2, focus: 'L2', inboxL2: true, dec: { L1: L1_DEC, L2: revealed ? L2_DEC : '?' }, goals: {},
        cap: revealed
          ? '<b>او عقب‌نشینی می‌کند.</b> از سمت او، ماجرا این‌طور دیده می‌شود: فرمانده‌ای وفادار فرمان ' + R + ' داده و تو دروغ‌گو هستی.'
          : '<b>حالا سمت ستوان ۲،</b> تصویر آینه‌ای سمت تو. او باید چه کار کند؟ تصمیم بگیر، بعد «نمایش پاسخ» را بزن.',
        live: 'گام ۵ از ۶. دنیای ۲ از سمت ستوان ۲. صندوق او: پیام فرمانده می‌گوید ' + WORD[L2_INBOX.C] + '؛ پیام ستوان ۱ می‌گوید فرمانده به او گفته ' + WORD[L2_INBOX.relay] + '. ' +
          (revealed ? 'پاسخ: او عقب‌نشینی می‌کند.' : 'او باید چه کار کند؟ تصمیم بگیر، بعد «نمایش پاسخ» را بزن.') };
      default: return { s: 6, view: 'single', world: w2, focus: 'out', inboxL2: true, dec: { L1: L1_DEC, L2: L2_DEC }, goals: { g1: 'bad', g2: 'na' }, split: L1_DEC !== L2_DEC,
        cap: 'هیچ قاعده‌ای که ستوان‌ها از پیش بر سرش توافق کرده باشند نمی‌تواند جلوی خائنی را بگیرد که یکی از دو هدف را می‌شکند.',
        live: 'گام ۶ از ۶. نتیجه‌ی دنیای ۲: تو حمله می‌کنی و ستوان ۲ عقب‌نشینی می‌کند. ژنرال‌های وفادار از هم جدا می‌شوند، پس هدف ۱ برآورده نمی‌شود. هدف ۲ موضوعیت ندارد، چون فرمانده خائن است. هیچ قاعده‌ی ازپیش‌توافق‌شده‌ای نمی‌تواند جلوی خائنی را بگیرد که یکی از دو هدف را بشکند.' };
    }
  }

  /* ------------------------------------------------------------------ helpers */
  function S(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function use(id, x, y, size, parent, cls) {
    var u = S('use', { href: '#' + id, x: x, y: y, width: size, height: size }, parent);
    if (cls) u.setAttribute('class', cls);
    return u;
  }
  function txt(parent, x, y, str, cls, anchor) {
    var t = S('text', { x: x, y: y, 'text-anchor': anchor || 'middle', 'dominant-baseline': 'central' }, parent);
    if (cls) t.setAttribute('class', cls);
    t.textContent = str;
    return t;
  }
  function tw(t) { try { return t.getComputedTextLength(); } catch (e) { return t.textContent.length * 7; } }
  function H(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function iconHtml(id) { return '<svg aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>'; }
  function chipHtml(v, isRelay) {
    return '<span class="tw-chip" data-v="' + v + '">' + iconHtml(MSG) + '<span>' + (isRelay ? '«گفت: ' + WORD[v] + '»' : '«' + WORD[v] + '»') + '</span></span>';
  }

  D.widget(ID, function (el, ctx) {
    var animate0 = !ctx.reducedMotion;
    el.setAttribute('data-anim', 'flair');   // step transitions are short (≤ 1.2s) flourishes
    el.innerHTML = '';

    /* ---------------- DOM skeleton ---------------- */
    var root = H('div', 'tw');
    var inboxes = H('div', 'tw-inboxes');
    function inboxPanel(who, title, ib, fromRelay) {
      var p = H('div', 'tw-inbox');
      p.setAttribute('role', 'group');
      p.setAttribute('data-who', who);
      p.setAttribute('aria-label', title);
      p.innerHTML = '<p class="tw-inbox-h">' + iconHtml('i-rider') + '<span>' + title + '</span></p>' +
        '<ul><li><span class="tw-from">فرمانده</span>' + chipHtml(ib.C, false) + '</li>' +
        '<li><span class="tw-from">' + fromRelay + '</span>' + chipHtml(ib.relay, true) + '</li></ul>';
      return p;
    }
    var boxL1 = inboxPanel('L1', 'صندوق تو (ستوان ۱)', L1_INBOX, 'ستوان ۲');
    var boxL2 = inboxPanel('L2', 'صندوق ستوان ۲', L2_INBOX, 'ستوان ۱');
    boxL2.hidden = true;
    // phones, steps 5-6: both inboxes as two aligned rows (the side-by-side panels don't fit 294px)
    var cmp = H('div', 'tw-inbox tw-compare');
    cmp.setAttribute('data-who', 'both');
    cmp.setAttribute('role', 'group');
    cmp.setAttribute('aria-label', 'صندوق هر دو ستوان');
    cmp.innerHTML = '<ul><li data-row="L1"><span class="tw-who">تو<span class="tw-sr"> (ستوان ۱) دریافت کرد</span></span>' + chipHtml(L1_INBOX.C, false) + chipHtml(L1_INBOX.relay, true) + '</li>' +
      '<li data-row="L2"><span class="tw-who">ستوان ۲<span class="tw-sr"> (ستوان ۲) دریافت کرد</span></span>' + chipHtml(L2_INBOX.C, false) + chipHtml(L2_INBOX.relay, true) + '</li></ul>';
    cmp.hidden = true;
    inboxes.appendChild(boxL1); inboxes.appendChild(boxL2); inboxes.appendChild(cmp);
    var stage = H('div', 'tw-stage');
    var svg = S('svg', { class: 'tw-svg', role: 'img' }, stage);
    var cap = H('p', 'tw-cap');
    cap.setAttribute('aria-hidden', 'true');   // the live sentence below says the same, more fully
    var goals = H('div', 'tw-goals');
    goals.setAttribute('aria-label', 'دو هدف');
    function goalRow(n, text) {
      var r = H('p', 'tw-goal', '<b>هدف ' + (n === 1 ? '۱' : '۲') + '</b><span class="tw-goal-txt">' + text + '</span><span class="tw-goal-st"></span>');
      r.setAttribute('data-goal', n);
      goals.appendChild(r);
      return r;
    }
    var g1 = goalRow(1, 'همه‌ی ژنرال‌های وفادار یک کار می‌کنند.');
    var g2 = goalRow(2, 'اگر فرمانده وفادار باشد، از فرمانش پیروی می‌کنند.');
    var live = H('p', 'tw-sr');
    live.setAttribute('aria-live', 'polite');
    root.appendChild(inboxes); root.appendChild(stage); root.appendChild(cap); root.appendChild(goals); root.appendChild(live);
    el.appendChild(root);

    /* ---------------- state ---------------- */
    var step = +(el.getAttribute('data-step') || 0) || 0;
    var revealed = false;
    var cur = null, lastSize = '', token = 0, mode = '';

    /* ---------------- sizing ---------------- */
    function sizeRoot() {
      var W = el.clientWidth;
      var newMode = W < 420 ? 'narrow' : 'wide';
      mode = newMode;
      root.setAttribute('data-mode', mode);
      var side = window.matchMedia('(min-width: 900px)').matches;   // canvas beside the step cards
      // Canvas-height contract with the page (review P-01): below 900px the page gives the mount
      // min-height max(55vh - 34px, 420px). Never lay out in less than 420px; use more when the mount has it.
      var minH = parseFloat(getComputedStyle(el).minHeight) || 0;
      var h = side ? 448 : Math.round(Math.min(560, Math.max(420, minH, window.innerHeight * 0.55 - 34)));
      root.style.height = h + 'px';
    }

    /* ---------------- HTML parts ---------------- */
    function setGoal(row, state, label, sr) {
      row.classList.toggle('is-hi', state === 'hi');
      row.classList.toggle('is-bad', state === 'bad');
      row.classList.toggle('is-na', state === 'na');
      var st = row.querySelector('.tw-goal-st');
      st.innerHTML = label || '';
      if (sr) st.setAttribute('title', sr); else st.removeAttribute('title');
    }
    function updateHtml(sp, animate) {
      var compare = !!sp.inboxL2 && mode === 'narrow';
      boxL2.hidden = !sp.inboxL2 || compare;
      boxL1.hidden = compare;
      cmp.hidden = !compare;
      cmp.querySelector('[data-row="L1"]').classList.toggle('is-dim', sp.s === 5);
      Array.prototype.forEach.call(cmp.querySelectorAll('[data-row="L2"] .tw-chip'), function (c) { c.classList.toggle('is-link', sp.s === 5); });
      boxL1.classList.toggle('is-dim', !!sp.inboxL2 && sp.s === 5);
      Array.prototype.forEach.call(boxL1.querySelectorAll('.tw-chip'), function (c) {
        c.classList.toggle('is-link', sp.s === 4);
        c.classList.remove('is-pulse');
        if (sp.s === 4 && animate) { void c.offsetWidth; c.classList.add('is-pulse'); }
      });
      Array.prototype.forEach.call(boxL2.querySelectorAll('.tw-chip'), function (c) { c.classList.toggle('is-link', sp.s === 5); });
      cap.innerHTML = sp.cap;
      setGoal(g1, sp.goals.g1, sp.goals.g1 === 'bad' ? iconHtml('i-x') + 'برآورده نشد<span class="tw-sr">: ژنرال‌های وفادار از هم جدا شدند</span>' : '');
      setGoal(g2, sp.goals.g2,
        sp.goals.g2 === 'hi' ? 'برقرار است<span class="tw-sr">: فرمانده وفادار است، پس از فرمانش پیروی کن</span>' :
        sp.goals.g2 === 'na' ? 'موضوعیت ندارد<span class="tw-sr">: فرمانده خائن است</span>' : '',
        sp.goals.g2 === 'na' ? 'این‌جا موضوعیت ندارد: فرمانده خائن است' : '');
    }

    /* ---------------- SVG primitives ---------------- */
    var anims = [];
    function pop(node, delay, animate) {
      if (!animate || !node.animate) return;
      node.classList.add('tw-pop');
      anims.push(node.animate([{ opacity: 0, transform: 'scale(.55)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 380, delay: delay, easing: 'cubic-bezier(.3,1.5,.5,1)', fill: 'backwards' }));
    }
    function fade(node, delay, animate, dur) {
      if (!animate || !node.animate) return;
      anims.push(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur || 300, delay: delay, easing: 'ease-out', fill: 'backwards' }));
    }
    // draw a path on, then put its arrowhead back; a rider carries the message along it
    function drawOn(path, delay, animate, rider) {
      if (!animate || !path.animate) return;
      var L = path.getTotalLength(), me = path.getAttribute('marker-end'), my = token;
      path.removeAttribute('marker-end');
      path.style.strokeDasharray = L + ' ' + L;
      var a = path.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 560, delay: delay, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'backwards' });
      anims.push(a);
      a.onfinish = function () { if (my !== token) return; path.style.strokeDasharray = ''; if (me) path.setAttribute('marker-end', me); };
      if (!rider) return;
      var r = use('i-rider', -9, -9, 18, null, 'tw-rider');
      var g = S('g', { opacity: 0 }, path.parentNode);
      g.appendChild(r);
      var t0 = performance.now() + delay;
      (function frame(now) {
        if (my !== token) { g.remove(); return; }
        var k = (now - t0) / 560;
        if (k < 0) { requestAnimationFrame(frame); return; }
        if (k >= 1) { g.remove(); return; }
        var e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        var p = path.getPointAtLength(L * e);
        g.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + (p.y - 12).toFixed(1) + ')');
        g.setAttribute('opacity', k < .1 ? k * 10 : k > .85 ? (1 - k) / .15 : 1);
        requestAnimationFrame(frame);
      })(performance.now());
    }

    // message chip on a route. o: relay, two (two-line), iconOnly, tag ('lie' | 'true'), link
    function chip(parent, cx, cy, v, o) {
      o = o || {};
      var g = S('g', { class: 'tw-sc', 'data-v': v }, parent);
      var col = COL[v], ic, rect;
      if (o.iconOnly) {
        rect = S('circle', { cx: cx, cy: cy, r: 12, class: 'tw-sc-bg' }, g);
        rect.style.stroke = col;
        ic = use(ICON[v], cx - 7, cy - 7, 14, g); ic.style.color = col;
        S('title', null, g).textContent = WORD[v];
        if (o.link) g.style.filter = 'drop-shadow(0 0 5px ' + col + ')';
        return { g: g, x0: cx - 12, y0: cy - 12, w: 24, h: 24 };
      }
      rect = S('rect', { class: 'tw-sc-bg' }, g);
      rect.style.stroke = col;
      ic = use(MSG, 0, 0, 14, g); ic.style.color = col;
      var w, h, x0, y0;
      if (o.two) {
        var t1 = txt(g, cx, cy - 8, '«گفت:', 'tw-sc-t2');
        var t2 = txt(g, 0, cy + 8, WORD[v] + '»', 'tw-sc-t', 'start');
        var w2 = 14 + 4 + tw(t2);
        w = Math.max(tw(t1), w2) + 18; h = 36; x0 = cx - w / 2; y0 = cy - h / 2;
        // RTL: the icon sits at the right (reading start); the text's start anchor is its right edge
        ic.setAttribute('x', (cx + w2 / 2 - 14).toFixed(1)); ic.setAttribute('y', (cy + 1).toFixed(1));
        t2.setAttribute('x', (cx + w2 / 2 - 18).toFixed(1));
        rect.setAttribute('rx', 10);
      } else {
        var t = txt(g, 0, cy, o.relay ? '«گفت: ' + WORD[v] + '»' : '«' + WORD[v] + '»', 'tw-sc-t', 'start');
        w = 9 + 14 + 5 + tw(t) + 10; h = 24; x0 = cx - w / 2; y0 = cy - h / 2;
        // RTL mirror of the LTR layout: icon at the right edge, text extends left from x0+w-28
        ic.setAttribute('x', (x0 + w - 23).toFixed(1)); ic.setAttribute('y', (cy - 7).toFixed(1));
        t.setAttribute('x', (x0 + w - 28).toFixed(1));
        rect.setAttribute('rx', 12);
      }
      rect.setAttribute('x', x0.toFixed(1)); rect.setAttribute('y', y0.toFixed(1));
      rect.setAttribute('width', w.toFixed(1)); rect.setAttribute('height', h);
      if (o.tag) {
        var tg = txt(g, x0 + w - 4, y0 - 8, o.tag === 'lie' ? 'دروغ' : 'راست', o.tag === 'lie' ? 'tw-lie tw-halo' : 'tw-true tw-halo', 'start');
        if (o.tag === 'lie') { rect.style.strokeDasharray = '4 3'; var m = use('i-mask', x0 + w - 8 - tw(tg) - 16, y0 - 15, 14, g); m.style.color = 'var(--c5)'; }
      }
      if (o.link) g.style.filter = 'drop-shadow(0 0 6px ' + col + ')';
      return { g: g, x0: x0, y0: y0, w: w, h: h };
    }

    // a decision tag under a camp: filled, so it reads differently from a message
    function decision(parent, x, y, v, anchor) {
      var g = S('g', { class: 'tw-dec' }, parent);
      if (v === '?') {
        var cx = anchor === 'end' ? x - 12 : anchor === 'start' ? x + 12 : x;
        S('circle', { cx: cx, cy: y, r: 12, class: 'tw-sc-bg' }, g).style.stroke = 'var(--c4)';
        use('i-q', cx - 9, y - 9, 18, g, 'tw-q');
        S('title', null, g).textContent = 'بلاتکلیف';
        return g;
      }
      var col = COL[v];
      var rect = S('rect', { rx: 6, height: 22, class: 'tw-dec-bg' }, g);
      rect.style.stroke = col; rect.style.fill = 'color-mix(in srgb, ' + col + ' 24%, var(--surface))';
      var ic = use(ICON[v], 0, y - 7, 14, g); ic.style.color = col;
      var t = txt(g, 0, y, WORD[v], 'tw-dec-t', 'start');
      var w = 8 + 14 + 4 + tw(t) + 8;
      var x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      rect.setAttribute('x', x0.toFixed(1)); rect.setAttribute('y', (y - 11).toFixed(1)); rect.setAttribute('width', w.toFixed(1));
      // RTL mirror: icon at the right edge, text extends left from x0+w-26
      ic.setAttribute('x', (x0 + w - 22).toFixed(1)); t.setAttribute('x', (x0 + w - 26).toFixed(1));
      return g;
    }

    function camp(parent, who, x, y, r, o) {
      var g = S('g', { class: 'tw-camp' + (o.you ? ' is-you' : '') + (o.traitor ? ' is-traitor' : '') }, parent);
      S('circle', { cx: x, cy: y, r: r, class: 'tw-ring' }, g);
      var s = r * 1.2;
      if (o.traitor) {
        var m = use('i-mask', x - s / 2, y - s / 2, s, g, 'tw-mask');
        pop(m, 120, o.animate);
      } else use('i-tent', x - s / 2, y - s / 2 - 1, s, g, 'tw-tent');
      if (o.doubt) {
        var q = use('i-q', o.left ? x - r * .55 - 18 : x + r * .55, y - r - 6, 18, g, 'tw-q');   // badge leans inward
        pop(q, 200, o.animate);
      }
      return g;
    }

    /* ---------------- one world ---------------- */
    // L: geometry {C, L1, L2 (points), r, compact, w}; world may be null (step 1: unknown traitor)
    function drawWorld(g, sp, world, L, animate) {
      var compact = L.compact, r = L.r;
      var shp = function (k, dy) { return { cx: L[k].x, cy: L[k].y + (dy || 0), r: r }; };
      var gArrows = S('g', null, g), gChips = S('g', null, g), gCamps = S('g', null, g), gLabels = S('g', null, g);
      var orders = world ? world.orders : { L1: L1_INBOX.C };
      var relays = world ? { L2: relay(world, 'L2'), L1: relay(world, 'L1') } : { L2: L1_INBOX.relay, L1: L1_INBOX.C };
      var focus = sp.focus;
      var into = function (target) { return focus === target; };
      // what is drawn at full ink in this step
      var full = {
        CL1: sp.s !== 6 && (focus === 'L1' || sp.s <= 3),
        CL2: !!world && sp.s !== 6 && (sp.s === 2 || sp.s === 3 || focus === 'L2'),
        R21: sp.s !== 6 && focus === 'L1',
        R12: sp.s !== 6 && focus === 'L2'
      };
      var d = 0;
      function route(key, from, to, v, opt) {
        var on = full[key];
        var grp = S('g', { class: on ? '' : 'tw-dim' }, gArrows);
        var p = D.arrow(g.ownerSVGElement, from, to, { color: COL[v], width: on ? 2.5 : 2, parent: grp, curve: opt && opt.curve || 0 });
        if (on) { drawOn(p, 80 + d * 140, animate, true); d++; }
        else fade(grp, 0, animate);
        return { on: on, grp: grp, path: p };
      }
      // routes: order C→L1, order C→L2, relay L2→L1 (upper lane), relay L1→L2 (lower lane)
      var lane = compact ? 0 : 8;
      var rCL1 = route('CL1', shp('C'), shp('L1'), orders.L1);
      var rCL2 = world ? route('CL2', shp('C'), shp('L2'), orders.L2) : null;
      var upper = focus === 'L2' ? 'R12' : 'R21';
      var r21 = route('R21', shp('L2', upper === 'R21' ? -lane : lane), shp('L1', upper === 'R21' ? -lane : lane), relays.L2);
      var r12 = (!compact || focus === 'L2') ? route('R12', shp('L1', upper === 'R12' ? -lane : lane), shp('L2', upper === 'R12' ? -lane : lane), relays.L1) : null;

      // chips
      function mid(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
      var chipDelay = 520;
      function place(rt, pos, v, o) {
        if (!rt) return;
        var holder = S('g', { class: rt.on ? '' : 'tw-dim' }, gChips);
        var c = chip(holder, pos.x, pos.y, v, o);
        if (rt.on) pop(c.g, chipDelay, animate); else fade(holder, 0, animate);
        return c;
      }
      var linkStep = sp.s === 4 || sp.s === 5;
      // compact worlds are too narrow for two word-chips at one height: stagger them (or shrink the dimmed one)
      var side = compact && !L.stacked;   // two worlds side by side: narrow columns
      var pC1 = mid(L.C, L.L1, side ? .56 : L.stacked ? .45 : .48), pC2 = mid(L.C, L.L2, side ? .3 : L.stacked ? .45 : .48);
      if (sp.s !== 6 || !compact) {
        place(rCL1, pC1, orders.L1, { link: linkStep && into('L1') });
        if (rCL2) place(rCL2, pC2, orders.L2, { iconOnly: compact && L.w < 200, link: linkStep && into('L2') });
      }
      var relayY = L.L1.y - (side ? 2 : L.stacked ? 0 : lane);
      var relayX = (L.L1.x + L.L2.x) / 2;
      if (sp.s !== 6) {
        if (focus === 'L1') {
          var tag21 = (sp.s === 2 || sp.s === 3) && world ? (world.traitor === 'L2' ? 'lie' : 'true') : null;
          place(r21, { x: relayX, y: relayY }, relays.L2, { relay: true, two: side, tag: tag21, link: linkStep });
        } else if (r12) {
          place(r12, { x: relayX, y: relayY }, relays.L1, { relay: true, two: side, link: linkStep });
        }
      }

      // camps
      var unknown = !world;
      camp(gCamps, 'C', L.C.x, L.C.y, r, { traitor: world && world.traitor === 'C', doubt: unknown, animate: animate });
      camp(gCamps, 'L1', L.L1.x, L.L1.y, r, { you: focus !== 'L2', animate: animate });
      camp(gCamps, 'L2', L.L2.x, L.L2.y, r, { left: true, you: focus === 'L2', traitor: world && world.traitor === 'L2', doubt: unknown, animate: animate });

      // labels
      var ly = L.L1.y + r + 12;
      if (compact) {
        // RTL: swap start/end so each label occupies the same interval the LTR layout intended
        txt(gLabels, L.L1.x - r, ly, 'تو', 'tw-name is-you tw-halo', 'end');
        txt(gLabels, L.L2.x + r, ly, world && world.traitor === 'L2' ? 'خائن' : 'ستوان ۲', world && world.traitor === 'L2' ? 'tw-traitor-t tw-halo' : 'tw-name tw-halo', 'start');
      } else {
        var cl = txt(gLabels, L.C.x + r + 8, L.C.y - (world && world.traitor === 'C' ? 8 : 0), 'فرمانده', 'tw-name tw-halo', 'end');
        if (world && world.traitor === 'C') {
          var tg = S('g', null, gLabels);
          var ct = txt(tg, L.C.x + r + 8, L.C.y + 9, 'خائن', 'tw-traitor-t tw-halo', 'end');
          use('i-mask', L.C.x + r + 12 + tw(ct), L.C.y + 2, 14, tg, 'tw-mask');
          pop(tg, 200, animate);
        }
        var a1 = L.anchor1, a2 = L.anchor2;
        var ra = function (a) { return a === 'start' ? 'end' : a === 'end' ? 'start' : a; };   // RTL mirror of a text anchor
        var x1 = a1 === 'start' ? L.L1.x - r : L.L1.x, x2 = a2 === 'end' ? L.L2.x + r : L.L2.x;
        txt(gLabels, x1, ly, L.youLabel, 'tw-name is-you tw-halo', ra(a1));
        txt(gLabels, x2, ly, 'ستوان ۲', 'tw-name tw-halo', ra(a2));
        if (world && world.traitor === 'L2') {
          var tg2 = S('g', null, gLabels);
          txt(tg2, x2, ly + 20, 'خائن', 'tw-traitor-t tw-halo', ra(a2));
          pop(tg2, 200, animate);
        }
      }
      // decisions
      var dy = L.stacked ? ly : ly + (compact ? 22 : 24);
      var dx1 = L.stacked ? L.L1.x - r + 32 : compact ? L.L1.x - r : (L.anchor1 === 'start' ? L.L1.x - r : L.L1.x);
      var dx2 = compact ? L.L2.x + r : (L.anchor2 === 'end' ? L.L2.x + r : L.L2.x);
      var an1 = compact ? 'start' : L.anchor1, an2 = compact ? 'end' : L.anchor2;
      if (sp.dec.L1) { var d1 = decision(gLabels, dx1, dy, sp.dec.L1, an1); if (focus === 'L2') d1.setAttribute('class', 'tw-dec tw-dim'); pop(d1, 820, animate); }
      if (sp.dec.L2 && !(world && world.traitor === 'L2')) { var d2 = decision(gLabels, dx2, dy, sp.dec.L2, an2); pop(d2, 820, animate); }
    }

    /* ---------------- the whole stage ---------------- */
    function draw(sp, animate) {
      token++;
      anims.forEach(function (a) { try { a.cancel(); } catch (e) {} });
      anims = [];
      var W = Math.round(stage.clientWidth), Hs = Math.round(stage.clientHeight);
      lastSize = W + 'x' + Hs;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.__dMarkers = null;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Hs);
      var narrow = mode === 'narrow';
      // a faint moonlit ground under the camps
      S('ellipse', { cx: W / 2, cy: Hs * .62, rx: W * .52, ry: Hs * .42, class: 'tw-ground' }, svg);

      if (sp.view === 'single') {
        var r = narrow ? (Hs < 200 ? 15 : 18) : 24;
        var bottom = r + 48;
        var C = { x: W / 2, y: 6 + r };
        var Ly = Math.max(C.y + r + 30, Hs - bottom);
        var L;
        if (narrow) L = { r: r, C: C, L1: { x: r + 6, y: Ly }, L2: { x: W - r - 6, y: Ly }, anchor1: 'start', anchor2: 'end', youLabel: 'تو', w: W };
        else {
          var x1 = Math.max(70, Math.round(W * .16));
          L = { r: r, C: C, L1: { x: x1, y: Ly }, L2: { x: W - x1, y: Ly }, anchor1: 'middle', anchor2: 'middle', youLabel: 'تو (ستوان ۱)', w: W };
        }
        var g = S('g', null, svg);
        txt(g, 4, 8, sp.world ? 'دنیای ' + (sp.world.n === 1 ? '۱' : '۲') : 'چه کسی دروغ می‌گوید؟', 'tw-tag-world', 'end');
        drawWorld(g, sp, sp.world, L, animate);
        if (sp.s === 6 && sp.split) drawSplit(L, animate);
      } else if (narrow) {
        // phones: the two worlds stacked, full width, so every chip keeps its words and the
        // identical messages line up one above the other
        var gapV = 14, hw = (Hs - gapV) / 2, rs = 12;
        [1, 2].forEach(function (n, i) {
          var outer = S('g', { transform: 'translate(0,' + (i * (hw + gapV)).toFixed(1) + ')' }, svg);
          var inner = S('g', null, outer);
          var world = WORLDS[n];
          txt(inner, 4, 8, 'دنیای ' + (n === 1 ? '۱' : '۲'), 'tw-title', 'end');
          var sub = S('g', null, inner);
          use('i-mask', 4, 16, 14, sub, 'tw-mask');
          txt(sub, 22, 23, world.traitor === 'C' ? 'فرمانده دروغ می‌گوید' : 'ستوان ۲ دروغ می‌گوید', 'tw-sub tw-halo', 'end');
          var Ls = { r: rs, compact: true, stacked: true, w: W, C: { x: W / 2, y: rs + 4 }, L1: { x: rs + 2, y: hw - (rs + 25) }, L2: { x: W - rs - 2, y: hw - (rs + 25) } };
          drawWorld(inner, sp, world, Ls, animate);
          if (animate && inner.animate) anims.push(inner.animate([{ opacity: 0, transform: 'translateY(' + (i ? 18 : -18) + 'px)' }, { opacity: 1, transform: 'none' }],
            { duration: 450, delay: i * 90, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }));
        });
        if (IDENTICAL) {
          var eqs = txt(svg, W / 2, hw - 5, '≡', 'tw-eq tw-eq-s');
          S('title', null, eqs).textContent = 'یکسان';
          pop(eqs, 650, animate);
        }
      } else {
        var gap = 44;
        var w = (W - gap) / 2;
        var rc = 18;
        var top = 34;
        var Lyc = Hs - (rc + 46);
        [1, 2].forEach(function (n, i) {
          var outer = S('g', { transform: 'translate(' + (i ? w + gap : 0).toFixed(1) + ',0)' }, svg);
          var inner = S('g', null, outer);
          var world = WORLDS[n];
          txt(inner, w / 2, 8, 'دنیای ' + (n === 1 ? '۱' : '۲'), 'tw-title');
          var sub = S('g', null, inner);
          var st = txt(sub, 0, 24, world.traitor === 'C' ? 'فرمانده دروغ می‌گوید' : 'ستوان ۲ دروغ می‌گوید', 'tw-sub tw-halo', 'start');
          var sw = 14 + 4 + tw(st);
          // RTL mirror: icon at the right end of the centred group, text extends left from there
          use('i-mask', w / 2 + sw / 2 - 14, 17, 14, sub, 'tw-mask');
          st.setAttribute('x', (w / 2 + sw / 2 - 18).toFixed(1));
          var Lc = { r: rc, compact: true, w: w, C: { x: w / 2, y: top + rc + 6 }, L1: { x: rc + 2, y: Lyc }, L2: { x: w - rc - 2, y: Lyc } };
          drawWorld(inner, sp, world, Lc, animate);
          if (animate && inner.animate) anims.push(inner.animate([{ opacity: 0, transform: 'translateX(' + (i ? 28 : -28) + 'px)' }, { opacity: 1, transform: 'none' }],
            { duration: 450, delay: i * 90, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }));
        });
        if (IDENTICAL) {
          var eq = txt(svg, W / 2, (top + rc + 6 + Lyc) / 2, '≡', 'tw-eq');
          S('title', null, eq).textContent = 'یکسان';
          pop(eq, 650, animate);
        }
      }
      svg.setAttribute('aria-label', sp.live.replace(/^گام \S+ از \S+\. /, ''));
    }

    function drawSplit(L, animate) {
      var x = (L.L1.x + L.L2.x) / 2, y0 = L.C.y + L.r + 24, y1 = L.L1.y + L.r + 40;
      var pts = [], n = 7;
      for (var i = 0; i <= n; i++) pts.push((x + (i % 2 ? 7 : -7) * (i && i < n ? 1 : 0)).toFixed(1) + ',' + (y0 + (y1 - y0) * i / n).toFixed(1));
      var crack = S('polyline', { points: pts.join(' '), class: 'tw-crack' }, svg);
      if (animate && crack.animate) {
        var len = crack.getTotalLength ? crack.getTotalLength() : 200;
        crack.style.strokeDasharray = len + ' ' + len;
        var a = crack.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 520, delay: 250, easing: 'ease-in', fill: 'backwards' });
        anims.push(a);
        a.onfinish = function () { crack.style.strokeDasharray = ''; };
      }
      // banner on the crack
      var g = S('g', null, svg);
      var by = L.L1.y - 8;
      var t = txt(g, 0, by, 'هدف ۱ برآورده نشد: وفادارها از هم جدا شدند', 'tw-split-t', 'start');
      var w = 8 + 14 + 6 + tw(t) + 10;
      var maxW = L.L2.x - L.L1.x - 2 * L.r - 8;
      if (w > maxW) { t.textContent = 'هدف ۱ برآورده نشد: جدایی!'; w = 8 + 14 + 6 + tw(t) + 10; }
      var rect = S('rect', { x: x - w / 2, y: by - 13, width: w, height: 26, rx: 13, class: 'tw-split-bg' });
      g.insertBefore(rect, t);
      // RTL mirror: icon at the right edge, text extends left from x+w/2-28
      use('i-x', x + w / 2 - 22, by - 7, 14, g).style.color = 'var(--bad)';
      t.setAttribute('x', (x + w / 2 - 28).toFixed(1));
      pop(g, 700, animate);
    }

    /* ---------------- render ---------------- */
    function render(animate) {
      var sp = spec(step, revealed);
      var changed = !cur || cur.s !== sp.s || cur.cap !== sp.cap;
      cur = sp;
      updateHtml(sp, animate && changed);
      if (changed) live.textContent = sp.live;
      draw(sp, animate && changed);
    }

    sizeRoot();
    render(false);
    root.setAttribute('data-ready', '');

    el.addEventListener('didactician:step', function (e) {
      var s = e && e.detail && typeof e.detail.step === 'number' ? e.detail.step : +(el.getAttribute('data-step') || 0);
      if (s === step) return;
      step = s;
      render(animate0);
    });
    el.addEventListener('didactician:reveal', function (e) {
      if (e && e.detail && e.detail.check && e.detail.check !== 'k-03') return;
      if (revealed) return;
      revealed = true;
      render(animate0);
    });
    ctx.onResize(function () {
      sizeRoot();
      if (cur) draw(cur, false);
    });
    if ('ResizeObserver' in window) new ResizeObserver(function () {
      var size = Math.round(stage.clientWidth) + 'x' + Math.round(stage.clientHeight);
      if (size !== lastSize && cur) draw(cur, false);
    }).observe(stage);
    var lastVh = window.innerHeight;
    window.addEventListener('resize', function () {
      if (Math.abs(window.innerHeight - lastVh) < 40) return;   // ignore mobile URL-bar jitter
      lastVh = window.innerHeight;
      sizeRoot();
    });
  });
})();
