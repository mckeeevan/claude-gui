// The inset map: a small copy of the whole structure map with a box for the part
// on screen. It shows only when the map is bigger than its space (Full size, or a
// phone), so the person always knows where they are. Owns no layout logic.
import { select, easeCubicInOut } from "d3";

/**
 * Which part of the map is on screen, in layout units.
 *
 * map      { left, top, width, height } of the drawn map svg, in page pixels
 * visible  { left, top, right, bottom } of the area the person can see, in page pixels
 *          (the scroll box, clipped to the window)
 * viewBox  [x, y, w, h] of the map svg
 * Returns { x, y, width, height, full }, where full is true when the whole map is on screen.
 * Assumes the svg is drawn at one scale on both axes, as the map is when it does not fit.
 */
export function viewportOf(map, visible, viewBox) {
  const [vx, vy, vw, vh] = viewBox;
  if (!map.width || !map.height || !vw || !vh) return { x: vx, y: vy, width: vw, height: vh, full: true };
  const k = map.width / vw;
  const x0 = Math.max(0, visible.left - map.left);
  const y0 = Math.max(0, visible.top - map.top);
  const x1 = Math.min(map.width, visible.right - map.left);
  const y1 = Math.min(map.height, visible.bottom - map.top);
  const slack = 2; // px; rounding in the browser should not count as "partly hidden"
  const full = x0 <= slack && y0 <= slack && x1 >= map.width - slack && y1 >= map.height - slack;
  return { x: vx + x0 / k, y: vy + y0 / k, width: Math.max(0, x1 - x0) / k, height: Math.max(0, y1 - y0) / k, full };
}

/**
 * The scroll offsets that put a layout point in the middle of the visible area.
 * view is the current viewportOf result; k the map's pixels per layout unit.
 * Returns { dx, dy } in pixels to scroll by.
 */
export function scrollToCenter(point, view, k) {
  return { dx: (point.x - (view.x + view.width / 2)) * k, dy: (point.y - (view.y + view.height / 2)) * k };
}

/**
 * Usage: minimap().onJump(fn)(select(el).datum({ layout, view }))
 *
 * layout is the structure layout; view a viewportOf result (or null to hide).
 * Config: width (px of the inset's longer side), duration (ms; 0 for none),
 * onJump({ x, y }) with the layout point that was clicked.
 */
export function minimap() {
  let size = 168;
  let duration = 500;
  let onJump = () => {};

  const tr = (sel) => (duration > 0 ? sel.transition("mini").duration(duration).ease(easeCubicInOut) : sel);

  function chart(selection) {
    selection.each(function ({ layout, view }) {
      const host = select(this);
      const on = !!(layout && layout.width && view && !view.full);
      host.classed("on", on);
      if (!layout || !layout.width) return;
      // The inset keeps the map's own shape, with its longer side `size` px.
      const k = size / Math.max(layout.width, layout.height);
      const w = layout.width * k;
      const h = layout.height * k;
      const svg = host.selectAll("svg").data([null]).join((enter) => {
        const s = enter.append("svg").attr("class", "mini").attr("role", "img").attr("aria-label", "Whole map, with the part on screen outlined");
        s.append("g").attr("class", "boxes");
        s.append("rect").attr("class", "view");
        return s;
      });
      tr(svg).attr("width", w).attr("height", h);
      svg.attr("viewBox", `0 0 ${layout.width} ${layout.height}`);
      // Keyed by part id, so boxes glide with the map instead of being redrawn.
      const boxes = [
        ...layout.nodes.map((n) => ({ ...n, kind: n.container ? "group" : `leaf st-${n.status}` })),
        ...(layout.bullpen && layout.bullpen.count ? [{ id: "\u0000pen", ...layout.bullpen, kind: "pen" }] : []),
      ];
      svg.select("g.boxes").selectAll("rect")
        .data(boxes, (d) => d.id)
        .join((enter) => enter.append("rect").attr("x", (d) => d.x + d.width / 2).attr("y", (d) => d.y + d.height / 2).attr("width", 0).attr("height", 0))
        .attr("class", (d) => d.kind)
        .call((s) => tr(s).attr("x", (d) => d.x).attr("y", (d) => d.y).attr("width", (d) => d.width).attr("height", (d) => d.height));
      if (view) {
        // The box follows scrolling directly; a transition here would lag behind the hand.
        svg.select("rect.view")
          .attr("x", Math.max(0, view.x)).attr("y", Math.max(0, view.y))
          .attr("width", Math.min(layout.width, view.width)).attr("height", Math.min(layout.height, view.height));
      }
      svg.on("click.mini", (event) => {
        const r = event.currentTarget.getBoundingClientRect();
        if (!r.width) return;
        onJump({ x: ((event.clientX - r.left) / r.width) * layout.width, y: ((event.clientY - r.top) / r.height) * layout.height });
      });
    });
  }

  chart.size = function (v) { if (!arguments.length) return size; size = v; return chart; };
  chart.duration = function (v) { if (!arguments.length) return duration; duration = v; return chart; };
  chart.onJump = function (v) { if (!arguments.length) return onJump; onJump = v; return chart; };
  /** Removes the click listener. */
  chart.destroy = function (selection) { selection.selectAll("svg.mini").on(".mini", null).remove(); return chart; };
  return chart;
}
