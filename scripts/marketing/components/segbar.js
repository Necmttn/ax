/* Segmented-bar builder - studio Segbar grammar, no React, classic script.
 *
 * Markup:  <div class="seg" data-total="26" data-on="16"
 *               data-color="var(--amber)" data-grad="1"></div>
 *
 *   data-total  number of cells
 *   data-on     leading cells lit
 *   data-color  CSS color for lit cells (var() ok)
 *   data-grad   "1" → lit cells ramp dark→color (nullframe heat bar)
 *
 * Pure DOM, deterministic - renders identically headless, so it survives the
 * marketing render harness. Exposes window.buildSegbars(root?).
 */
(function () {
  function buildSegbars(root) {
    root = root || document;
    root.querySelectorAll(".seg").forEach(function (el) {
      if (el.dataset.built === "1") return;
      var total = +el.dataset.total || 0;
      var on = +el.dataset.on || 0;
      var color = el.dataset.color || "var(--green)";
      var grad = el.dataset.grad === "1";
      for (var i = 0; i < total; i++) {
        var c = document.createElement("i");
        if (i < on) {
          if (grad) {
            var pct = Math.round(34 + 66 * (on <= 1 ? 1 : i / (on - 1)));
            c.style.background = "color-mix(in srgb, " + color + " " + pct + "%, var(--cell))";
          } else {
            c.style.background = color;
          }
        }
        el.appendChild(c);
      }
      el.dataset.built = "1";
    });
  }
  window.buildSegbars = buildSegbars;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { buildSegbars(); });
  } else {
    buildSegbars();
  }
})();
