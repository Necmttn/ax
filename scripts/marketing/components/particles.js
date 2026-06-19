/* Deterministic particle data-field backdrop - classic script.
 *
 * Draws drifting nodes + proximity links into <canvas id="net">. Node paths are
 * periodic (Lissajous on harmonics of a base period) so the whole field LOOPS
 * SEAMLESSLY: frame at t == frame at t+period.
 *
 * Render contract (shared by every animated marketing backdrop):
 *   - honor window.__t (ms) as the clock when present (deterministic render);
 *     fall back to real-time rAF otherwise (live browser preview).
 *   - expose window.__draw() so the render harness can redraw one frame after
 *     setting window.__t.
 *
 * Tune via data-attrs on the canvas:
 *   <canvas id="net" data-period="6" data-count="72" data-seed="1337"
 *           data-amber="0.16"></canvas>
 */
(function () {
  var cv = document.getElementById("net");
  if (!cv) return;
  var ctx = cv.getContext("2d");
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var W, H;
  function size() { W = cv.width = cv.clientWidth * dpr; H = cv.height = cv.clientHeight * dpr; }
  size(); window.addEventListener("resize", size);

  function rng(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var PERIOD = +cv.dataset.period || 6;          // seconds - seamless loop length
  var N = +cv.dataset.count || 72;
  var amberRate = cv.dataset.amber != null ? +cv.dataset.amber : 0.16;
  var D = 0.16;                                  // link distance (norm to min dim)
  var r = rng(+cv.dataset.seed || 1337);
  var nodes = [];
  for (var i = 0; i < N; i++) {
    nodes.push({
      bx: r(), by: r(),
      ax: 0.02 + r() * 0.05, ay: 0.02 + r() * 0.05,
      kx: 1 + Math.floor(r() * 3), ky: 1 + Math.floor(r() * 3),
      px: r() * 6.283, py: r() * 6.283,
      amber: r() < amberRate,
    });
  }

  function draw() {
    var t = (window.__t != null ? window.__t : performance.now()) / 1000;
    ctx.clearRect(0, 0, W, H);
    var m = Math.min(W, H), w2 = 2 * Math.PI / PERIOD;
    var pts = nodes.map(function (n) {
      return {
        x: (n.bx + n.ax * Math.sin(w2 * n.kx * t + n.px)) * W,
        y: (n.by + n.ay * Math.cos(w2 * n.ky * t + n.py)) * H,
        amber: n.amber,
      };
    });
    for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++) {
      var dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = Math.hypot(dx, dy) / m;
      if (d < D) {
        ctx.strokeStyle = "rgba(95,208,127," + (1 - d / D) * 0.22 + ")";
        ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
      }
    }
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.7 * dpr, 0, 6.283);
      ctx.fillStyle = p.amber ? "rgba(255,122,60,.9)" : "rgba(120,220,150,.85)";
      ctx.fill();
    }
    if (window.__t == null) requestAnimationFrame(draw);
  }

  window.__draw = draw;
  if (window.__t != null) draw(); else requestAnimationFrame(draw);
})();
