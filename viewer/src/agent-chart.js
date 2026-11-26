// Agent cards: one card per working agent (todo ring, name, task, and a ribbon
// of what it did over the last minutes, with message pins above it), idle
// agents as chips. Hover a stretch of the ribbon for the file and time; click
// a card to open recent actions, the last message, todos and skills.
// Draws the output of `agentCardsData`; owns no data logic.
import { select, scaleTime, easeCubicInOut } from "d3";

const VERB = { read: "Read", edit: "Edited", run: "Ran", fail: "Tests failed", pass: "Tests passed", note: "Noted" };
const PAST = { read: "read", search: "searched", edit: "edited", state: "updated the plan", run: "ran", test: "ran tests", note: "noted",
  message: "messaged", spawn: "started", done: "finished", prompt: "asked", stop: "stopped" };

/**
 * Usage: agentCards().width(320).tooltip(tipEl)(select(el).datum({ data, partName, now }))
 *
 * Config (getter-setters): width (ribbon px), duration (ms; 0 for none),
 * open (Set of agent ids whose card is open), onToggle(id),
 * onHover({ kind: "event" | "agent", id } | null), formatAgo(ms, now),
 * tooltip (a fixed-position element the chart fills and moves).
 */
export function agentCards() {
  let width = 320;
  let duration = 600;
  let open = new Set();
  let onToggle = () => {};
  let onHover = () => {};
  let formatAgo = () => "";
  let tooltip = null;
  const H = 30, Y = 17; // ribbon height and the y of its centre line

  const tr = (sel) => (duration > 0 ? sel.transition("cards").duration(duration).ease(easeCubicInOut) : sel);

  function showTip(el, lines) {
    if (!tooltip) return;
    const tip = select(tooltip).attr("hidden", null);
    tip.selectAll("div").data(lines).join("div").attr("class", (d, i) => (i ? "tip-sub" : "tip-main")).text((d) => d);
    const r = el.getBoundingClientRect();
    const w = tooltip.offsetWidth;
    const vw = tooltip.ownerDocument.defaultView?.innerWidth ?? 1000;
    tip.style("left", `${Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2))}px`)
      .style("top", `${r.top - tooltip.offsetHeight - 8}px`);
  }
  const hideTip = () => tooltip && select(tooltip).attr("hidden", "");

  function chart(selection) {
    selection.each(function ({ data, partName = (id) => id, now }) {
      const { t0, t1, working, idle } = data;
      const x = scaleTime().domain([t0, t1]).range([4, width - 10]).clamp(true);
      const root = select(this);

      // ---- cards ---------------------------------------------------------------
      // Cards live in their own box so new ones land above the axis and chips, not after them.
      const list = root.selectAll("div.cards").data([null]).join("div").attr("class", "cards");
      list.selectAll("p.empty").data(working.length ? [] : [null]).join("p").attr("class", "empty").text("Nobody working right now.");
      const cards = list.selectAll("div.ag").data(working, (a) => a.id).join((enter) => {
        const c = enter.append("div").attr("class", "ag");
        const hd = c.append("button").attr("type", "button").attr("class", "hd");
        hd.append("svg").attr("class", "ring").attr("width", 40).attr("height", 40).attr("viewBox", "0 0 40 40").attr("aria-hidden", "true")
          .call((s) => {
            s.append("circle").attr("class", "track").attr("cx", 20).attr("cy", 20).attr("r", 17);
            s.append("circle").attr("class", "prog").attr("cx", 20).attr("cy", 20).attr("r", 17).attr("transform", "rotate(-90 20 20)")
              .attr("stroke-dasharray", `0 ${2 * Math.PI * 17}`);
            s.append("circle").attr("class", "disc").attr("cx", 20).attr("cy", 20).attr("r", 12);
            s.append("text").attr("class", "ini").attr("x", 20).attr("y", 20).attr("dy", "0.35em");
          });
        const txt = hd.append("span").attr("class", "txt");
        txt.append("span").attr("class", "nm");
        txt.append("span").attr("class", "tk");
        c.append("svg").attr("class", "ribbon").attr("height", H)
          .call((s) => { s.append("line").attr("class", "base"); s.append("g").attr("class", "runs"); s.append("g").attr("class", "pins"); });
        const wrap = c.append("div").attr("class", "more-wrap");
        const more = wrap.append("div").attr("class", "more");
        more.append("div").attr("class", "about");
        const rec = more.append("div").attr("class", "recent");
        rec.append("div").attr("class", "lb").text("Recent");
        rec.append("ul");
        more.append("div").attr("class", "msg");
        const foot = more.append("div").attr("class", "foot");
        foot.append("div").attr("class", "lb");
        foot.append("div").attr("class", "sk");
        return c;
      });
      cards
        .attr("class", (a) => `ag${open.has(a.id) ? " open" : ""}`)
        .attr("data-flip", (a) => `card:${a.id}`)
        .order();

      const hd = cards.select("button.hd")
        .attr("aria-expanded", (a) => String(open.has(a.id)))
        .attr("aria-label", (a) => `${a.name}: ${a.task ?? "working"}. ${open.has(a.id) ? "Close" : "Open"} details.`)
        .on("click.cards", (event, a) => onToggle(a.id))
        .on("mouseenter.cards focus.cards", (event, a) => onHover({ kind: "agent", id: a.id }))
        .on("mouseleave.cards blur.cards", () => onHover(null));
      hd.select("svg.ring").attr("data-flip", (a) => `agent:${a.id}`);
      // A round cap draws a dot even at zero length, so an empty ring hides its arc.
      hd.select("circle.prog").call((s) => tr(s).attr("stroke-opacity", (a) => (a.todos.done ? 1 : 0)).attr("stroke-dasharray", (a) => {
        const c = 2 * Math.PI * 17;
        return `${a.todos.total ? (c * a.todos.done) / a.todos.total : 0} ${c}`;
      }));
      hd.select("text.ini").text((a) => a.initials);
      hd.select(".nm").text((a) => a.name);
      hd.select(".tk").text((a) => a.task ?? "");

      // ---- ribbon: runs of activity, newest stretching to now --------------------
      const rib = cards.select("svg.ribbon").attr("width", width).attr("viewBox", `0 0 ${width} ${H}`);
      rib.select("line.base").attr("x1", 4).attr("x2", width - 10).attr("y1", Y).attr("y2", Y);
      rib.select("g.runs").selectAll("g.run").data((a) => a.runs, (r) => r.key).join((enter) => {
        const g = enter.append("g").attr("class", "run");
        // Runs grow out of their start, so a new action stretches in from where it began.
        g.append("rect").attr("class", "hit").attr("y", Y - 9).attr("height", 18).attr("x", (r) => x(r.t0)).attr("width", 0);
        g.append("rect").attr("class", "pill").attr("y", Y - 5).attr("height", 10).attr("rx", 5).attr("x", (r) => x(r.t0)).attr("width", 0);
        return g;
      })
        .attr("class", (r) => `run k-${r.kind}${r.live ? " live" : ""}`)
        .on("mouseenter.cards", function (event, r) {
          select(this.parentNode).classed("focus", true);
          select(this).classed("on", true);
          onHover({ kind: "event", id: r.i });
          const secs = Math.round((r.t1 - r.t0) / 1000);
          const span = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : secs ? `${secs}s` : "";
          showTip(this, [
            [r.live ? `Now: ${(VERB[r.kind] ?? r.kind).toLowerCase()}` : VERB[r.kind] ?? r.kind,
              r.kind === "read" && r.count > 1 ? `${r.count} files` : r.target,
              r.count > 1 && r.kind !== "read" ? `×${r.count}` : null].filter(Boolean).join(" "),
            [r.node ? `in ${partName(r.node)}` : null, span, r.live ? null : formatAgo(r.t1, now)].filter(Boolean).join(" · "),
          ].filter(Boolean));
        })
        .on("mouseleave.cards", function () {
          select(this.parentNode).classed("focus", false);
          select(this).classed("on", false);
          onHover(null);
          hideTip();
        })
        .call((g) => {
          const w = (r) => Math.max(8, x(r.t1) - x(r.t0) - 2); // 2px of paper between touching runs
          tr(g.select("rect.pill")).attr("x", (r) => x(r.t0)).attr("width", w);
          g.select("rect.hit").attr("x", (r) => x(r.t0) - 2).attr("width", (r) => w(r) + 4);
        });
      // Pins above the ribbon: filled for messages the agent sent, hollow for ones it received.
      rib.select("g.pins").selectAll("g.pin").data((a) => a.pins, (p) => p.key).join((enter) => {
        const g = enter.append("g").attr("class", "pin").attr("transform", (p) => `translate(${x(p.t)},0)`).attr("opacity", 0);
        g.append("line").attr("y1", 7).attr("y2", Y - 6);
        g.append("circle").attr("cy", 4.5).attr("r", 3.2);
        g.append("rect").attr("class", "hit").attr("x", -6).attr("y", -2).attr("width", 12).attr("height", 14);
        return g;
      })
        .attr("class", (p) => `pin ${p.dir}`)
        .on("mouseenter.cards", function (event, p) {
          onHover({ kind: "event", id: p.i });
          showTip(this, [`${p.dir === "out" ? "→" : "←"} ${p.otherName}${p.text ? `: ${p.text}` : ""}`, formatAgo(p.t, now)]);
        })
        .on("mouseleave.cards", () => { onHover(null); hideTip(); })
        .call((g) => tr(g).attr("transform", (p) => `translate(${x(p.t)},0)`).attr("opacity", 1));

      // ---- details, shown when the card is open -------------------------------
      const more = cards.select(".more");
      more.select(".about").text((a) => a.about ?? "").attr("hidden", (a) => (a.about ? null : ""));
      more.select(".recent ul").selectAll("li").data((a) => a.recent, (e) => `${e.t}|${e.type}|${e.target}`)
        .join((e) => e.append("li").call((li) => { li.append("time"); li.append("span").attr("class", "v"); li.append("code"); }))
        .classed("bad", (e) => e.ok === false)
        .call((li) => {
          li.select("time").text((e) => formatAgo(e.t, now).replace(" ago", ""));
          li.select(".v").text((e) => (e.type === "test" ? (e.ok ? "tests passed" : `tests failed${e.failed ? ` · ${e.failed}` : ""}`) : PAST[e.type] ?? e.type));
          li.select("code").text((e) => (e.type === "test" ? "" : e.target ?? e.text ?? ""));
        });
      more.select(".msg").attr("hidden", (a) => (a.message ? null : ""))
        .text((a) => (a.message ? `${a.message.dir === "out" ? "→" : "←"} ${a.message.otherName}${a.message.text ? `  ${a.message.text}` : ""}` : ""));
      more.select(".foot .lb").text((a) => [a.todos.total ? `Todos ${a.todos.done}/${a.todos.total}` : null, a.skills.length ? "Skills" : null].filter(Boolean).join(" · "));
      more.select(".foot .sk").selectAll("code").data((a) => a.skills, (k) => k.name)
        .join("code").attr("title", (k) => k.description ?? null).text((k) => k.name);

      // ---- time axis and idle chips ------------------------------------------------
      root.selectAll("div.axis").data([null]).join((e) => e.append("div").attr("class", "axis").call((d) => { d.append("span"); d.append("span"); }))
        .attr("hidden", working.length ? null : "")
        .call((d) => {
          d.select("span:first-child").text(`${Math.round((t1 - t0) / 60000)} min ago`);
          d.select("span:last-child").text("now");
        });
      const chips = root.selectAll("div.chips").data([null]).join((e) => e.append("div").attr("class", "chips").call((d) => d.append("span").attr("class", "lb").text("Idle")))
        .attr("hidden", idle.length ? null : "");
      chips.selectAll("span.c").data(idle, (a) => a.id).join((e) => e.append("span").attr("class", "c"))
        .attr("data-flip", (a) => `agent:${a.id}`)
        .attr("title", (a) => `${a.name}, ${a.status}`)
        .on("mouseenter.cards", (event, a) => onHover({ kind: "agent", id: a.id }))
        .on("mouseleave.cards", () => onHover(null))
        .text((a) => a.initials)
        .order();
    });
  }

  chart.width = function (v) { if (!arguments.length) return width; width = v; return chart; };
  chart.duration = function (v) { if (!arguments.length) return duration; duration = v; return chart; };
  chart.open = function (v) { if (!arguments.length) return open; open = v; return chart; };
  chart.onToggle = function (v) { if (!arguments.length) return onToggle; onToggle = v; return chart; };
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  chart.formatAgo = function (v) { if (!arguments.length) return formatAgo; formatAgo = v; return chart; };
  chart.tooltip = function (v) { if (!arguments.length) return tooltip; tooltip = v; return chart; };
  return chart;
}
