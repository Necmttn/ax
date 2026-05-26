/* ============================================================
   ax exhibits - shared between origin.html and index.html
   Each IIFE early-returns when its root selector is absent,
   so the file is safe to include on every page.
   ============================================================ */

/* ============================================================
   Exhibit F - enforcement boundary scene
   ============================================================ */
(function () {
  var root = document.querySelector('.fig-enforce');
  if (!root) return;

  var svg       = root.querySelector('[data-enforce-svg]');
  var dotLayer  = root.querySelector('[data-dot-layer]');
  var tip       = root.querySelector('[data-enforce-tip]');
  var hintEl    = root.querySelector('[data-enforce-hint]');
  var boundary  = root.querySelector('[data-boundary]');
  var boundaryLine = root.querySelector('[data-boundary-line]');
  var boundaryHit  = root.querySelector('[data-boundary-hit]');
  var incidentsEl  = root.querySelector('[data-incidents-count]');
  var pills     = root.querySelectorAll('[data-mode-toggle]');

  var SVG_NS    = 'http://www.w3.org/2000/svg';
  var VB_W      = 1000;
  var VB_H      = 280;
  var LANE_TOP  = 70;
  var LANE_BOT  = 210;
  var BOUNDARY_X = 700;
  var POOL      = 28;
  var MAX_LIVE  = 24;

  /* synthetic tool calls - safe vs dangerous */
  var SAFE_CALLS = [
    'Edit{src/foo.ts}',
    'Read{schema.surql}',
    'Bash{npm i}',
    'Bash{git status}',
    'Edit{README.md}',
    'Bash{bun test}',
    'Read{package.json}',
    'Glob{**/*.ts}',
    'Bash{tsc --noEmit}',
    'Edit{src/lib/db.ts}'
  ];
  var DANGER_CALLS = [
    'Bash{git checkout main}',
    'Bash{git push --force main}',
    'Edit{flake.nix}',
    'Bash{git reset --hard origin/main}',
    'Bash{rm -rf .references}',
    'Bash{git commit --amend} on main'
  ];

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mode   = 'prose'; // 'prose' | 'hook'
  var incidents = 0;

  /* pre-allocate dot pool */
  var dots = [];
  for (var i = 0; i < POOL; i++) {
    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'enforce-dot');
    g.setAttribute('data-dot-idx', String(i));

    var halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('class', 'dot-halo');
    halo.setAttribute('r', '14');
    halo.setAttribute('cx', '0');
    halo.setAttribute('cy', '0');
    g.appendChild(halo);

    var core = document.createElementNS(SVG_NS, 'circle');
    core.setAttribute('class', 'dot-core');
    core.setAttribute('r', '4');
    core.setAttribute('cx', '0');
    core.setAttribute('cy', '0');
    g.appendChild(core);

    var blocked = document.createElementNS(SVG_NS, 'text');
    blocked.setAttribute('class', 'dot-blocked');
    blocked.setAttribute('x', '0');
    blocked.setAttribute('y', '-12');
    blocked.setAttribute('text-anchor', 'middle');
    blocked.textContent = 'BLOCKED';
    g.appendChild(blocked);

    g.style.visibility = 'hidden';
    dotLayer.appendChild(g);

    dots.push({
      el: g,
      core: core,
      halo: halo,
      blocked: blocked,
      live: false,
      paused: false,
      x: 0,
      y: 0,
      vx: 0,
      r: 4,
      kind: 'safe',
      label: '',
      blockedAt: 0,
      crossed: false,
      state: 'idle' // 'idle' | 'flying' | 'blocked' | 'fading'
    });
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function spawn(now) {
    var d = null;
    for (var k = 0; k < dots.length; k++) {
      if (!dots[k].live) { d = dots[k]; break; }
    }
    if (!d) return;

    var isDanger = Math.random() < 0.18; // ~1 in 5-6
    d.kind = isDanger ? 'danger' : 'safe';
    d.label = isDanger
      ? DANGER_CALLS[(Math.random() * DANGER_CALLS.length) | 0]
      : SAFE_CALLS[(Math.random() * SAFE_CALLS.length) | 0];
    d.x = -10;
    d.y = rand(LANE_TOP + 8, LANE_BOT - 8);
    d.vx = rand(0.55, 0.95);
    d.r = isDanger ? 7 : 4.5;
    d.live = true;
    d.paused = false;
    d.crossed = false;
    d.state = 'flying';
    d.blockedAt = 0;

    d.core.setAttribute('r', String(d.r));
    d.halo.setAttribute('r', String(d.r + 8));
    d.el.setAttribute('class', 'enforce-dot is-' + d.kind);
    d.el.style.visibility = 'visible';
  }

  function retire(d) {
    d.live = false;
    d.state = 'idle';
    d.el.style.visibility = 'hidden';
    d.el.style.opacity = '';
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    root.setAttribute('data-mode', mode);
    pills.forEach(function (p) {
      var isActive = p.dataset.mode === mode;
      p.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      p.classList.toggle('is-active', isActive);
    });
    boundary.setAttribute('class', mode === 'hook' ? 'is-hook' : 'is-prose');
    if (hintEl) {
      hintEl.textContent = mode === 'hook'
        ? 'tool hook on: dangerous calls stop at the boundary'
        : 'prose only: every call crosses, incidents accumulate';
    }
  }

  function bumpIncidents() {
    incidents++;
    incidentsEl.textContent = String(incidents);
    incidentsEl.classList.remove('is-pulse');
    // force reflow to re-trigger animation
    void incidentsEl.getBoundingClientRect();
    incidentsEl.classList.add('is-pulse');
  }

  /* hover/click handlers ----------------------------------------- */

  function liveDotsCount() {
    var n = 0;
    for (var i = 0; i < dots.length; i++) if (dots[i].live) n++;
    return n;
  }

  function showTip(html, clientX, clientY) {
    tip.innerHTML = html;
    tip.hidden = false;
    var hostRect = root.getBoundingClientRect();
    var x = clientX - hostRect.left + 14;
    var y = clientY - hostRect.top + 14;
    // simple right-edge clamp
    if (x + 220 > hostRect.width) x = clientX - hostRect.left - 240;
    if (y + 40 > hostRect.height) y = clientY - hostRect.top - 30;
    tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  function hideTip() { tip.hidden = true; }

  function findDotFromTarget(target) {
    var el = target;
    while (el && el !== svg) {
      if (el.classList && el.classList.contains('enforce-dot')) {
        var idx = +el.getAttribute('data-dot-idx');
        return dots[idx];
      }
      el = el.parentNode;
    }
    return null;
  }

  svg.addEventListener('mousemove', function (ev) {
    // boundary hover (use elementFromPoint for accurate hit testing)
    if (ev.target === boundaryHit || ev.target === boundaryLine) {
      showTip(
        mode === 'hook'
          ? '<span class="tip-mono">enforcement boundary &middot; pre-tool hook</span>'
          : '<span class="tip-mono">enforcement boundary &middot; prose only</span>',
        ev.clientX, ev.clientY
      );
      return;
    }
    var d = findDotFromTarget(ev.target);
    if (d && d.live) {
      d.paused = true;
      var safeLabel = d.label.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      showTip(
        '<span class="tip-mono">' + safeLabel + '</span><span class="tip-kind is-' + d.kind + '">&middot; ' + (d.kind === 'danger' ? 'dangerous' : 'safe') + '</span>',
        ev.clientX, ev.clientY
      );
    } else {
      // resume any paused dot if we left it
      for (var i = 0; i < dots.length; i++) if (dots[i].paused) dots[i].paused = false;
      hideTip();
    }
  });

  svg.addEventListener('mouseleave', function () {
    for (var i = 0; i < dots.length; i++) if (dots[i].paused) dots[i].paused = false;
    hideTip();
  });

  function toggleMode() { setMode(mode === 'prose' ? 'hook' : 'prose'); }
  boundaryHit.addEventListener('click', toggleMode);
  boundaryHit.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleMode(); }
  });

  pills.forEach(function (p) {
    p.addEventListener('click', function () { setMode(p.dataset.mode); });
  });

  /* main loop ---------------------------------------------------- */

  var lastT = performance.now();
  var spawnAcc = 0;

  function step(now) {
    var dt = Math.min(40, now - lastT);
    lastT = now;

    // spawn cadence ~ every 650ms, lighter if we're at MAX_LIVE
    spawnAcc += dt;
    var spawnEvery = 650;
    if (liveDotsCount() < MAX_LIVE && spawnAcc > spawnEvery) {
      spawnAcc = 0;
      spawn(now);
    } else if (spawnAcc > spawnEvery * 2.2) {
      spawnAcc = 0; // catch up
    }

    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      if (!d.live) continue;

      if (d.state === 'blocked') {
        // fade in place
        var sinceBlocked = now - d.blockedAt;
        var op = Math.max(0, 1 - sinceBlocked / 900);
        d.el.style.opacity = String(op);
        if (op <= 0) { retire(d); }
        continue;
      }

      if (!d.paused) {
        d.x += d.vx * (dt / 16);
      }

      // boundary handling
      if (!d.crossed && d.x >= BOUNDARY_X - d.r) {
        if (mode === 'hook' && d.kind === 'danger') {
          // stop at the line and fade
          d.x = BOUNDARY_X - d.r - 1;
          d.state = 'blocked';
          d.blockedAt = now;
          d.el.classList.add('is-blocked');
          // pulse the halo + flash BLOCKED tag
          d.el.setAttribute('transform', 'translate(' + d.x + ',' + d.y + ')');
          continue;
        } else {
          d.crossed = true;
          if (d.kind === 'danger' && mode === 'prose') {
            bumpIncidents();
          }
        }
      }

      d.el.setAttribute('transform', 'translate(' + d.x + ',' + d.y + ')');

      if (d.x > VB_W + 20) retire(d);
    }

    rafId = requestAnimationFrame(step);
  }

  /* static snapshot for reduced motion ------------------------- */

  function staticSnapshot() {
    var samples = [
      // pre-boundary
      { x: 80,  y: 92,  k: 'safe' },
      { x: 130, y: 158, k: 'safe' },
      { x: 200, y: 110, k: 'safe' },
      { x: 250, y: 180, k: 'danger' },
      { x: 305, y: 130, k: 'safe' },
      { x: 360, y: 96,  k: 'safe' },
      { x: 410, y: 168, k: 'safe' },
      { x: 460, y: 120, k: 'danger' },
      { x: 510, y: 200, k: 'safe' },
      { x: 560, y: 86,  k: 'safe' },
      { x: 615, y: 148, k: 'safe' },
      { x: 660, y: 104, k: 'safe' },
      // blocked at boundary (hook mode shown)
      { x: 690, y: 132, k: 'blocked' },
      { x: 690, y: 174, k: 'blocked' },
      // past boundary - only safe
      { x: 750, y: 110, k: 'safe' },
      { x: 800, y: 162, k: 'safe' },
      { x: 855, y: 96,  k: 'safe' },
      { x: 905, y: 188, k: 'safe' },
      { x: 940, y: 140, k: 'safe' }
    ];
    setMode('hook');
    samples.forEach(function (s, i) {
      var d = dots[i];
      d.live = true;
      d.kind = s.k === 'danger' || s.k === 'blocked' ? 'danger' : 'safe';
      d.label = d.kind === 'danger'
        ? DANGER_CALLS[i % DANGER_CALLS.length]
        : SAFE_CALLS[i % SAFE_CALLS.length];
      d.r = d.kind === 'danger' ? 7 : 4.5;
      d.x = s.x; d.y = s.y;
      d.core.setAttribute('r', String(d.r));
      d.halo.setAttribute('r', String(d.r + 8));
      d.el.setAttribute('class', 'enforce-dot is-' + d.kind + (s.k === 'blocked' ? ' is-blocked' : ''));
      d.el.style.visibility = 'visible';
      d.el.style.opacity = s.k === 'blocked' ? '0.55' : '';
      d.el.setAttribute('transform', 'translate(' + d.x + ',' + d.y + ')');
    });
    if (hintEl) hintEl.textContent = 'motion paused - set system to allow motion to see the flow';
  }

  setMode('prose');
  var rafId = 0;
  if (reduce) {
    staticSnapshot();
  } else {
    rafId = requestAnimationFrame(step);
  }
})();

/* ============================================================
   Exhibit E - retro -> proposal -> experiment -> verdict
   ============================================================ */
(function () {
  var root = document.querySelector('.fig-pipeline');
  if (!root) return;

  var grid          = root.querySelector('[data-pipeline-grid]');
  var scrubber      = root.querySelector('[data-pipeline-scrubber]');
  var rail          = root.querySelector('[data-scrubber-rail]');
  var handle        = root.querySelector('[data-scrubber-handle]');
  var fillBar       = root.querySelector('[data-scrubber-fill]');
  var readout       = root.querySelector('[data-scrubber-readout]');
  var resetBtn      = root.querySelector('[data-pipeline-reset]');
  var retroBody     = root.querySelector('[data-drop="retros"]');
  var propBody      = root.querySelector('[data-drop="proposals"]');
  var expBody       = root.querySelector('[data-drop="experiments"]');
  var verdBody      = root.querySelector('[data-drop="verdicts"]');
  var ticks         = root.querySelectorAll('.scrubber-tick');

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isNarrow = function () { return window.matchMedia('(max-width: 720px)').matches; };

  /* --- data --- */
  var SEED = [
    {
      id: 'main-hook',
      retroTitle: 'ran on main',
      retroMeta: 'sess#4129',
      retroLines: [
        '<span class="lk">retro</span> 05-24',
        'failed=<span class="lv-err">"ran on main"</span>',
        '<span class="lk">&rarr;</span> use-hook'
      ],
      propTitle: 'add pre-tool hook: block writes on main',
      propMeta: 'PreToolUse &middot; bash',
      expName: 'main-branch-hook',
      verdict: 'kept',
      verdictLabel: 'KEPT',
      verdictMeta: 'merged 2026-05-22',
      ticks: {
        7:  '<span class="lk">t+7</span> 12 sessions clean',
        30: '<span class="lk">t+30</span> 0 incidents',
        90: '<span class="lk">t+90</span> <span class="lv-err" style="color:var(--green)">verdict=kept</span>'
      }
    },
    {
      id: 'oxlint-swap',
      retroTitle: 'oxlint slower than promised',
      retroMeta: 'sess#4203',
      retroLines: [
        '<span class="lk">retro</span> 05-12',
        'claimed=<span class="lv-err">"10x faster"</span>',
        '<span class="lk">&rarr;</span> swap-in-ci'
      ],
      propTitle: 'swap eslint &rarr; oxlint in CI',
      propMeta: 'CI &middot; lint stage',
      expName: 'oxlint-swap',
      verdict: 'regressed',
      verdictLabel: 'REGRESSED',
      verdictMeta: 'reverted 2026-05-15',
      ticks: {
        7:  '<span class="lk">t+7</span> 3 false positives',
        30: '<span class="lk">t+30</span> 1 missed rule',
        90: '<span class="lk">t+90</span> <span class="lv-err">reverted</span>'
      }
    },
    {
      id: 'parallel-task',
      retroTitle: 'fan-out flaky',
      retroMeta: 'sess#4287',
      retroLines: [
        '<span class="lk">retro</span> 05-18',
        'failed=<span class="lv-err">"sub-agent stall"</span>',
        '<span class="lk">&rarr;</span> new-skill'
      ],
      propTitle: 'skill: parallel-task-helper',
      propMeta: 'fan-out helper',
      expName: 'parallel-task',
      verdict: 'self-resolved',
      verdictLabel: 'SELF-RESOLVED',
      verdictMeta: 'Task tool defaults changed',
      ticks: {
        7:  '<span class="lk">t+7</span> 4 invocations',
        30: '<span class="lk">t+30</span> 0 invocations',
        90: '<span class="lk">t+90</span> upstream patched'
      }
    }
  ];

  /* per-retro state: 'pending' | 'proposal' | 'experiment' | 'rejected' */
  var state = {};
  /* scrubber position 0..1 */
  var position = 0;
  /* rejected count */
  var rejected = 0;

  /* --- DOM build helpers --- */

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function makeRetroCard(item) {
    var card = document.createElement('div');
    card.className = 'retro-card';
    card.setAttribute('data-id', item.id);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'retro: ' + item.retroTitle + ' (drag to proposals, or click x to reject)');

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'reject-x';
    x.setAttribute('aria-label', 'reject retro');
    x.textContent = '×';
    card.appendChild(x);

    var title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.retroTitle;
    card.appendChild(title);

    var ev = document.createElement('div');
    ev.className = 'card-evidence';
    ev.innerHTML = item.retroLines.join('<br>');
    card.appendChild(ev);

    var actions = document.createElement('div');
    actions.className = 'card-actions';
    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'accept';
    accept.textContent = 'accept';
    actions.appendChild(accept);
    card.appendChild(actions);

    /* listeners */
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      reject(item.id);
    });
    accept.addEventListener('click', function (ev) {
      ev.stopPropagation();
      promote(item.id);
    });

    attachDrag(card, item.id);

    return card;
  }

  function makeProposalCard(item) {
    var card = document.createElement('div');
    card.className = 'proposal-card';
    card.setAttribute('data-id', item.id);

    var title = document.createElement('div');
    title.className = 'card-title';
    title.innerHTML = item.propTitle;
    card.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'card-evidence';
    meta.innerHTML = item.propMeta;
    card.appendChild(meta);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'start-exp';
    btn.textContent = 'start experiment';
    btn.addEventListener('click', function () { startExperiment(item.id); });
    card.appendChild(btn);

    return card;
  }

  function makeExpLane(item) {
    var lane = document.createElement('div');
    lane.className = 'exp-lane';
    lane.setAttribute('data-id', item.id);

    var name = document.createElement('div');
    name.className = 'exp-name';
    name.textContent = item.expName;
    lane.appendChild(name);

    var railEl = document.createElement('div');
    railEl.className = 'exp-rail';
    var fill = document.createElement('div');
    fill.className = 'exp-fill';
    railEl.appendChild(fill);
    [0, 7, 30, 90].forEach(function (cp) {
      var dot = document.createElement('div');
      dot.className = 'exp-cp';
      dot.setAttribute('data-cp', String(cp));
      railEl.appendChild(dot);
    });
    lane.appendChild(railEl);

    var ev = document.createElement('div');
    ev.className = 'exp-evidence';
    [7, 30, 90].forEach(function (cp) {
      var tick = document.createElement('div');
      tick.className = 'ev-tick';
      tick.setAttribute('data-cp', String(cp));
      tick.innerHTML = item.ticks[cp];
      ev.appendChild(tick);
    });
    lane.appendChild(ev);

    return lane;
  }

  function makeVerdictSlot(item) {
    var slot = document.createElement('div');
    slot.className = 'verdict-slot';
    slot.setAttribute('data-id', item.id);

    var pill = document.createElement('span');
    pill.className = 'verdict-pill';
    pill.setAttribute('data-kind', item.verdict);
    pill.textContent = item.verdictLabel;
    slot.appendChild(pill);

    var meta = document.createElement('div');
    meta.className = 'verdict-meta';
    meta.textContent = item.verdictMeta;
    slot.appendChild(meta);

    return slot;
  }

  /* --- state transitions --- */

  function getItem(id) {
    for (var i = 0; i < SEED.length; i++) if (SEED[i].id === id) return SEED[i];
    return null;
  }

  function promote(id) {
    if (state[id] !== 'pending') return;
    state[id] = 'proposal';
    var oldCard = retroBody.querySelector('.retro-card[data-id="' + id + '"]');
    if (oldCard) {
      oldCard.classList.add('is-leaving');
      setTimeout(function () { if (oldCard.parentNode) oldCard.parentNode.removeChild(oldCard); }, 220);
    }
    var card = makeProposalCard(getItem(id));
    propBody.appendChild(card);
    refreshEmpties();
  }

  function reject(id) {
    if (state[id] !== 'pending') return;
    state[id] = 'rejected';
    rejected++;
    var oldCard = retroBody.querySelector('.retro-card[data-id="' + id + '"]');
    if (oldCard) {
      oldCard.classList.add('is-leaving');
      setTimeout(function () { if (oldCard.parentNode) oldCard.parentNode.removeChild(oldCard); }, 220);
    }
    renderRejected();
    refreshEmpties();
  }

  function startExperiment(id) {
    if (state[id] !== 'proposal') return;
    state[id] = 'experiment';
    var propCard = propBody.querySelector('.proposal-card[data-id="' + id + '"]');
    if (propCard) {
      propCard.classList.add('is-leaving');
      setTimeout(function () { if (propCard.parentNode) propCard.parentNode.removeChild(propCard); }, 220);
    }
    var lane = makeExpLane(getItem(id));
    expBody.appendChild(lane);
    var slot = makeVerdictSlot(getItem(id));
    verdBody.appendChild(slot);
    refreshEmpties();
    renderScrubber(); /* paint state for current position */
  }

  function refreshEmpties() {
    /* retros: count remaining pending */
    var pending = 0;
    for (var i = 0; i < SEED.length; i++) if (state[SEED[i].id] === 'pending') pending++;
    var countEl = root.querySelector('[data-count-retros]');
    if (countEl) countEl.textContent = pending + ' / week';

    var emptyProp = root.querySelector('[data-empty="proposals"]');
    if (emptyProp) emptyProp.style.display = propBody.querySelector('.proposal-card') ? 'none' : '';
    var emptyExp = root.querySelector('[data-empty="experiments"]');
    if (emptyExp) emptyExp.style.display = expBody.querySelector('.exp-lane') ? 'none' : '';
    var emptyVerd = root.querySelector('[data-empty="verdicts"]');
    if (emptyVerd) emptyVerd.style.display = verdBody.querySelector('.verdict-slot') ? 'none' : '';
  }

  function renderRejected() {
    root.setAttribute('data-rejected', String(rejected));
    var note = root.querySelector('.rejected-note');
    if (rejected === 0) {
      if (note && note.parentNode) note.parentNode.removeChild(note);
      return;
    }
    if (!note) {
      note = document.createElement('div');
      note.className = 'rejected-note';
      verdBody.appendChild(note);
    }
    note.innerHTML = 'rejected by user: <span class="n">' + rejected + '</span>';
  }

  /* --- scrubber --- */

  function setPosition(p) {
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    position = p;
    handle.style.left = (p * 100) + '%';
    fillBar.style.width = (p * 100) + '%';
    handle.setAttribute('aria-valuenow', String(Math.round(p * 90)));
    renderScrubber();
  }

  function dayLabel(p) {
    var d = Math.round(p * 90);
    if (d === 0) return 't+0 &middot; now';
    if (d < 7) return 't+' + d + ' &middot; early';
    if (d < 30) return 't+' + d + ' &middot; week ' + Math.ceil(d / 7);
    if (d < 90) return 't+' + d + ' &middot; tracking';
    return 't+90 &middot; verdict';
  }

  function renderScrubber() {
    readout.innerHTML = dayLabel(position);

    /* per-lane */
    var lanes = expBody.querySelectorAll('.exp-lane');
    lanes.forEach(function (lane) {
      var id = lane.getAttribute('data-id');
      var fill = lane.querySelector('.exp-fill');
      fill.style.width = (position * 100) + '%';

      var dots = lane.querySelectorAll('.exp-cp');
      var cpDays = [0, 7, 30, 90];
      dots.forEach(function (dot, i) {
        var cpFrac = cpDays[i] / 90;
        if (position >= cpFrac - 0.001) dot.classList.add('is-passed');
        else dot.classList.remove('is-passed');
      });

      var ticksEl = lane.querySelectorAll('.ev-tick');
      ticksEl.forEach(function (t) {
        var cp = +t.getAttribute('data-cp');
        if (position >= (cp / 90) - 0.001) t.classList.add('is-shown');
        else t.classList.remove('is-shown');
      });

      /* verdict pill at t+90 */
      var slot = verdBody.querySelector('.verdict-slot[data-id="' + id + '"]');
      if (slot) {
        var pill = slot.querySelector('.verdict-pill');
        var meta = slot.querySelector('.verdict-meta');
        if (position >= 1 - 0.001) {
          pill.classList.add('is-shown');
          if (meta) meta.style.opacity = '1';
        } else {
          pill.classList.remove('is-shown');
          if (meta) meta.style.opacity = '0';
        }
      }
    });
  }

  /* drag handle + tick clicks */
  function pointerToPosition(clientX) {
    var rect = rail.getBoundingClientRect();
    return (clientX - rect.left) / rect.width;
  }

  var dragging = false;
  handle.addEventListener('pointerdown', function (ev) {
    if (root.getAttribute('data-static') === '1') return;
    ev.preventDefault();
    dragging = true;
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    setPosition(pointerToPosition(ev.clientX));
  });
  handle.addEventListener('pointerup', function (ev) {
    dragging = false;
    handle.classList.remove('is-dragging');
    try { handle.releasePointerCapture(ev.pointerId); } catch (e) {}
  });
  handle.addEventListener('pointercancel', function () {
    dragging = false;
    handle.classList.remove('is-dragging');
  });

  rail.addEventListener('pointerdown', function (ev) {
    if (root.getAttribute('data-static') === '1') return;
    if (ev.target === handle) return;
    /* click anywhere on rail = jump there + start dragging */
    setPosition(pointerToPosition(ev.clientX));
    dragging = true;
    try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
    handle.classList.add('is-dragging');
  });

  ticks.forEach(function (t) {
    t.addEventListener('click', function (ev) {
      if (root.getAttribute('data-static') === '1') return;
      ev.stopPropagation();
      var d = +t.getAttribute('data-tick');
      setPosition(d / 90);
    });
  });

  /* keyboard on handle */
  handle.addEventListener('keydown', function (ev) {
    if (root.getAttribute('data-static') === '1') return;
    var step = 1 / 18; /* 5-day increments */
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp')   { ev.preventDefault(); setPosition(position + step); }
    if (ev.key === 'ArrowLeft'  || ev.key === 'ArrowDown') { ev.preventDefault(); setPosition(position - step); }
    if (ev.key === 'Home')                                 { ev.preventDefault(); setPosition(0); }
    if (ev.key === 'End')                                  { ev.preventDefault(); setPosition(1); }
  });

  /* --- card drag (retro -> proposal) --- */

  function attachDrag(card, id) {
    var startX = 0, startY = 0, currentX = 0, currentY = 0;
    var draggingCard = false;
    var moved = false;
    var pointerId = null;

    card.addEventListener('pointerdown', function (ev) {
      /* ignore presses on buttons within card */
      if (ev.target.closest('button')) return;
      if (state[id] !== 'pending') return;

      /* mobile: tap to cycle */
      if (isNarrow()) return;

      ev.preventDefault();
      draggingCard = true;
      moved = false;
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      currentX = 0; currentY = 0;
      card.setPointerCapture(pointerId);
      card.classList.add('is-dragging');
      card.style.transition = 'none';
    });

    card.addEventListener('pointermove', function (ev) {
      if (!draggingCard) return;
      currentX = ev.clientX - startX;
      currentY = ev.clientY - startY;
      if (Math.abs(currentX) > 3 || Math.abs(currentY) > 3) moved = true;
      card.style.transform = 'translate(' + currentX + 'px,' + currentY + 'px)';

      /* highlight drop target */
      var gridRect = grid.getBoundingClientRect();
      var x = ev.clientX;
      var leftEdge = gridRect.left;
      var width = gridRect.width;
      var colIdx = Math.floor(((x - leftEdge) / width) * 4);

      var bodies = [retroBody, propBody, expBody, verdBody];
      bodies.forEach(function (b, i) {
        if (i === 1 && colIdx === 1) b.classList.add('is-drop-target');
        else b.classList.remove('is-drop-target');
      });
    });

    function endDrag(ev) {
      if (!draggingCard) return;
      draggingCard = false;
      try { card.releasePointerCapture(pointerId); } catch (e) {}
      card.classList.remove('is-dragging');
      card.style.transition = '';

      var bodies = [retroBody, propBody, expBody, verdBody];
      bodies.forEach(function (b) { b.classList.remove('is-drop-target'); });

      if (!moved) {
        card.style.transform = '';
        return;
      }

      /* decide drop based on horizontal displacement */
      var gridRect = grid.getBoundingClientRect();
      var x = ev.clientX;
      var leftEdge = gridRect.left;
      var width = gridRect.width;
      var colIdx = Math.floor(((x - leftEdge) / width) * 4);

      if (colIdx === 1) {
        /* drop in proposals -> promote */
        card.style.transform = '';
        promote(id);
      } else if (colIdx < 0 || colIdx > 1 || currentY < -60) {
        /* off the board left/right past proposals/up -> reject */
        card.style.transform = '';
        reject(id);
      } else {
        /* back to retros -> snap back */
        card.style.transform = '';
      }
    }

    card.addEventListener('pointerup', endDrag);
    card.addEventListener('pointercancel', endDrag);

    /* mobile / keyboard: tap or Enter cycles state */
    card.addEventListener('click', function (ev) {
      if (ev.target.closest('button')) return;
      if (!isNarrow()) return;
      if (state[id] === 'pending') promote(id);
    });
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        if (ev.target.closest('button')) return;
        ev.preventDefault();
        if (state[id] === 'pending') promote(id);
      }
    });
  }

  /* --- reset / seed --- */

  function seed() {
    clearChildren(retroBody);
    clearChildren(propBody);
    clearChildren(expBody);
    clearChildren(verdBody);

    /* re-add empty placeholders */
    [['proposals', 'drag a retro here'], ['experiments', 'start an experiment'], ['verdicts', 'resolve at t+90']].forEach(function (pair) {
      var bodyEl = root.querySelector('[data-drop="' + pair[0] + '"]');
      var em = document.createElement('div');
      em.className = 'col-empty';
      em.setAttribute('data-empty', pair[0]);
      em.textContent = pair[1];
      bodyEl.appendChild(em);
    });

    state = {};
    rejected = 0;
    SEED.forEach(function (item) {
      state[item.id] = 'pending';
      retroBody.appendChild(makeRetroCard(item));
    });
    renderRejected();
    setPosition(0);
    refreshEmpties();
  }

  /* --- reduced-motion: render end state --- */

  function staticEnd() {
    root.setAttribute('data-static', '1');
    clearChildren(retroBody);
    clearChildren(propBody);
    clearChildren(expBody);
    clearChildren(verdBody);
    SEED.forEach(function (item) {
      state[item.id] = 'experiment';
      expBody.appendChild(makeExpLane(item));
      verdBody.appendChild(makeVerdictSlot(item));
    });
    /* note: retros drained */
    var drained = document.createElement('div');
    drained.className = 'col-empty';
    drained.textContent = 'drained this week';
    retroBody.appendChild(drained);

    var cap = document.createElement('div');
    cap.className = 'static-caption';
    cap.textContent = 'motion paused -- the end state of one week’s loop closing';
    scrubber.appendChild(cap);

    setPosition(1);
    refreshEmpties();
  }

  /* --- public hook for tests --- */
  window.__axPipelineSetPosition = function (t) { setPosition(t); };

  /* ============================================================
     autoplay sequence + user takeover
     ============================================================ */

  var autoPill   = root.querySelector('[data-auto-pill]');
  var autoLabel  = root.querySelector('[data-auto-label]');

  var pendingTimers = [];
  var pendingRafs   = [];
  var userTookOver  = false;
  var autoplayPlaying = false;
  var observerArmed = true;

  /* per-lane locked positions: so older lanes stay at their max while a new lane is animating */
  var laneStart = {}; /* id -> position at which the lane was started */

  function setAutoState(s) {
    if (!autoPill) return;
    autoPill.setAttribute('data-state', s);
    var text = 'auto &middot; idle';
    if (s === 'playing') text = 'auto &middot; playing';
    else if (s === 'manual') text = 'manual';
    else if (s === 'done')   text = 'auto &middot; done';
    else if (s === 'reduce') text = 'motion paused';
    autoLabel.innerHTML = text;
  }

  function clearPending() {
    for (var i = 0; i < pendingTimers.length; i++) clearTimeout(pendingTimers[i]);
    for (var j = 0; j < pendingRafs.length; j++) cancelAnimationFrame(pendingRafs[j]);
    pendingTimers = [];
    pendingRafs = [];
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      var id = setTimeout(function () {
        var i = pendingTimers.indexOf(id);
        if (i >= 0) pendingTimers.splice(i, 1);
        resolve();
      }, ms);
      pendingTimers.push(id);
    });
  }

  function tween(from, to, durMs, onStep) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      function frame(now) {
        if (userTookOver) { resolve(); return; }
        var t = (now - t0) / durMs;
        if (t >= 1) t = 1;
        /* easeInOutQuad */
        var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        var val = from + (to - from) * eased;
        onStep(val);
        if (t < 1) {
          var rid = requestAnimationFrame(frame);
          pendingRafs.push(rid);
        } else {
          resolve();
        }
      }
      var rid0 = requestAnimationFrame(frame);
      pendingRafs.push(rid0);
    });
  }

  /* Override renderScrubber-lane behavior: clamp older lanes to >=laneStart-derived max
     We do this by post-processing after the base renderer.
     Simpler: each lane locks once it has hit position=1. */

  function lockedLanes() {
    /* return Set of lane ids that have ever hit position=1 */
    var set = {};
    var lanes = expBody.querySelectorAll('.exp-lane');
    lanes.forEach(function (lane) {
      var id = lane.getAttribute('data-id');
      var fillPct = parseFloat(lane.querySelector('.exp-fill').style.width) || 0;
      if (fillPct >= 99.5) set[id] = true;
    });
    return set;
  }

  /* Hook into renderScrubber: after base rendering, force locked lanes back to full. */
  var _origRenderScrubber = renderScrubber;
  renderScrubber = function () {
    _origRenderScrubber();
    var lanes = expBody.querySelectorAll('.exp-lane');
    lanes.forEach(function (lane) {
      var id = lane.getAttribute('data-id');
      if (laneStart[id] === 'locked') {
        /* force this lane to full + show all ticks + pin verdict */
        lane.querySelector('.exp-fill').style.width = '100%';
        lane.querySelectorAll('.exp-cp').forEach(function (d) { d.classList.add('is-passed'); });
        lane.querySelectorAll('.ev-tick').forEach(function (t) { t.classList.add('is-shown'); });
        var slot = verdBody.querySelector('.verdict-slot[data-id="' + id + '"]');
        if (slot) {
          slot.querySelector('.verdict-pill').classList.add('is-shown');
          var m = slot.querySelector('.verdict-meta');
          if (m) m.style.opacity = '1';
        }
      }
    });
  };

  function takeover() {
    if (userTookOver) return;
    userTookOver = true;
    autoplayPlaying = false;
    clearPending();
    setAutoState('manual');
  }

  /* takeover listeners - scoped to .fig-pipeline */
  function armTakeoverListeners() {
    root.addEventListener('pointerdown', function (ev) {
      /* don't count reset clicks - reset handles its own restart */
      if (ev.target.closest('[data-pipeline-reset]')) return;
      if (userTookOver) return;
      /* take over if autoplay is playing OR a pre-roll/intersection timer is pending */
      if (!autoplayPlaying && pendingTimers.length === 0) return;
      takeover();
    }, true);

    handle.addEventListener('keydown', function () {
      if (autoplayPlaying) takeover();
    }, true);

    if (autoPill) {
      autoPill.addEventListener('click', function () {
        if (autoplayPlaying) takeover();
      });
    }
  }

  /* ---- the sequence ---- */

  async function playRetro(item, isLast) {
    if (userTookOver) return;

    /* 1. highlight retro card */
    var card = retroBody.querySelector('.retro-card[data-id="' + item.id + '"]');
    if (card) {
      card.classList.add('is-pointing');
      await wait(600);
      card.classList.remove('is-pointing');
    }
    if (userTookOver) return;

    /* 2. animate card across to proposals - visual fly.
       Take the card out of flow first so the source column does not reflow
       and the eye does not chase the next card up. */
    if (card) {
      var cardRect = card.getBoundingClientRect();
      var parentRect = card.parentNode.getBoundingClientRect();
      var propRect = propBody.getBoundingClientRect();
      /* keep visual position via absolute coords relative to parent */
      var topInParent  = cardRect.top  - parentRect.top;
      var leftInParent = cardRect.left - parentRect.left;
      var w = cardRect.width;
      card.style.position = 'absolute';
      card.style.top    = topInParent  + 'px';
      card.style.left   = leftInParent + 'px';
      card.style.width  = w + 'px';
      card.style.margin = '0';
      card.style.zIndex = '5';

      /* destination: roughly the top-left of the proposals body */
      var dx = (propRect.left - cardRect.left) + 18;
      card.classList.add('is-flying');
      /* force a frame so the absolute positioning is committed before transforming */
      await new Promise(function (r) { var rid = requestAnimationFrame(function () { r(); }); pendingRafs.push(rid); });
      card.style.transform = 'translate(' + dx + 'px, 0)';
      card.style.opacity = '0';
      await wait(380);
      /* remove the source card. promote() will rebuild the proposal in the destination column. */
      if (card.parentNode) card.parentNode.removeChild(card);
    }
    if (userTookOver) return;

    /* 3. proposal card materializes (400ms), then HOLD so the reader
          can actually read the proposal text, then pulse + start experiment. */
    promote(item.id);
    /* fade-in: the proposal card uses the same .is-leaving transition class
       removal pattern; promote() simply appends. Give the browser 400ms
       to render + let the eye lock on. */
    await wait(400);
    if (userTookOver) return;

    /* HOLD: ~1600ms of complete stillness. This is the "you decide" beat. */
    await wait(1600);
    if (userTookOver) return;

    /* button-pulse fires, then auto-clicks start experiment ~350ms in
       so the pulse reads as the cause of the lane spawning. */
    var propCard = propBody.querySelector('.proposal-card[data-id="' + item.id + '"]');
    if (propCard) {
      var btn = propCard.querySelector('.start-exp');
      if (btn) {
        btn.classList.add('is-pulse');
        var pulseClear = setTimeout(function () { if (btn) btn.classList.remove('is-pulse'); }, 700);
        pendingTimers.push(pulseClear);
      }
    }
    await wait(350);
    if (userTookOver) return;

    /* 4. start experiment */
    startExperiment(item.id);
    await wait(300);
    if (userTookOver) return;

    /* 5. scrubber t+0 -> t+90 over 3500ms */
    laneStart[item.id] = 'active';
    /* rewind scrubber to 0 for this lane; older lanes are already 'locked' so they stay full */
    setPosition(0);
    await tween(0, 1, 3500, function (v) { setPosition(v); });
    if (userTookOver) return;

    /* lock this lane */
    laneStart[item.id] = 'locked';
    renderScrubber();

    /* 6. hold */
    await wait(isLast ? 200 : 800);
  }

  async function runSequence() {
    if (userTookOver || reduce) return;
    autoplayPlaying = true;
    setAutoState('playing');

    for (var i = 0; i < SEED.length; i++) {
      if (userTookOver) return;
      await playRetro(SEED[i], i === SEED.length - 1);
    }

    if (userTookOver) return;
    /* ensure all lanes pinned + scrubber at t+90 */
    setPosition(1);
    SEED.forEach(function (it) { laneStart[it.id] = 'locked'; });
    renderScrubber();
    autoplayPlaying = false;
    setAutoState('done');
  }

  function startAutoplay() {
    if (userTookOver) return;
    if (reduce) { setAutoState('reduce'); return; }
    if (autoplayPlaying) return;
    /* reset internal lane locks */
    laneStart = {};
    runSequence();
  }

  function stopAutoplay() { takeover(); }

  window.__axPipelineAutoplay = { start: startAutoplay, stop: stopAutoplay };

  /* intersection observer arms autoplay once when the figure enters view */
  function armObserver() {
    if (reduce) { setAutoState('reduce'); return; }
    if (!('IntersectionObserver' in window)) {
      /* fallback: just start after a beat */
      var t = setTimeout(function () {
        if (!userTookOver && !autoplayPlaying) startAutoplay();
      }, 1500);
      pendingTimers.push(t);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && observerArmed && !userTookOver && !autoplayPlaying) {
          observerArmed = false;
          io.disconnect();
          var t = setTimeout(function () {
            if (!userTookOver && !autoplayPlaying) startAutoplay();
          }, 1500);
          pendingTimers.push(t);
        }
      });
    }, { threshold: 0.4 });
    io.observe(root);
  }

  /* --- listeners --- */

  resetBtn.addEventListener('click', function () {
    if (root.getAttribute('data-static') === '1') {
      root.removeAttribute('data-static');
      var cap = scrubber.querySelector('.static-caption');
      if (cap && cap.parentNode) cap.parentNode.removeChild(cap);
    }
    /* cancel anything in flight from a prior autoplay */
    clearPending();
    autoplayPlaying = false;
    userTookOver = false;
    laneStart = {};
    seed();
    setAutoState('idle');
    /* relaunch autoplay after a beat */
    if (!reduce) {
      var t = setTimeout(function () {
        if (!userTookOver && !autoplayPlaying) startAutoplay();
      }, 1500);
      pendingTimers.push(t);
    } else {
      setAutoState('reduce');
    }
  });

  armTakeoverListeners();

  /* boot */
  if (reduce) {
    staticEnd();
    setAutoState('reduce');
  } else {
    seed();
    setAutoState('idle');
    armObserver();
  }
})();
