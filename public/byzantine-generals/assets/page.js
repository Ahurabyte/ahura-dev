/* Page script for "The Byzantine Generals Problem".
   - comprehension checks (commit, then reveal) and the gates they open
   - scrollytelling controller: sets data-step on each canvas and on any [data-widget] inside it,
     and fires `didactician:step` {step, total} on the mount (widget contract, see widgets/manifest.json)
   - progress bar, hero night-map animation (one-shot + replay), w-handshake, f-roles */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var D = window.Didactician || {};

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) {
      if (k === 'style') e.setAttribute('style', attrs[k]);
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function use(id, x, y, size, parent, cls) {
    var u = el('use', { href: '#' + id, x: x, y: y, width: size, height: size }, parent);
    if (cls) u.setAttribute('class', cls);
    return u;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function faNum(n) { return String(n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[+d]; }); }
  function ease(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  /* ================================ checks ================================ */
  var committed = {};
  function commit(id) {
    if (committed[id]) return;
    committed[id] = true;
    document.dispatchEvent(new CustomEvent('didactician:commit', { detail: { id: id } }));
  }
  $$('.d-check').forEach(function (card) {
    var id = card.getAttribute('data-check');
    var fbBox = $('.d-feedback', card);
    var tpl = $('template.fb', card);
    var reveal = $('[data-reveal]', card);
    if (reveal) {
      reveal.addEventListener('click', function () {
        fbBox.innerHTML = '';
        fbBox.appendChild(tpl.content.cloneNode(true));
        reveal.setAttribute('aria-expanded', 'true');
        reveal.disabled = true;
        reveal.textContent = 'نمایش داده شد';
        commit(id);
        var w = $('[data-widget="w-two-worlds"]');
        if (w) w.dispatchEvent(new CustomEvent('didactician:reveal', { detail: { check: id } }));
      });
      return;
    }
    var correct = card.getAttribute('data-correct');
    var opts = $$('.d-option', card);
    opts.forEach(function (b) {
      b.addEventListener('click', function () {
        var pick = b.getAttribute('data-opt');
        opts.forEach(function (o) {
          var isPick = o === b, isRight = o.getAttribute('data-opt') === correct;
          o.setAttribute('aria-pressed', String(isPick));
          o.classList.toggle('is-right', isRight);
          o.classList.toggle('is-wrong', isPick && !isRight);
        });
        fbBox.innerHTML = '';
        var head = document.createElement('p');
        head.className = 'fb-head';
        head.textContent = pick === correct ? 'پاسخ تو: (' + pick + ').' : 'پاسخ تو: (' + pick + '). بهترین پاسخ (' + correct + ') است.';
        fbBox.appendChild(head);
        fbBox.appendChild(tpl.content.cloneNode(true));
        commit(id);
      });
    });
  });

  /* ============================ scrollytelling ============================ */
  var scrollies = [];
  var handlers = {};   // scrolly name → function(step, prev)

  $$('.d-scrolly[data-scrolly]').forEach(function (sc) {
    var stepsCol = $('.d-scrolly-steps', sc);
    var steps = $$('.d-step', sc);
    var canvas = $('.d-scrolly-canvas', sc);
    var gate = sc.getAttribute('data-gate');
    if (gate) stepsCol.inert = true;
    steps.forEach(function (s) {
      if (s.getAttribute('data-gate')) { s.classList.add('is-locked'); s.inert = true; }
    });
    scrollies.push({ sc: sc, steps: steps, canvas: canvas, cur: -1, name: sc.getAttribute('data-scrolly') });
  });

  document.addEventListener('didactician:commit', function (e) {
    var id = e.detail.id;
    scrollies.forEach(function (o) {
      if (o.sc.getAttribute('data-gate') === id) {
        o.sc.classList.remove('is-locked');
        $('.d-scrolly-steps', o.sc).inert = false;
      }
      o.steps.forEach(function (s) {
        if (s.getAttribute('data-gate') === id) { s.classList.remove('is-locked'); s.inert = false; }
      });
    });
    scheduleUpdate();
  });

  function updateScrollies() {
    var vh = window.innerHeight;
    var wide = window.matchMedia('(min-width: 900px)').matches;
    var line = wide ? vh * 0.6 : vh * 0.82;
    scrollies.forEach(function (o) {
      var idx = 0;
      if (!o.sc.classList.contains('is-locked')) {
        for (var i = 0; i < o.steps.length; i++) if (o.steps[i].getBoundingClientRect().top < line) idx = i + 1;
        for (i = 0; i < o.steps.length; i++) if (o.steps[i].classList.contains('is-locked') && idx > i) { idx = i; break; }
      }
      o.steps.forEach(function (s, i) { s.classList.toggle('is-active', i + 1 === idx); });
      if (idx === o.cur) return;
      var prev = o.cur;
      o.cur = idx;
      o.canvas.setAttribute('data-step', idx);
      $$('[data-widget]', o.canvas).forEach(function (w) {
        w.setAttribute('data-step', idx);
        w.dispatchEvent(new CustomEvent('didactician:step', { detail: { step: idx, prev: Math.max(prev, 0), total: o.steps.length } }));
      });
      if (handlers[o.name]) handlers[o.name](idx, Math.max(prev, 0));
    });
  }

  /* ============================== progress bar ============================== */
  var bars = [
    { a: $('[data-pbar="puzzle-1"]'), from: '#puzzle-1', to: '#puzzle-1' },
    { a: $('[data-pbar="puzzle-2"]'), from: '#puzzle-2', to: '#s-05' },
    { a: $('[data-pbar="way-out"]'), from: '#way-out', to: '#s-07' }
  ];
  function updateBar() {
    var y = window.innerHeight * 0.5;
    bars.forEach(function (b) {
      var top = $(b.from).getBoundingClientRect().top, bottom = $(b.to).getBoundingClientRect().bottom;
      var f = clamp((y - top) / Math.max(1, bottom - top), 0, 1);
      $('.pbar-fill', b.a).style.transform = 'scaleX(' + f.toFixed(3) + ')';
      b.a.classList.toggle('on', f > 0 && f < 1);
      b.a.classList.toggle('done', f >= 1);
      if (f > 0 && f < 1) b.a.setAttribute('aria-current', 'step'); else b.a.removeAttribute('aria-current');
    });
  }

  var pending = false;
  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; updateScrollies(); updateBar(); });
  }
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate);

  /* ============================ hero night map ============================ */
  var HERO = {
    wide: {
      w: 640, h: 400, city: { x: 320, y: 184, r: 58 }, moon: { x: 584, y: 48 },
      camps: {
        A: { x: 104, y: 184, lx: 104, ly: 238, anchor: 'middle' },
        B: { x: 536, y: 184, lx: 536, ly: 238, anchor: 'middle' },
        C: { x: 320, y: 336, lx: 352, ly: 352, anchor: 'start' }
      },
      roads: { AB: 'M104,184 Q320,-4 536,184', AC: 'M104,184 Q140,336 320,336', BC: 'M536,184 Q500,336 320,336' },
      xLabel: { dx: 0, dy: -26 }, maskLabel: { x: 288, y: 300, anchor: 'end' }, cityLabelDy: 78
    },
    narrow: {
      w: 328, h: 360, city: { x: 164, y: 184, r: 46 }, moon: { x: 292, y: 36 },
      camps: {
        A: { x: 164, y: 60, lx: 192, ly: 64, anchor: 'end' },
        B: { x: 60, y: 290, lx: 60, ly: 338, anchor: 'middle' },
        C: { x: 268, y: 290, lx: 268, ly: 338, anchor: 'middle' }
      },
      roads: { AB: 'M164,60 Q8,140 60,290', AC: 'M164,60 Q320,140 268,290', BC: 'M60,290 Q164,350 268,290' },
      xLabel: { dx: 0, dy: -24 }, maskLabel: { x: 250, y: 254, anchor: 'start' }, cityLabelDy: -60
    }
  };
  var HERO_END = 4600;

  function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

  function drawHero(svg) {
    var L = HERO[svg.getAttribute('data-layout')];
    var gid = 'glow-' + svg.getAttribute('data-layout');
    var defs = el('defs', {}, svg);
    var rg = el('radialGradient', { id: gid }, defs);
    el('stop', { offset: '0', style: 'stop-color: var(--c4); stop-opacity: .55' }, rg);
    el('stop', { offset: '1', style: 'stop-color: var(--c4); stop-opacity: 0' }, rg);
    var mg = el('radialGradient', { id: gid + '-m' }, defs);
    el('stop', { offset: '0', style: 'stop-color: var(--ink); stop-opacity: .35' }, mg);
    el('stop', { offset: '1', style: 'stop-color: var(--ink); stop-opacity: 0' }, mg);

    var r = rng(L.w === 640 ? 7 : 11), stars = el('g', {}, svg);
    for (var i = 0; i < (L.w === 640 ? 46 : 28); i++) {
      var sx = 12 + r() * (L.w - 24), sy = 10 + r() * (L.h * 0.5);
      el('circle', { cx: sx.toFixed(1), cy: sy.toFixed(1), r: (0.5 + r() * 1.1).toFixed(2), class: 'star', style: 'opacity:' + (0.25 + r() * 0.6).toFixed(2) }, stars);
    }
    el('circle', { cx: L.moon.x, cy: L.moon.y, r: 34, fill: 'url(#' + gid + '-m)' }, svg);
    el('circle', { cx: L.moon.x, cy: L.moon.y, r: 13, style: 'fill: var(--ink); opacity: .9' }, svg);
    el('circle', { cx: L.moon.x + 5, cy: L.moon.y - 3, r: 11, style: 'fill: var(--surface-2)' }, svg);

    el('ellipse', { cx: L.city.x, cy: L.city.y + 30, rx: L.w * 0.46, ry: L.h * 0.36, class: 'ground' }, svg);

    var roads = {};
    Object.keys(L.roads).forEach(function (k) { roads[k] = el('path', { d: L.roads[k], class: 'road' }, svg); });

    // city
    var c = L.city;
    el('circle', { cx: c.x, cy: c.y, r: c.r + 8, fill: 'url(#' + gid + ')' }, svg);
    el('circle', { cx: c.x, cy: c.y, r: c.r, class: 'wall' }, svg);
    el('circle', { cx: c.x, cy: c.y, r: c.r + 1, class: 'crenel' }, svg);
    var bw = c.r * 0.34, bs = [[-1.2, .1, 1.1], [-0.1, -.35, 1.6], [1.0, .05, 1.2], [-0.6, .65, .7], [0.55, .7, .8]];
    bs.forEach(function (b, j) {
      var h = bw * b[2] * 1.4, x = c.x + b[0] * bw - bw / 2, y = c.y + b[1] * bw - h / 2;
      el('rect', { x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), rx: 2, class: 'bldg' }, svg);
      if (j % 2 === 0) el('rect', { x: (x + bw * .3).toFixed(1), y: (y + h * .25).toFixed(1), width: 3, height: 4, class: 'win' }, svg);
      el('rect', { x: (x + bw * .6).toFixed(1), y: (y + h * .55).toFixed(1), width: 3, height: 4, class: 'win' }, svg);
    });
    el('text', { x: c.x, y: c.y + L.cityLabelDy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'city-label halo-text', text: 'شهر' }, svg);

    // camps
    var parts = {};
    Object.keys(L.camps).forEach(function (k) {
      var p = L.camps[k], g = el('g', { class: 'camp' }, svg);
      el('circle', { cx: p.x, cy: p.y, r: 34, fill: 'url(#' + gid + ')', class: 'fire' }, g);
      use('i-tent', p.x - 18, p.y - 22, 36, g, 'tent');
      el('line', { x1: p.x + 14, y1: p.y + 4, x2: p.x + 14, y2: p.y - 36, class: 'pole' }, g);
      el('path', { d: 'M' + (p.x + 14.75) + ',' + (p.y - 36) + 'h17l-4,5.5l4,5.5h-17z', class: 'banner' + (k === 'C' ? ' banner-c' : '') }, g);
      el('text', { x: p.lx, y: p.ly, 'text-anchor': p.anchor, 'dominant-baseline': 'middle', class: 'camp-label halo-text', text: 'ژنرال ' + k }, g);
      if (k === 'C') {
        var m = el('g', { class: 'mask' }, svg);
        use('i-mask', p.x + 6, p.y - 46, 30, m);
        el('text', { x: L.maskLabel.x, y: L.maskLabel.y, 'text-anchor': L.maskLabel.anchor, 'dominant-baseline': 'middle', class: 'halo-text', text: 'خائن؟' }, m);
        parts.mask = m;
      }
    });

    // riders: r1 A→B (captured halfway), r2 A→C, r3 C→B
    function rider() {
      var g = el('g', { class: 'rider' }, svg);
      var inner = el('g', {}, g);
      el('circle', { cx: 0, cy: 0, r: 14, class: 'halo' }, inner);
      use('i-rider', -12, -13, 24, inner);
      return { g: g, inner: inner };
    }
    var riders = [
      { r: rider(), path: roads.AB, t0: 300, t1: 1500, s0: 0, s1: 0.5, caught: true },
      { r: rider(), path: roads.AC, t0: 300, t1: 2200, s0: 0, s1: 1 },
      { r: rider(), path: roads.BC, t0: 600, t1: 2400, s0: 1, s1: 0 }
    ];
    var mid = roads.AB.getPointAtLength(roads.AB.getTotalLength() * 0.5);
    var x = el('g', { class: 'captured' }, svg);
    use('i-x', mid.x - 13, mid.y - 13, 26, x, 'xmark');
    el('text', { x: mid.x + L.xLabel.dx, y: mid.y + L.xLabel.dy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'halo-text', text: 'اسیر شد' }, x);

    function setT(t) {
      riders.forEach(function (o) {
        var len = o.path.getTotalLength();
        var f = ease(clamp((t - o.t0) / (o.t1 - o.t0), 0, 1));
        var s = o.s0 + (o.s1 - o.s0) * f;
        var p = o.path.getPointAtLength(len * s);
        var q = o.path.getPointAtLength(len * clamp(s + (o.s1 > o.s0 ? 0.01 : -0.01), 0, 1));
        var flip = (q.x < p.x) ? -1 : 1;
        if (o.s1 < o.s0) flip = (q.x < p.x) ? -1 : 1;
        o.r.g.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ',' + (p.y - 6).toFixed(1) + ')');
        o.r.inner.setAttribute('transform', 'scale(' + flip + ',1)');
        o.r.g.style.opacity = t < o.t0 ? 0 : 1;
        if (o.caught) o.r.g.classList.toggle('caught', t >= o.t1);
      });
      svg.classList.toggle('beat-x', t >= 1500);
      svg.classList.toggle('beat-m', t >= 2700);
    }
    return { setT: setT };
  }

  (function hero() {
    var fig = $('#hero-fig');
    if (!fig) return;
    var drawn = $$('.hero-svg', fig).map(drawHero);
    var cards = $$('.split-card');
    var raf = 0, timers = [];
    function setAll(t) { drawn.forEach(function (d) { d.setT(t); }); }
    function run() {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout); timers = [];
      cards.forEach(function (c) { c.classList.remove('lit'); });
      if (reduce) { setAll(HERO_END); return; }
      var t0 = performance.now();
      setAll(0);
      (function frame(now) {
        var t = now - t0;
        setAll(t);
        if (t < HERO_END) raf = requestAnimationFrame(frame);
      })(t0);
      timers.push(setTimeout(function () { cards[0] && cards[0].classList.add('lit'); }, 3200));
      timers.push(setTimeout(function () { cards[1] && cards[1].classList.add('lit'); }, 3600));
      timers.push(setTimeout(function () { cards.forEach(function (c) { c.classList.remove('lit'); }); }, 5600));
    }
    setAll(reduce ? HERO_END : 0);
    fig.addEventListener('didactician:replay', run);
    if (!('IntersectionObserver' in window)) { run(); return; }
    var io = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { io.disconnect(); run(); }
    }, { threshold: 0.3 });
    io.observe($('.hero-map', fig));

    var link = $('[data-replay-hero]');
    if (link) link.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      setTimeout(run, reduce ? 0 : 700);
    });
  })();

  /* ============================== w-handshake ============================== */
  (function handshake() {
    var hs = $('#w-handshake');
    if (!hs) return;
    var q = function (k) { return $('[data-hs="' + k + '"]', hs); };
    var stage = $('.hs-stage', hs), rider = q('rider'), chip = q('chip'), fan = q('fan');
    var nEl = q('n'), line = q('line'), live = q('live');
    var badge = { A: $('.hs-badge[data-camp="A"]', hs), B: $('.hs-badge[data-camp="B"]', hs) };
    var campA = $('.hs-a', hs);
    var n = 0, nCustom = 3, step = 0, anim = null, timer = 0;

    function msg(k) {
      if (k === 1) return 'حمله هنگام سپیده‌دم';
      if (k === 2) return 'رسید';
      if (k === 3) return 'تأییدت رسید';
      return 'تأییدِ تأییدت رسید…';
    }
    function sender(k) { return k % 2 ? 'A' : 'B'; }
    function other(s) { return s === 'A' ? 'B' : 'A'; }
    function xs() {
      var W = stage.clientWidth, cw = campA.offsetWidth;
      return { A: cw - 10, B: W - cw - 22 };
    }
    function setBadge(side, kind, text, pop) {
      var b = badge[side];
      var icon = /unsure/.test(kind) ? 'i-q' : /sure/.test(kind) ? 'i-check' : '';
      b.className = 'hs-badge' + (kind ? ' ' + kind : '');
      b.innerHTML = (icon ? '<svg aria-hidden="true"><use href="#' + icon + '"/></svg>' : '') + '<span></span>';
      b.querySelector('span').textContent = text;
      if (pop && !reduce) { void b.offsetWidth; b.classList.add('pop'); }
    }
    function showBadges(k, pop) {
      if (k === 0) {
        setBadge('A', '', 'می‌خواهد سپیده‌دم حمله کند');
        setBadge('B', '', 'هنوز از نقشه خبر ندارد');
        return;
      }
      var s = sender(k), r = other(s);
      setBadge(s, 'unsure', 'مطمئن نیست: پیکم رسید؟', pop);
      setBadge(r, 'sure', 'مطمئن است، ولی می‌داند ' + s + ' مطمئن نیست');
    }
    function updateLine() {
      line.className = 'hs-line';
      if (step === 5) { line.textContent = '۱۰۰ پیک بفرست: شکست بعید می‌شود، ولی هیچ‌وقت ناممکن نمی‌شود.'; return; }
      if (step === 4 && n >= 6) { line.textContent = 'هر پیک تردید را جابه‌جا می‌کند؛ هیچ‌کدام حذفش نمی‌کند.'; line.classList.add('moral'); return; }
      if (step === 4) { line.textContent = 'می‌توانی هر دو اردوگاه را مطمئن کنی؟'; return; }
      line.textContent = '';
    }
    function placeRider(k) {
      if (k === 0) { rider.classList.remove('on'); chip.classList.remove('on'); return; }
      var x = xs(), s = sender(k), r = other(s);
      rider.classList.add('on');
      rider.style.transform = 'translateX(' + x[r] + 'px) scaleX(' + (r === 'A' ? -1 : 1) + ')';
      chip.classList.add('on');
      $('.hs-chip-n', chip).textContent = 'پیک ' + faNum(k);
      $('.hs-chip-t', chip).textContent = '«' + msg(k) + '»';
    }
    function arrived(k, pop) {
      showBadges(k, pop);
      updateLine();
      if (k > 0) live.textContent = 'پیک ' + faNum(k) + ' به ' + other(sender(k)) + ' رسید؛ ' + sender(k) + ' نمی‌داند پیکش رسیده یا نه.';
    }
    function setN(k, animate) {
      if (anim) { anim.cancel(); anim = null; }
      clearTimeout(timer);
      n = k;
      nEl.textContent = String(k);
      if (!animate || reduce || k === 0) { placeRider(k); arrived(k, false); return; }
      var x = xs(), s = sender(k), r = other(s), dir = r === 'A' ? -1 : 1;
      chip.classList.add('on');
      $('.hs-chip-n', chip).textContent = 'پیک ' + faNum(k);
      $('.hs-chip-t', chip).textContent = '«' + msg(k) + '»';
      rider.classList.add('on');
      rider.style.transform = 'translateX(' + x[r] + 'px) scaleX(' + dir + ')';
      if (rider.animate) {
        anim = rider.animate([
          { transform: 'translateX(' + x[s] + 'px) scaleX(' + dir + ')' },
          { transform: 'translateX(' + x[r] + 'px) scaleX(' + dir + ')' }
        ], { duration: 600, easing: 'ease-in-out' });
      }
      timer = setTimeout(function () { arrived(k, true); }, 600);
    }
    function buildFan() {
      fan.innerHTML = '';
      if (step !== 5) return;
      var x = xs(), H = stage.clientHeight, N = 12;
      for (var i = 0; i < N; i++) {
        var d = document.createElement('div');
        d.className = 'fr';
        var lost = (i === 3 || i === 9);
        d.innerHTML = '<svg><use href="#' + (lost ? 'i-rider-x' : 'i-rider') + '"/></svg>';
        var row = i % 4, col = Math.floor(i / 4);
        var y = H * 0.36 + row * H * 0.13 + col * 4;
        d.style.top = (y - 10).toFixed(0) + 'px';
        var endX = lost ? x.A + (x.B - x.A) * (0.42 + col * 0.08) : x.B - col * 22 - (row % 2) * 10;
        d.style.transform = 'translateX(' + endX + 'px)';
        if (lost) d.classList.add('lost');
        fan.appendChild(d);
        if (!reduce && d.animate) {
          d.animate([{ transform: 'translateX(' + x.A + 'px)', opacity: 0 }, { opacity: 1, offset: .15 }, { transform: 'translateX(' + endX + 'px)', opacity: lost ? .9 : 1 }],
            { duration: lost ? 700 : 1000 + i * 30, delay: i * 45, easing: 'ease-out', fill: 'backwards' });
        }
      }
    }
    function setFan(on) {
      hs.classList.toggle('fan', on);
      if (on) {
        if (anim) { anim.cancel(); anim = null; }
        clearTimeout(timer);
        rider.classList.remove('on');
        nEl.textContent = '100';
        chip.classList.add('on');
        $('.hs-chip-n', chip).textContent = 'پیک‌ها ×۱۰۰';
        $('.hs-chip-t', chip).textContent = '«حمله هنگام سپیده‌دم»';
        setBadge('A', 'unsure soft', 'مطمئن نیست (ولی احتمالاً رسیده)', true);
        setBadge('B', 'sure', 'فرمان را دارد؛ می‌داند A نمی‌تواند مطمئن باشد');
        live.textContent = 'A هم‌زمان ۱۰۰ پیک می‌فرستد. حالا شکست بعید است، ولی A هنوز نمی‌تواند مطمئن باشد.';
        buildFan();
        updateLine();
      } else {
        fan.innerHTML = '';
      }
    }
    function onStep(s, prev) {
      step = s;
      hs.setAttribute('data-step', s);
      if (s === 5) { setFan(true); return; }
      setFan(false);
      if (s <= 3) setN(s, s === prev + 1 && s >= 1);
      else setN(Math.max(nCustom, 3), false);
      updateLine();
    }
    handlers.handshake = onStep;

    q('send').addEventListener('click', function () {
      if (step !== 4) return;
      nCustom = n + 1;
      setN(nCustom, true);
    });
    q('reset').addEventListener('click', function () {
      nCustom = 3;
      setN(3, false);
      live.textContent = 'برگشتیم به سه پیک. A مطمئن نیست پیک ۳ رسیده باشد.';
    });
    if ('ResizeObserver' in window) new ResizeObserver(function () { if (step === 5) buildFan(); else placeRider(n); }).observe(stage);
    setN(0, false);
    updateLine();
  })();

  /* ================================ f-roles ================================ */
  (function roles() {
    var fig = $('#f-roles');
    if (!fig) return;
    var svg = $('svg', fig), goals = $('[data-goals]', fig), live = $('[data-roles-live]', fig);
    var step = 0, layout = '';
    var LAY = {
      wide: { w: 480, h: 344, r: 30, C: [240, 76], L1: [104, 256], L2: [376, 256], cl: [240, 30, 'middle'], l1: [104, 308], l2: [376, 308] },
      narrow: { w: 312, h: 224, r: 22, C: [156, 44], L1: [52, 168], L2: [260, 168], cl: [186, 44, 'end'], l1: [52, 208], l2: [260, 208] }
    };
    function chip(x, y, text, color, icon) {
      var g = el('g', { class: 'chip' }, svg);
      var bg = el('rect', { x: 0, y: y - 12, height: 24, rx: 12, class: 'chip-bg', style: 'fill: var(--surface); stroke: ' + color }, g);
      var ic = use(icon, 0, y - 7, 14, g);
      ic.setAttribute('style', 'color: ' + color);
      var t = el('text', { x: 0, y: y + 0.5, 'dominant-baseline': 'middle', text: text }, g);
      var tw = t.getComputedTextLength ? t.getComputedTextLength() : text.length * 7;
      var w = tw + 14 + 6 + 20, x0 = x - w / 2;
      bg.setAttribute('x', x0.toFixed(1)); bg.setAttribute('width', w.toFixed(1));
      // RTL mirror: icon at the right edge; the text (start-anchored) extends left from x0+w-30
      ic.setAttribute('x', (x0 + w - 24).toFixed(1));
      t.setAttribute('x', (x0 + w - 30).toFixed(1));
      return g;
    }
    function draw() {
      var name = fig.clientWidth < 440 ? 'narrow' : 'wide';
      if (name === layout) return;
      layout = name;
      var L = LAY[name];
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.__dMarkers = null;
      svg.setAttribute('viewBox', '0 0 ' + L.w + ' ' + L.h);
      var shapes = {};
      ['C', 'L1', 'L2'].forEach(function (k) {
        var p = L[k];
        shapes[k] = { cx: p[0], cy: p[1], r: L.r };
      });
      var gO = el('g', { 'data-from': '2' }, svg), gR = el('g', { 'data-from': '3' }, svg);
      if (D.arrow) {
        D.arrow(svg, shapes.C, shapes.L1, { color: 'var(--c2)', parent: gO });
        D.arrow(svg, shapes.C, shapes.L2, { color: 'var(--c2)', parent: gO });
        D.arrow(svg, shapes.L1, shapes.L2, { color: 'var(--ink-3)', both: true, parent: gR });
      }
      ['C', 'L1', 'L2'].forEach(function (k) {
        var p = L[k];
        el('circle', { cx: p[0], cy: p[1], r: L.r, class: 'camp-ring' }, svg);
        var s = L.r * 1.25;
        use('i-tent', p[0] - s / 2, p[1] - s / 2 - 1, s, svg, 'camp-icon');
      });
      el('text', { x: L.cl[0], y: L.cl[1], 'text-anchor': L.cl[2], 'dominant-baseline': 'middle', class: 'role d-halo', text: 'فرمانده' }, svg);
      el('text', { x: L.l1[0], y: L.l1[1], 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'role d-halo', text: 'ستوان ۱' }, svg);
      el('text', { x: L.l2[0], y: L.l2[1], 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'role d-halo', text: 'ستوان ۲' }, svg);
      // chips go last so they sit on top of the arrows
      // narrow: slide the order chips toward the lieutenants so the two chips don't touch
      var t = name === 'narrow' ? 0.6 : 0.5;
      var mx1 = L.C[0] + (L.L1[0] - L.C[0]) * t, my = L.C[1] + (L.L1[1] - L.C[1]) * t, mx2 = L.C[0] + (L.L2[0] - L.C[0]) * t;
      // message chips: envelope + quoted words, so an arrow reads as a message carried, not an attack
      gO.appendChild(chip(mx1, my, '«حمله»', 'var(--c2)', 'i-msg'));
      gO.appendChild(chip(mx2, my, '«حمله»', 'var(--c2)', 'i-msg'));
      gR.appendChild(chip((L.L1[0] + L.L2[0]) / 2, L.L1[1], '«گفت: حمله»', 'var(--c2)', 'i-msg'));
      svg.appendChild(gO); svg.appendChild(gR);
      apply();
    }
    var LIVE = [
      'سه اردوگاه: فرمانده در بالا، دو ستوان در پایین.',
      'سه اردوگاه: فرمانده در بالا، دو ستوان در پایین. قوانین در معمای ۲ عوض می‌شود: همه‌ی پیک‌ها می‌رسند و گیرنده می‌داند چه کسی آن را فرستاده است.',
      'فرمانده برای هر ستوان پیامی می‌فرستد: «حمله».',
      'هر ستوان برای دیگری پیام می‌فرستد: «گفت: حمله». هر دو حمله می‌کنند. هدف ۱ و هدف ۲ برآورده شده‌اند.'
    ];
    function apply() {
      $$('[data-from]', svg).forEach(function (g) {
        var k = +g.getAttribute('data-from');
        g.style.opacity = step < k ? 0 : step === k ? 1 : 0.35;
      });
      goals.classList.toggle('met', step >= 3);
      $$('.goal-sr', goals).forEach(function (s) { s.textContent = step >= 3 ? ' (برآورده شد)' : ''; });
      live.textContent = LIVE[Math.min(step, 3)];
    }
    handlers.roles = function (s) { step = s; fig.setAttribute('data-step', s); apply(); };
    draw();
    if ('ResizeObserver' in window) new ResizeObserver(draw).observe(fig);
  })();

  scheduleUpdate();
})();
