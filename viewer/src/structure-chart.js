// The structure map: parts of the app as nested boxes, dependencies as arrows
// between them. Draws the output of `layoutStructure`; owns no layout logic.
import { select, line, curveBasis, scaleSqrt, max, interpolateArray, interpolateRgbBasis, easeCubicOut, easeCubicInOut, easeCubicIn } from "d3";
import { STATUS_LABEL, resamplePoints } from "./model.js";

let uid = 0;
const curve = line().curve(curveBasis);
const N_POINTS = 24; // edge routes are resampled to this many points so any two can morph
// Coverage ramp for the tests lens: pale teal at 0% to deep navy at 100% (sequential, one direction).
export const coverageColor = interpolateRgbBasis(["#DCEFEC", "#8CCFC9", "#2A9D97", "#12496E"]);
const darkFill = (pct) => pct != null && pct >= 0.55; // text flips to white on the deep end
const pctText = (p) => `${Math.round(p * 100)}%`;

/**
 * Usage: structureMap().onToggle(fn)(select(el).datum(layout))
 *
 * Config (getter-setters): duration (ms; 0 for none), onToggle(id), onHover(id|null),
 * highlight ({ parts, agents } Sets kept at full strength, or null),
 * agentInfo(id) -> { name, initials, status }, onAgentHover(id|null, element),
 * onAgentClick(id, element).
 */
export function structureMap() {
  let duration = 700;
  let onToggle = () => {};
  let onHover = () => {};
  let highlight = null;
  // The page knows the agents; the chart asks it for a name, initials and status by id.
  let agentInfo = (agentId) => ({ id: agentId, name: agentId, initials: String(agentId).slice(0, 2), status: "working" });
  let onAgentHover = () => {};
  let onAgentClick = () => {};
  let lens = "work";
  let coverageSource = null; // the report file the coverage came from, for hover text // "work": status colours; "tests": coverage shading, untested hatched
  const id = `map-${++uid}`;
  // Boxes from the previous draw, by id, so a part that splits, merges or turns
  // into a group can grow out of (or shrink into) what was on screen before.
  let prev = new Map();

  const tr = (sel, ease = easeCubicInOut, scale = 1) =>
    duration > 0 ? sel.transition("map").duration(duration * scale).ease(ease) : sel;

  // A box is placed with a transform that scales about its own centre, so it can grow from nothing.
  const place = (d, k = 1) => `translate(${d.x + d.width / 2},${d.y + d.height / 2}) scale(${k}) translate(${-d.width / 2},${-d.height / 2})`;

  // Where a new box starts: the box it was split from, the same id drawn the
  // other way (a part that just gained children), or its parent when the
  // parent was a single box until now. Null means it grows from nothing.
  const originOf = (d) => {
    for (const f of d.from || []) if (prev.has(f)) return prev.get(f);
    const same = prev.get(d.id);
    if (same && same.container !== d.container) return same;
    const parent = d.parentId != null ? prev.get(d.parentId) : null;
    return parent && !parent.container ? parent : null;
  };
  // Where a leaving box goes: the box that replaced it (same id, other kind),
  // a part that names it in `from`, or its parent when the parent folded.
  const destinationOf = (d, next) => {
    const same = next.get(d.id);
    if (same && same.container !== d.container) return same;
    for (const n of next.values()) if ((n.from || []).includes(d.id)) return n;
    const parent = d.parentId != null ? next.get(d.parentId) : null;
    return parent && !parent.container ? parent : null;
  };
  // Enter from an origin box (full size, faint) or from a point (scale 0).
  const enterFrom = (g, rectSel) => g.each(function (d) {
    const o = originOf(d);
    const el = select(this);
    if (o && duration > 0) {
      el.attr("transform", place(o)).attr("opacity", 0.35);
      el.select(rectSel).attr("width", o.width).attr("height", o.height);
    } else el.attr("transform", place(d, 0));
  });
  const exitTo = (exit, next, rectSel) => {
    exit.classed("is-exiting", true);
    if (duration <= 0) return exit.remove();
    return exit.each(function (d) {
      const t = destinationOf(d, next);
      const el = select(this);
      const go = el.transition("map").duration(duration * (t ? 1 : 0.6)).ease(t ? easeCubicInOut : easeCubicIn);
      if (t) {
        go.attr("transform", place(t)).attr("opacity", 0);
        el.select(rectSel).transition("map").duration(duration).ease(easeCubicInOut).attr("width", t.width).attr("height", t.height);
      } else go.attr("transform", place(d, 0));
      go.remove();
    });
  };

  function applyHighlight(svg) {
    const parts = highlight?.parts ?? highlight; // a bare Set of part ids still works
    const agents = highlight?.agents ?? null;
    svg.selectAll("g.part").classed("dim", (d) => parts != null && !parts.has(d.id)).classed("lit", (d) => parts != null && parts.has(d.id));
    svg.selectAll("path.dep").classed("dim", (d) => parts != null && !(parts.has(d.source) && parts.has(d.target)));
    svg.selectAll("g.token").classed("dim", (d) => highlight != null && !(agents ?? new Set()).has(d.id)).classed("lit", (d) => agents != null && agents.has(d.id));
  }

  function chart(selection) {
    selection.each(function (layout) {
      const svg = select(this).selectAll("svg.map").data([null]).join((enter) => {
        // role="group", not "img": parts are keyboard buttons, and an img role would hide them from screen readers.
        const s = enter.append("svg").attr("class", "map").attr("role", "group").attr("aria-labelledby", `${id}-title ${id}-desc`);
        s.append("title").attr("id", `${id}-title`).text("Structure of the app");
        s.append("desc").attr("id", `${id}-desc`);
        const defs = s.append("defs");
        for (const kind of ["hot", "cold"]) {
          defs.append("marker").attr("id", `${id}-arrow-${kind}`).attr("class", `arrow ${kind}`)
            .attr("viewBox", "0 0 10 10").attr("refX", 9).attr("refY", 5)
            .attr("markerWidth", 7).attr("markerHeight", 7).attr("markerUnits", "userSpaceOnUse").attr("orient", "auto")
            .append("path").attr("d", "M0,0L10,5L0,10z");
        }
        // Hatching for parts with no tests at all, so "untested" never reads as a low score.
        defs.append("pattern").attr("id", `${id}-hatch`).attr("width", 6).attr("height", 6)
          .attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)")
          .call((p) => p.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#FFFFFF"))
          .append("line").attr("y1", 0).attr("y2", 6).attr("stroke", "#DCDBD6").attr("stroke-width", 2.5);
        s.append("g").attr("class", "containers");
        // The done shelf sits under the boxes it holds, starting as a point so it grows in.
        const shelf = s.append("g").attr("class", "shelf empty").attr("transform", "translate(0,0) scale(0)");
        shelf.append("rect").attr("class", "shelf-bg").attr("width", 0).attr("height", 0);
        shelf.append("text").attr("class", "shelf-title").attr("x", 12).attr("y", 17).text("Done");
        shelf.append("text").attr("class", "shelf-count").attr("y", 17).attr("text-anchor", "end");
        s.append("g").attr("class", "deps");
        s.append("g").attr("class", "leaves");
        s.append("g").attr("class", "tokens");
        return s;
      });

      svg.classed("lens-tests", lens === "tests");
      const pad = 6;
      svg.attr("viewBox", `${-pad} ${-pad - 14} ${layout.width + pad * 2} ${layout.height + pad * 2 + 14}`)
        .attr("width", layout.width + pad * 2)
        .attr("height", layout.height + pad * 2 + 14);

      const leaves = layout.nodes.filter((n) => !n.container);
      const active = leaves.filter((n) => n.status === "active").map((n) => n.name);
      svg.select("desc").text(
        `${leaves.length} parts and groups shown, with ${layout.edges.length} dependencies.` +
        (active.length ? ` Working on ${active.join(", ")}.` : " Nothing in progress."),
      );

      const next = new Map(layout.nodes.map((n) => [n.id, n]));

      // ---- containers ------------------------------------------------------
      const containers = svg.select("g.containers").selectAll("g.part.group:not(.is-exiting)")
        .data(layout.nodes.filter((n) => n.container), (d) => d.id) // keyed: boxes keep their element as the layout moves
        .join(
          (enter) => {
            const g = enter.append("g").attr("class", "part group");
            g.append("rect").attr("class", "frame");
            const head = g.append("g").attr("class", "head");
            head.append("text").attr("class", "brace").attr("x", 12).attr("y", 21).text("{ }");
            head.append("text").attr("class", "name").attr("x", 34).attr("y", 21);
            head.append("text").attr("class", "roll").attr("y", 21).attr("text-anchor", "end");
            head.append("text").attr("class", "fails").attr("y", 21).attr("text-anchor", "end");
            g.append("title");
            return g.call(enterFrom, "rect.frame");
          },
          (update) => update,
          (exit) => exitTo(exit, next, "rect.frame"),
        );
      containers
        .attr("class", (d) => `part group depth-${Math.min(d.depth, 3)}${d.containsActive ? " has-active" : ""}${d.onFocusPath ? " on-focus" : ""}${d.failing ? " has-failing" : ""}${d.status === "idea" ? " st-idea" : ""}`)
        .attr("tabindex", 0)
        .attr("role", "button")
        .attr("aria-expanded", "true")
        .attr("aria-label", (d) => `${d.name}, group, ${d.rollup.done} of ${d.rollup.total} done. Press Enter to fold.`)
        .call(bindEvents)
        .call((s) => tr(s).attr("transform", (d) => place(d)).attr("opacity", 1));
      containers.select("rect.frame").call((s) => tr(s).attr("width", (d) => d.width).attr("height", (d) => d.height));
      containers.select("text.name").text((d) => d.name);
      containers.select("text.roll").text((d) => (lens === "tests" ? (d.coverage?.band === "exempt" ? "no tests needed" : d.coverage?.pct != null ? pctText(d.coverage.pct) : d.coverage?.tested ? "tested" : "no tests") : `${d.rollup.done}/${d.rollup.total}`)).call((s) => tr(s).attr("x", (d) => d.width - 12));
      // Failure count sits left of the rollup, clear of any agent tokens in the header.
      containers.select("text.fails").text((d) => (d.failing ? `✕ ${d.failing} failing` : ""))
        .call((s) => tr(s).attr("x", (d) => d.width - 52));
      containers.select("title").text((d) => titleOf(d));

      // ---- dependency arrows ----------------------------------------------
      const weights = layout.edges.map((e) => e.weight);
      // Square-root so area-like thickness tracks weight, clamped so a heavy edge cannot swamp the boxes.
      const width = scaleSqrt().domain([1, Math.max(2, max(weights) ?? 2)]).range([1.1, 5]).clamp(true);
      svg.select("g.deps").selectAll("path.dep:not(.is-exiting)")
        .data(layout.edges, (d) => d.id)
        .join(
          (enter) => enter.append("path").attr("class", "dep")
            .each(function (d) { this.__pts = resamplePoints([d.points[0]], N_POINTS); }), // grows out of its source end
          (update) => update,
          (exit) => {
            exit.classed("is-exiting", true);
            if (duration <= 0) return exit.remove(); // attrTween exists only on transitions
            return exit.call((s) => tr(s, easeCubicIn, 0.6).attrTween("d", function () {
              const from = this.__pts || [];
              const to = from.map(() => from[from.length - 1] || [0, 0]); // retracts into its target
              const i = interpolateArray(from, to);
              return (t) => curve((this.__pts = i(t)));
            }).remove());
          },
        )
        .attr("class", (d) => `dep ${d.hot ? "hot" : "cold"} kind-${d.kind}`)
        .attr("stroke-width", (d) => width(d.weight))
        .attr("marker-end", (d) => `url(#${id}-arrow-${d.hot ? "hot" : "cold"})`)
        .call((s) => {
          const target = (d) => resamplePoints(d.points, N_POINTS);
          if (duration > 0) {
            s.transition("map").duration(duration).ease(easeCubicInOut).attrTween("d", function (d) {
              // Start from the route on screen, so an interrupted move continues instead of jumping.
              const i = interpolateArray(this.__pts || target(d), target(d));
              return (t) => curve((this.__pts = i(t)));
            });
          } else s.attr("d", function (d) { this.__pts = target(d); return curve(this.__pts); });
        });

      // ---- leaves ----------------------------------------------------------
      const leafSel = svg.select("g.leaves").selectAll("g.part.leaf:not(.is-exiting)")
        .data(leaves, (d) => d.id)
        .join(
          (enter) => {
            const g = enter.append("g").attr("class", "part leaf");
            g.append("rect").attr("class", "pulse");
            g.append("rect").attr("class", "box");
            g.append("rect").attr("class", "heat").attr("height", 3).attr("width", 0);
            g.append("text").attr("class", "name").attr("x", 12).attr("y", 22);
            g.append("text").attr("class", "sub").attr("x", 12).attr("y", 39);
            g.append("g").attr("class", "now").attr("opacity", 0)
              .call((n) => n.append("rect").attr("class", "ring").attr("x", -5).attr("y", -5));
            const badge = g.append("g").attr("class", "fail-badge").attr("transform", "scale(0)");
            badge.append("rect").attr("x", -15).attr("y", -9).attr("width", 30).attr("height", 18).attr("rx", 9);
            badge.append("text").attr("text-anchor", "middle").attr("dy", "0.35em");
            g.append("title");
            return g.call(enterFrom, "rect.box");
          },
          (update) => update,
          (exit) => exitTo(exit, next, "rect.box"),
        );
      leafSel
        .attr("class", (d) => `part leaf st-${d.status}${d.compact ? " compact" : ""}${d.shelved ? " shelved" : ""}${d.folded ? " folded" : ""}${d.focus ? " focus" : ""}${d.failing ? " failing" : ""} cov-${d.coverage?.band ?? "untested"}${lens === "tests" && darkFill(d.coverage?.pct) ? " on-dark" : ""}`)
        .attr("tabindex", (d) => (d.hasChildren ? 0 : -1))
        .attr("role", (d) => (d.hasChildren ? "button" : null))
        .attr("aria-expanded", (d) => (d.hasChildren ? "false" : null))
        .attr("aria-label", (d) => leafLabel(d))
        .call(bindEvents)
        .call((s) => tr(s, easeCubicOut).attr("transform", (d) => place(d)).attr("opacity", 1));
      leafSel.select("rect.box").call((s) => tr(s).attr("width", (d) => d.width).attr("height", (d) => d.height))
        .style("fill", (d) => (lens !== "tests" ? null : d.coverage?.band === "exempt" ? "#F4F1EA" : d.coverage?.pct != null ? coverageColor(d.coverage.pct) : d.coverage?.tested ? "#FFFFFF" : `url(#${id}-hatch)`));
      leafSel.select("rect.pulse").attr("width", (d) => d.width).attr("height", (d) => d.height);
      leafSel.select("rect.heat").call((s) => tr(s)
        .attr("y", (d) => d.height - 3)
        .attr("width", (d) => (d.heat > 0.02 ? Math.max(6, d.width * Math.min(1, d.heat)) : 0)));
      // A chip is one line: the name slides to the middle while the status line fades out under it.
      leafSel.select("text.name").text((d) => d.name).call((s) => tr(s).attr("y", (d) => (d.compact ? d.height / 2 + 4.5 : 22)));
      leafSel.select("text.sub").text((d) => subLine(d)).call((s) => tr(s).attr("y", (d) => (d.compact ? d.height / 2 + 4.5 : 39)).attr("opacity", (d) => (d.compact ? 0 : 1)));
      leafSel.select("g.now").call((s) => tr(s).attr("opacity", (d) => (d.focus ? 1 : 0)))
        .select("rect.ring").attr("width", (d) => d.width + 10).attr("height", (d) => d.height + 10);
      // The badge grows from its corner, so a new failure is noticed without a flash.
      leafSel.select("g.fail-badge")
        .call((s) => tr(s, easeCubicOut).attr("transform", (d) => `translate(${d.width - 6},4) scale(${d.failing ? 1 : 0})`))
        .select("text").text((d) => (d.failing ? `✕${d.failing > 1 ? d.failing : ""}` : ""));
      leafSel.select("title").text((d) => titleOf(d));

      // ---- done shelf and agent tokens ----------------------------------
      // The shelf glides to its side and resizes; with nothing finished it shrinks into its corner.
      const sh = layout.shelf;
      const shelfG = svg.select("g.shelf");
      if (sh && shelfG.classed("empty")) shelfG.attr("transform", `translate(${sh.x},${sh.y}) scale(0)`); // grows in where it will sit
      shelfG.classed("empty", !sh);
      if (sh) shelfG.select("text.shelf-count").text(sh.count).call((s) => tr(s).attr("x", sh.width - 12));
      tr(shelfG).attr("transform", sh ? `translate(${sh.x},${sh.y}) scale(1)` : `${(shelfG.attr("transform") || "").replace(/scale\([^)]*\)/, "")} scale(0)`);
      if (sh) tr(shelfG.select("rect.shelf-bg")).attr("width", sh.width).attr("height", sh.height);
      svg.select("g.tokens").selectAll("g.token:not(.is-exiting)")
        .data(layout.tokens, (t) => t.id) // keyed by agent, so a token glides from part to part instead of being redrawn
        .join(
          (enter) => {
            const g = enter.append("g").attr("class", "token").attr("tabindex", 0)
              .attr("transform", (t) => `translate(${t.x},${t.y}) scale(0)`);
            g.append("circle").attr("class", "halo").attr("r", 13);
            g.append("circle").attr("class", "disc").attr("r", 13);
            g.append("text").attr("class", "ini").attr("dy", "0.35em");
            return g;
          },
          (update) => update,
          (exit) => exit.classed("is-exiting", true).call((s) => tr(s, easeCubicIn, 0.6).attr("transform", function () {
            return `${this.getAttribute("transform").replace(/scale\([^)]*\)/, "")} scale(0)`;
          }).remove()),
        )
        .attr("class", (t) => `token status-${agentInfo(t.id)?.status ?? "idle"}${t.parked ? " parked" : ""}`)
        .attr("role", "button")
        .attr("aria-label", (t) => {
          const a = agentInfo(t.id);
          return `${a?.name ?? t.id}, ${a?.status ?? ""}${t.parked ? ", waiting" : ""}. Press Enter for details.`;
        })
        .on("mouseenter.agent focus.agent", function (event, t) { onAgentHover(t.id, this); })
        .on("mouseleave.agent blur.agent", () => onAgentHover(null, null))
        .on("click.agent", function (event, t) { onAgentClick(t.id, this); })
        .on("keydown.agent", function (event, t) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onAgentClick(t.id, this); } })
        .call((s) => tr(s, easeCubicInOut, 1.3).attr("transform", (t) => `translate(${t.x},${t.y}) scale(1)`))
        .select("text.ini").text((t) => agentInfo(t.id)?.initials ?? String(t.id).slice(0, 2));

      applyHighlight(svg);
      prev = new Map(layout.nodes.map((n) => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height, container: n.container }]));
    });
  }

  function titleOf(d) {
    const c = d.coverage;
    // In the tests lens the hover says exactly where the number came from, so a surprising one can be checked.
    const covLine = lens !== "tests" || !c ? null
      : c.band === "exempt" ? "No tests needed — this part is docs or config, not code"
      : c.pct == null ? (c.tested ? "Covered by a test suite; no line counts" : "No tests and no coverage data")
      : c.estimated ? `${pctText(c.pct)} covered, Claude's estimate (no report covers this part)`
      : c.total != null ? `${c.covered} of ${c.total} lines run by tests, from ${c.files} ${c.files === 1 ? "file" : "files"}${coverageSource ? ` in ${coverageSource}` : ""}`
      : `${pctText(c.pct)} covered, averaged over its parts`;
    return [
      covLine,
      d.name, d.note,
      d.from?.length ? `Came from ${d.from.join(" and ")}` : null,
      d.failing ? `${d.failing} failing ${d.failing === 1 ? "test" : "tests"}` : null,
      d.paths?.length ? d.paths.join(", ") : null,
    ].filter(Boolean).join("\n");
  }

  function bindEvents(sel) {
    sel
      .on("click.toggle", (event, d) => { if (d.hasChildren) onToggle(d.id); })
      .on("keydown.toggle", (event, d) => {
        if (d.hasChildren && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onToggle(d.id); }
      })
      .on("mouseenter.hover focus.hover", (event, d) => { event.stopPropagation(); onHover(d.id); })
      .on("mouseleave.hover blur.hover", () => onHover(null));
  }

  function subLine(d) {
    if (lens === "tests") {
      const c = d.coverage;
      if (c?.band === "exempt") return "no tests needed";
      const p = c?.pct != null ? `${pctText(c.pct)}${c.estimated ? " est." : ""}` : null;
      if (d.failing) return `${p ?? (c?.tested ? "tested" : "no tests")} · failing`;
      return p ? `${p} covered` : c?.tested ? "tested, no %" : "no tests";
    }
    if (d.focus) return `${(STATUS_LABEL[d.status] || d.status).toLowerCase()} · focus`;
    if (d.folded) return `${d.rollup.done}/${d.rollup.total} done · folded`;
    if (d.failing) return `${(STATUS_LABEL[d.status] || d.status).toLowerCase()} · failing`;
    return (STATUS_LABEL[d.status] || d.status).toLowerCase();
  }
  function leafLabel(d) {
    const parts = [d.name, STATUS_LABEL[d.status] || d.status];
    if (d.folded) parts.push(`folded group, ${d.rollup.done} of ${d.rollup.total} done, press Enter to open`);
    if (d.focus) parts.push("current focus");
    if (d.failing) parts.push(`${d.failing} failing ${d.failing === 1 ? "test" : "tests"}`);

    return parts.join(", ");
  }

  chart.coverageSource = function (v) { if (!arguments.length) return coverageSource; coverageSource = v; return chart; };
  chart.lens = function (v) { if (!arguments.length) return lens; lens = v === "tests" ? "tests" : "work"; return chart; };
  chart.duration = function (v) { if (!arguments.length) return duration; duration = v; return chart; };
  chart.onToggle = function (v) { if (!arguments.length) return onToggle; onToggle = v; return chart; };
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  chart.highlight = function (v) { if (!arguments.length) return highlight; highlight = v; return chart; };
  chart.agentInfo = function (v) { if (!arguments.length) return agentInfo; agentInfo = v; return chart; };
  chart.onAgentHover = function (v) { if (!arguments.length) return onAgentHover; onAgentHover = v; return chart; };
  chart.onAgentClick = function (v) { if (!arguments.length) return onAgentClick; onAgentClick = v; return chart; };
  /** Re-applies `highlight` without redrawing, for hover. */
  chart.refreshHighlight = function (selection) { selection.selectAll("svg.map").each(function () { applyHighlight(select(this)); }); return chart; };
  /** Removes listeners and stops transitions. */
  chart.destroy = function (selection) {
    selection.selectAll("g.part").on(".toggle", null).on(".hover", null);
    selection.selectAll("g.token").on(".agent", null);
    selection.selectAll("*").interrupt("map");
    selection.selectAll("svg.map").remove();
    return chart;
  };
  return chart;
}
