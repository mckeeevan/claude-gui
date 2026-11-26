// The agent timeline: one lane per agent, with its busy stretches, each action
// as a tick, and messages, spawns and hand-backs drawn between lanes. Draws the
// output of `timelineData`; owns no data logic.
import { select, scaleTime, timeFormat } from "d3";

let uid = 0;
const TYPE_LABEL = { read: "read", edit: "edited", run: "ran", search: "searched", test: "tests", state: "updated the plan", note: "note", stop: "stopped", done: "finished", prompt: "asked", message: "message", spawn: "started" };

/**
 * Usage: agentTimeline().width(300)(select(el).datum(timelineData(model, { now })))
 *
 * Config (getter-setters): width (px), lane (px per agent), duration (ms; 0 for
 * none), onHover({ kind: "agent" | "event", id } | null, element),
 * onAgentClick(id, element), partName(id) -> name, formatTime(ms).
 */
export function agentTimeline() {
  let width = 300;
  let lane = 46;
  let duration = 500;
  let onHover = () => {};
  let onAgentClick = () => {};
  let partName = (id) => id;
  let formatTime = timeFormat("%H:%M");
  const id = `timeline-${++uid}`;
  const strip = 12; // height of the activity strip under each agent's name

  const tr = (sel) => (duration > 0 ? sel.transition("tl").duration(duration) : sel);

  function chart(selection) {
    selection.each(function (data) {
      const { t0, t1, lanes, spans, marks, links } = data;
      const height = lanes.length * lane + 18;
      const x = scaleTime().domain([t0, t1]).range([0, width - 6]);
      const yOf = new Map(lanes.map((l, i) => [l.id, i * lane]));
      const stripY = (agent) => yOf.get(agent) + 24; // top of the agent's strip

      const svg = select(this).selectAll("svg.timeline").data([null]).join((enter) => {
        const s = enter.append("svg").attr("class", "timeline").attr("role", "img").attr("aria-labelledby", `${id}-t`);
        s.append("title").attr("id", `${id}-t`);
        s.append("g").attr("class", "links");
        s.append("g").attr("class", "lanes");
        s.append("g").attr("class", "axis");
        return s;
      });
      svg.attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height);
      const busy = lanes.filter((l) => l.status === "working").map((l) => l.name);
      svg.select("title").text(`${lanes.length} agents over the last ${Math.max(1, Math.round((t1 - t0) / 60000))} minutes. ${busy.length ? `Working: ${busy.join(", ")}.` : "Nobody working right now."} ${links.length} messages.`);

      // ---- lanes: name, task, strip with busy spans and action ticks -------------
      const laneSel = svg.select("g.lanes").selectAll("g.lane").data(lanes, (l) => l.id).join((enter) => {
        const g = enter.append("g").attr("class", "lane").attr("tabindex", 0).attr("transform", (l) => `translate(0,${yOf.get(l.id)})`).attr("opacity", 0);
        const head = g.append("g").attr("class", "head");
        // Paper behind the name line, so links between lanes pass under the text.
        head.append("rect").attr("class", "headbg").attr("y", -1).attr("height", 21);
        head.append("circle").attr("class", "disc").attr("cx", 8).attr("cy", 9).attr("r", 8);
        head.append("text").attr("class", "ini").attr("x", 8).attr("y", 9).attr("dy", "0.35em");
        head.append("text").attr("class", "nm").attr("x", 22).attr("y", 13);
        head.append("text").attr("class", "task").attr("y", 13);
        g.append("rect").attr("class", "track").attr("y", 24).attr("height", strip);
        g.append("g").attr("class", "spans");
        g.append("g").attr("class", "marks");
        return g;
      });
      laneSel
        .attr("class", (l) => `lane status-${l.status}${l.isPerson ? " person" : ""}`)
        .attr("aria-label", (l) => `${l.name}, ${l.status}${l.task ? `: ${l.task}` : ""}`)
        .on("mouseenter.tl focus.tl", function (event, l) { onHover({ kind: "agent", id: l.id }, this.querySelector(".disc")); })
        .on("mouseleave.tl blur.tl", () => onHover(null, null))
        .on("click.tl", function (event, l) { if (!event.target.closest(".mark")) onAgentClick(l.id, this.querySelector(".disc")); })
        .call((s) => tr(s).attr("transform", (l) => `translate(0,${yOf.get(l.id)})`).attr("opacity", 1));
      laneSel.select(".ini").text((l) => l.initials);
      laneSel.select(".nm").text((l) => l.name);
      // The task follows the name on the same line, cut to the space left (SVG text does not wrap).
      laneSel.select(".task").each(function (l) {
        const left = 22 + l.name.length * 7.4 + 8;
        const room = Math.max(0, Math.floor((width - left) / 6.2));
        const text = l.status === "working" ? (l.task ?? "") : l.status;
        select(this).attr("x", left).text(text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text);
      });
      laneSel.select("rect.track").attr("width", width - 6);
      laneSel.select("rect.headbg").attr("width", width);

      laneSel.select("g.spans").selectAll("rect.span").data((l) => spans.filter((s) => s.agent === l.id), (s) => `${s.t0}`)
        .join((e) => e.append("rect").attr("class", "span").attr("y", 24).attr("height", strip).attr("x", (s) => x(s.t0)).attr("width", 0))
        .classed("live", (s) => s.live)
        .call((s) => tr(s).attr("x", (s) => x(s.t0)).attr("width", (s) => Math.max(2, x(s.t1) - x(s.t0))));

      laneSel.select("g.marks").selectAll("g.mark").data((l) => marks.filter((m) => m.agent === l.id), (m) => m.i)
        .join((e) => {
          const g = e.append("g").attr("class", "mark").attr("transform", (m) => `translate(${x(m.t)},${24 + strip / 2}) scale(0)`);
          g.append("path");
          g.append("title");
          return g;
        })
        .attr("class", (m) => `mark type-${m.type}${m.type === "test" ? (m.ok ? " ok" : " bad") : ""}`)
        .on("mouseenter.tl", function (event, m) { event.stopPropagation(); onHover({ kind: "event", id: m.i }, this); })
        .on("mouseleave.tl", () => onHover(null, null))
        .call((s) => tr(s).attr("transform", (m) => `translate(${x(m.t)},${24 + strip / 2}) scale(1)`))
        .call((s) => {
          s.select("path").attr("d", (m) => SHAPES[m.type] ?? SHAPES.other);
          s.select("title").text((m) => [
            formatTime(m.t),
            m.type === "test" ? (m.ok ? "tests passed" : "tests failed") : TYPE_LABEL[m.type] ?? m.type,
            m.target, m.node ? `in ${partName(m.node)}` : null, m.text,
          ].filter(Boolean).join(" · "));
        });

      // ---- links between lanes ---------------------------------------------------
      // A link leaves the sender's strip and lands on the receiver's, bowing right so
      // links at the same moment stay apart; spawns are dashed, hand-backs end in a dot.
      const path = (k) => {
        const xx = x(k.t);
        const a = stripY(k.from) + (yOf.get(k.from) < yOf.get(k.to) ? strip : 0);
        const b = stripY(k.to) + (yOf.get(k.from) < yOf.get(k.to) ? 0 : strip);
        const bow = Math.min(18, Math.abs(b - a) / 4) * (xx < width / 2 ? 1 : -1); // bow inward, never off the edge
        return `M${xx},${a}C${xx + bow},${a + (b - a) / 3} ${xx + bow},${b - (b - a) / 3} ${xx},${b}`;
      };
      svg.select("g.links").selectAll("g.link").data(links, (k) => k.i)
        .join((e) => {
          const g = e.append("g").attr("class", "link").attr("opacity", 0);
          g.append("path").attr("class", "line");
          g.append("circle").attr("class", "end").attr("r", 2.5);
          g.append("title");
          return g;
        })
        .attr("class", (k) => `link type-${k.type}`)
        .on("mouseenter.tl", function (event, k) { onHover({ kind: "event", id: k.i }, this); })
        .on("mouseleave.tl", () => onHover(null, null))
        .call((s) => tr(s).attr("opacity", 1))
        .call((s) => {
          s.select("path.line").call((p) => tr(p).attr("d", path));
          s.select("circle.end").call((c) => tr(c)
            .attr("cx", (k) => x(k.t))
            .attr("cy", (k) => stripY(k.to) + (yOf.get(k.from) < yOf.get(k.to) ? 0 : strip)));
          s.select("title").text((k) => `${formatTime(k.t)} · ${lanes.find((l) => l.id === k.from)?.name} ${TYPE_LABEL[k.type] ?? k.type} ${lanes.find((l) => l.id === k.to)?.name}${k.text ? `: ${k.text}` : ""}`);
        });

      // ---- time axis: start, middle and "now" ----------------------------------
      const ticks = [t0, (t0 + t1) / 2, t1];
      svg.select("g.axis").attr("transform", `translate(0,${height - 4})`).selectAll("text").data(ticks)
        .join("text")
        .attr("x", (t) => x(t))
        .attr("text-anchor", (t, i) => (i === 0 ? "start" : i === 2 ? "end" : "middle"))
        .text((t, i) => (i === 2 ? "now" : formatTime(t)));
    });
  }

  chart.width = function (v) { if (!arguments.length) return width; width = v; return chart; };
  chart.lane = function (v) { if (!arguments.length) return lane; lane = v; return chart; };
  chart.duration = function (v) { if (!arguments.length) return duration; duration = v; return chart; };
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  chart.onAgentClick = function (v) { if (!arguments.length) return onAgentClick; onAgentClick = v; return chart; };
  chart.partName = function (v) { if (!arguments.length) return partName; partName = v; return chart; };
  chart.formatTime = function (v) { if (!arguments.length) return formatTime; formatTime = v; return chart; };
  return chart;
}

// Tick shapes, centred on 0,0 and about 8px across, so the kind of action reads without colour.
const SHAPES = {
  edit: "M-3.5,-4.5h7v9h-7z",                       // a solid bar: something changed
  read: "M0,-3.2a3.2,3.2 0 1,0 0.01,0z",             // a dot
  search: "M0,-3.2a3.2,3.2 0 1,0 0.01,0z",
  run: "M-3,-4L4,0L-3,4z",                          // a play triangle
  test: "M0,-4.5L4.5,0L0,4.5L-4.5,0z",              // a diamond, red when the run failed
  state: "M-4,-1h8v2h-8z",
  other: "M-1.2,-4.5h2.4v9h-2.4z",
};
