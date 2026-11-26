// HTML panels drawn with D3 joins (no innerHTML), so text is always escaped and
// rows keep their elements across updates.
import { select, scaleLinear } from "d3";
import { VERB, STATUS_LABEL, flattenTodos } from "./model.js";

const TODO_LABEL = { in_progress: "In progress", pending: "To do", blocked: "Blocked", done: "Done" };

/**
 * The todo list, with sub-todos indented under their parent. Datum:
 * `{ todos, agents, byId }` from buildModel. Parents show a fold button and
 * their own progress; finished parents start folded.
 * Config: onHover(todoKey|null), collapsed / expanded (Sets of todo keys),
 * onToggle(key).
 */
export function todoList() {
  let onHover = () => {};
  let onToggle = () => {};
  let collapsed;
  let expanded = new Set();

  function chart(selection) {
    selection.each(function ({ todos, agents, byId }) {
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const rows = flattenTodos(todos, { collapsed, expanded });
      const ul = select(this).attr("role", "tree");
      ul.selectAll("li.empty").data(rows.length ? [] : [null]).join("li").attr("class", "empty").text("No todos yet.");
      ul.selectAll("li.todo")
        .data(rows, (t) => t.key) // keyed: rows re-sort by status and fold open, and index matching would swap their text
        .join((enter) => {
          const li = enter.append("li").attr("class", "todo");
          li.append("button").attr("class", "fold").attr("type", "button");
          li.append("span").attr("class", "box").attr("aria-hidden", "true");
          const txt = li.append("span").attr("class", "txt");
          txt.append("span").attr("class", "ttl");
          txt.append("span").attr("class", "note");
          const meta = li.append("span").attr("class", "meta");
          meta.append("span").attr("class", "prog");
          meta.append("span").attr("class", "where");
          meta.append("span").attr("class", "own");
          return li;
        })
        .attr("class", (t) => `todo ${t.status} depth-${Math.min(t.depth, 3)}${t.children.length ? " parent" : ""}`)
        .attr("role", "treeitem")
        .attr("aria-level", (t) => t.depth + 1)
        .attr("aria-expanded", (t) => (t.children.length ? String(!t.folded) : null))
        .attr("aria-label", (t) => `${t.text}, ${TODO_LABEL[t.status]}${t.progress ? `, ${t.progress.done} of ${t.progress.total} sub-tasks done` : ""}`)
        .style("--depth", (t) => t.depth)
        .on("mouseenter.hover", (event, t) => onHover(t.key))
        .on("mouseleave.hover", () => onHover(null))
        .order()
        .call((li) => {
          li.select(".fold")
            .attr("hidden", (t) => (t.children.length ? null : ""))
            .attr("aria-label", (t) => `${t.folded ? "Show" : "Hide"} sub-tasks of ${t.text}`)
            .text((t) => (t.folded ? "+" : "−"))
            .on("click.toggle", (event, t) => onToggle(t.key, t.folded));
          li.select(".box").attr("class", (t) => `box ${t.status}`);
          li.select(".ttl").text((t) => t.text);
          li.select(".note").text((t) => t.note || "").attr("hidden", (t) => (t.note ? null : ""));
          li.select(".prog")
            .attr("hidden", (t) => (t.progress ? null : ""))
            .text((t) => (t.progress ? `${t.progress.done}/${t.progress.total}` : ""));
          li.select(".where").text((t) => (t.node ? byId.get(t.node).name : ""));
          li.select(".own")
            .attr("hidden", (t) => (agentById.has(t.owner) ? null : ""))
            .attr("title", (t) => agentById.get(t.owner)?.name ?? null)
            .text((t) => agentById.get(t.owner)?.initials ?? "");
        });
    });
  }
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  chart.onToggle = function (v) { if (!arguments.length) return onToggle; onToggle = v; return chart; };
  chart.collapsed = function (v) { if (!arguments.length) return collapsed; collapsed = v; return chart; };
  chart.expanded = function (v) { if (!arguments.length) return expanded; expanded = v; return chart; };
  return chart;
}

/**
 * A stacked bar of counts with labels inside the segments that are wide
 * enough. Datum: `{ total, [status]: n }`. Config: order (statuses left to
 * right), labels (status -> name), minLabel (fraction below which a segment
 * goes unlabelled).
 */
export function stackedBar() {
  let order = ["done", "active", "blocked", "planned", "idea", "untouched"];
  let labels = STATUS_LABEL;
  let minLabel = 0.12;
  let onHover = () => {};

  function chart(selection) {
    selection.each(function (counts) {
      const total = counts.total || 0;
      const x = scaleLinear().domain([0, Math.max(1, total)]).range([0, 100]); // an empty set draws an empty bar, not NaN widths
      let start = 0;
      const segs = order.map((st) => {
        const n = counts[st] || 0;
        const seg = { key: st, n, x0: x(start), w: x(n) };
        start += n;
        return seg;
      });
      select(this)
        .attr("role", "img")
        .attr("aria-label", segs.filter((s) => s.n).map((s) => `${s.n} ${labels[s.key].toLowerCase()}`).join(", ") || "Nothing yet")
        .selectAll("div.seg")
        .data(segs, (s) => s.key)
        .join((enter) => enter.append("div").call((d) => d.append("span")))
        .attr("class", (s) => `seg seg-${s.key}`)
        .attr("title", (s) => (s.n ? `${s.n} ${labels[s.key].toLowerCase()}` : null))
        .on("mouseenter.hover", (event, s) => onHover(s.n ? s.key : null))
        .on("mouseleave.hover", () => onHover(null))
        .style("left", (s) => `${s.x0}%`)
        .style("width", (s) => `${s.w}%`)
        .select("span")
        .text((s) => (total && s.n / total >= minLabel ? `${s.n} ${labels[s.key].toLowerCase()}` : ""));
    });
  }
  chart.order = function (v) { if (!arguments.length) return order; order = v; return chart; };
  chart.labels = function (v) { if (!arguments.length) return labels; labels = v; return chart; };
  chart.minLabel = function (v) { if (!arguments.length) return minLabel; minLabel = v; return chart; };
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  return chart;
}

/**
 * The activity feed, newest first. Datum: `{ events, agents, byId }`.
 * Rows that were not there on the previous call get the `new` class, so they
 * flash once. Config: limit, formatTime(ms), onHover(eventIndex|null).
 */
export function activityFeed() {
  let limit = 60;
  let filter = () => true;
  let onHover = () => {};
  let formatTime = (ms) => (ms == null ? "" : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
  let seen = null; // keys from the previous call; null until the first call so nothing flashes on load

  function chart(selection) {
    selection.each(function ({ events, agents, byId }) {
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const rows = events.filter(filter).slice(-limit).reverse();
      const key = (e) => `${e._i}|${e.t ?? ""}`;
      const ul = select(this);
      ul.selectAll("li.empty").data(rows.length ? [] : [null]).join("li").attr("class", "empty")
        .text("No events yet. Hooks add a line here each time Claude reads, edits, runs something or starts an agent.");
      const nameOf = (id) => (id == null ? "" : agentById.get(String(id))?.name ?? String(id));
      ul.selectAll("li.ev")
        .data(rows, key)
        .join((enter) => {
          const li = enter.append("li").attr("class", "ev");
          li.append("span").attr("class", "when");
          li.append("span").attr("class", "who");
          const what = li.append("span").attr("class", "what");
          what.append("span").attr("class", "verb");
          what.append("span").attr("class", "to");
          what.append("span").attr("class", "tgt");
          what.append("span").attr("class", "text");
          what.append("span").attr("class", "in");
          return li;
        })
        .attr("class", (e) => `ev type-${e.type ?? "other"}`)
        .on("mouseenter.hover", (event, e) => onHover(e._i))
        .on("mouseleave.hover", () => onHover(null))
        .classed("new", (e) => seen != null && !seen.has(key(e)))
        .order() // newest first, also after the log is rewritten
        .call((li) => {
          li.select(".when").text((e) => formatTime(e._t)).attr("title", (e) => e.t ?? null);
          li.select(".who").text((e) => nameOf(e.agent));
          li.select(".verb").text((e) => VERB[e.type] || e.type || "");
          li.select(".to").text((e) => (e.to != null ? ` ${nameOf(e.to)}` : ""));
          li.select(".tgt").text((e) => e.target ?? "").attr("hidden", (e) => (e.target ? null : ""));
          li.select(".text").text((e) => (e.text ? ` ${e.text}` : ""));
          li.select(".in").text((e) => (e.node && byId.has(e.node) ? ` in ${byId.get(e.node).name}` : ""));
        });
      seen = new Set(rows.map(key));
    });
  }
  chart.limit = function (v) { if (!arguments.length) return limit; limit = v; return chart; };
  chart.filter = function (v) { if (!arguments.length) return filter; filter = v; return chart; };
  chart.formatTime = function (v) { if (!arguments.length) return formatTime; formatTime = v; return chart; };
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  return chart;
}

/**
 * One row per agent (people left out): initials, name, status, role and task,
 * with the agent's skills folded away in a disclosure. Datum: agents.
 * Config: onHover(agentId|null).
 */
export function agentRoster() {
  let onHover = () => {};
  function chart(selection) {
    selection.each(function (agents) {
      select(this).selectAll("div.arow")
        .data(agents.filter((a) => !a.isPerson), (a) => a.id)
        .join((enter) => {
          const row = enter.append("div").attr("class", "arow");
          row.append("span").attr("class", "ini").attr("aria-hidden", "true");
          row.append("b");
          row.append("span").attr("class", "state");
          row.append("span").attr("class", "task");
          const det = row.append("details").attr("class", "skills");
          det.append("summary");
          det.append("ul");
          return row;
        })
        .attr("class", (a) => `arow status-${a.status}`)
        .on("mouseenter.hover", (event, a) => onHover(a.id))
        .on("mouseleave.hover", () => onHover(null))
        .call((row) => {
          row.select(".ini").text((a) => a.initials);
          row.select("b").text((a) => a.name);
          row.select(".state").text((a) => a.status);
          row.select(".task").text((a) => [a.role, a.about ?? a.task].filter(Boolean).join(". "));
          row.select("details").attr("hidden", (a) => (a.skills.length ? null : ""));
          row.select("summary").text((a) => `${a.skills.length} ${a.skills.length === 1 ? "skill" : "skills"}`);
          row.select("details ul").selectAll("li")
            .data((a) => a.skills, (k) => k.name)
            .join((enter) => enter.append("li").call((li) => { li.append("code"); li.append("span"); }))
            .call((li) => {
              li.select("code").text((k) => k.name);
              li.select("span").text((k) => (k.description ? ` ${k.description}` : ""));
            });
        });
    });
  }
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  return chart;
}

/**
 * The agent explainer card: who the agent is, what it is doing, where, its
 * last action and its skills. Datum: { agent, partName(id), todoCount, now, pinned }.
 * A hover card lists skill names; a pinned card (after a click) lists them with
 * descriptions. Config: formatAgo(ms, now), onClose().
 */
export function agentCard() {
  let formatAgo = () => "";
  let onClose = () => {};
  function chart(selection) {
    selection.each(function ({ agent: a, partName, todoCount, now, pinned }) {
      const card = select(this).attr("class", `card${pinned ? " pinned" : ""} status-${a.status}`);
      const head = card.selectAll("div.card-head").data([null]).join((e) => {
        const h = e.append("div").attr("class", "card-head");
        h.append("span").attr("class", "ini");
        const t = h.append("div");
        t.append("b").attr("class", "card-name");
        t.append("span").attr("class", "card-role");
        h.append("button").attr("class", "card-close").attr("type", "button").attr("aria-label", "Close").text("×");
        return h;
      });
      head.select(".ini").text(a.initials);
      head.select(".card-name").text(a.name);
      head.select(".card-role").text([a.role, a.status].filter(Boolean).join(" · "));
      head.select(".card-close").attr("hidden", pinned ? null : "").on("click.close", () => onClose());

      const facts = [
        ["What it's for", a.about ?? (a.role ? `${a.role}.` : null)],
        ["Doing", a.task],
        ["Where", a.at ? partName(a.at) : a.status === "working" ? null : "Waiting, not on a part"],
        ["Last", a.lastAction ? [verbFor(a.lastAction), a.lastAction.target, a.lastAction.t != null ? `(${formatAgo(a.lastAction.t, now)})` : null].filter(Boolean).join(" ") : null],
        ["Todos", todoCount ? `${todoCount} assigned` : null],
      ].filter((f) => f[1]);
      card.selectAll("dl").data([null]).join("dl").selectAll("div.fact")
        .data(facts, (f) => f[0])
        .join((e) => e.append("div").attr("class", "fact").call((d) => { d.append("dt"); d.append("dd"); }))
        .order()
        .call((d) => { d.select("dt").text((f) => f[0]); d.select("dd").text((f) => f[1]); });

      const sk = card.selectAll("div.card-skills").data([null]).join((e) => {
        const d = e.append("div").attr("class", "card-skills");
        d.append("div").attr("class", "label");
        d.append("ul");
        d.append("p").attr("class", "hint");
        return d;
      });
      sk.attr("hidden", a.skills.length ? null : "");
      sk.select(".label").text(`Skills (${a.skills.length})`);
      sk.select("ul").selectAll("li")
        .data(pinned ? a.skills : a.skills.slice(0, 4), (k) => k.name)
        .join((e) => e.append("li").call((li) => { li.append("code"); li.append("span"); }))
        .call((li) => {
          li.select("code").text((k) => k.name);
          li.select("span").text((k) => (pinned && k.description ? k.description : ""));
        });
      sk.select(".hint").text(pinned ? "" : a.skills.length > 4 ? `and ${a.skills.length - 4} more. Click for all skills.` : "Click for skill details.");
    });
  }
  chart.formatAgo = function (v) { if (!arguments.length) return formatAgo; formatAgo = v; return chart; };
  chart.onClose = function (v) { if (!arguments.length) return onClose; onClose = v; return chart; };
  return chart;
}
function verbFor(action) {
  const v = VERB[action.type] || action.type || "";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * The tests panel. Two numbers (lines covered, tests passing or failing), a
 * strip of recent runs, the failures with where they break and why, and the
 * least-covered parts. Datum: `{ tests, coverage, byId, now }`.
 * Config: onHover({ kind: "test" | "part", id } | null), runs (strip length),
 * formatAgo(ms, now), color(pct) for the coverage bars.
 */
export function testsPanel() {
  let onHover = () => {};
  let runs = 20;
  let formatAgo = () => "";
  let color = () => "#2A9D97";
  let weakest = 5;

  function chart(selection) {
    selection.each(function ({ tests: t, coverage, byId, now }) {
      const root = select(this);
      const partName = (id) => byId.get(id)?.name ?? id;
      const pct = (p) => `${Math.round(p * 100)}%`;

      // ---- the two numbers -------------------------------------------------
      const top = root.selectAll("div.tests-top").data([null]).join((e) => {
        const d = e.append("div").attr("class", "tests-top");
        for (const k of ["cov", "pass"]) {
          const n = d.append("div").attr("class", `tnum ${k}`);
          n.append("b");
          n.append("span");
        }
        return d;
      });
      top.select(".tnum.cov b").text(coverage?.pct != null ? pct(coverage.pct) : "–");
      top.select(".tnum.cov span").text(coverage?.total ? "of lines covered" : coverage?.pct != null ? "covered (estimate)" : "no coverage yet");
      top.select(".tnum.pass").attr("class", `tnum pass ${t.status}`);
      top.select(".tnum.pass b").text(
        t.status === "failing" ? `✕ ${t.failed || ""}`.trim()
          : t.status === "running" ? "…"
          : t.status === "passing" ? `✓ ${t.passed ?? ""}`.trim() : "–",
      );
      top.select(".tnum.pass span").text(
        t.status === "failing" ? (t.failed === 1 ? "test failing" : "tests failing")
          : t.status === "running" ? "running now"
          : t.status === "passing" ? "tests pass" : "no runs yet",
      );

      // ---- run strip ---------------------------------------------------------
      // Each run is a column split into passed (grey) and failed (red); newest on the right.
      const shown = t.runs.slice(-runs).map((r) => ({ ...r, key: `r${r.i ?? r.t}` }));
      if (t.running) shown.push({ key: "running", running: true });
      const colW = 8, gap = 3, h = 22;
      const width = runs * (colW + gap);
      const strip = root.selectAll("div.runs").data([null]).join((e) => {
        const d = e.append("div").attr("class", "runs");
        d.append("span").attr("class", "label").text("Runs");
        d.append("svg").attr("class", "run-strip").attr("role", "img").attr("height", h + 2)
          .call((s) => s.append("title")).call((s) => s.append("g").attr("class", "cols"))
          .call((s) => s.append("line").attr("class", "base"));
        d.append("span").attr("class", "ago");
        return d;
      }).attr("hidden", shown.length ? null : "");
      strip.select(".ago").text(t.latest ? formatAgo(t.latest.t, now) : "");
      const svg = strip.select("svg").attr("width", width).attr("viewBox", `0 0 ${width} ${h + 2}`);
      svg.select("title").text(`Last ${shown.length} test runs, ${shown.filter((r) => !r.running && !r.ok).length} failed`);
      svg.select("line.base").attr("x1", 0).attr("x2", width).attr("y1", h + 0.5).attr("y2", h + 0.5);
      const x = (i) => width - (shown.length - i) * (colW + gap);
      const col = svg.select("g.cols").selectAll("g.run").data(shown, (r) => r.key).join((e) => {
        const g = e.append("g").attr("class", "run").attr("transform", (r, i) => `translate(${x(i)},0)`);
        g.append("rect").attr("class", "pass").attr("width", colW).attr("y", h).attr("height", 0);
        g.append("rect").attr("class", "fail").attr("width", colW).attr("y", h).attr("height", 0);
        g.append("title");
        return g;
      });
      col.attr("class", (r) => `run${r.running ? " running" : r.ok ? " ok" : " bad"}`)
        .transition("tests").duration(500).attr("transform", (r, i) => `translate(${x(i)},0)`);
      const split = (r) => {
        if (r.running) return { pass: h, fail: 0 };
        const total = (r.passed ?? 0) + (r.failed ?? 0);
        if (!total) return r.ok ? { pass: h, fail: 0 } : { pass: 0, fail: h }; // a crash with no counts is all red
        const fail = r.failed ? Math.max(4, (h * r.failed) / total) : 0; // one failure must still show
        return { pass: h - fail, fail };
      };
      col.select("rect.fail").transition("tests").duration(500).attr("y", (r) => h - split(r).fail - split(r).pass).attr("height", (r) => split(r).fail);
      col.select("rect.pass").transition("tests").duration(500).attr("y", (r) => h - split(r).pass).attr("height", (r) => split(r).pass);
      col.select("title").text((r) => (r.running ? "Running now"
        : `${r.ok ? "Passed" : "Failed"}${r.passed != null ? `: ${r.passed} passed, ${r.failed ?? 0} failed` : ""}${r.coverage != null ? `, ${pct(r.coverage)} covered` : ""}`));

      // ---- failures ------------------------------------------------------------
      const fails = t.suites.flatMap((s) => s.failures).concat(t.untraced.map((n) => ({ key: `untraced/${n}`, name: n, node: null, cause: null, untraced: true })));
      const fl = root.selectAll("ul.failures").data([null]).join("ul").attr("class", "failures").attr("hidden", fails.length ? null : "");
      const fli = fl.selectAll("li.failure").data(fails, (f) => f.key).join((e) => {
        const f = e.append("li").attr("class", "failure").attr("tabindex", 0);
        f.append("span").attr("class", "fname");
        f.append("span").attr("class", "fwhere");
        f.append("span").attr("class", "fcause");
        f.append("code").attr("class", "ferr");
        return f;
      })
        .on("mouseenter.hover focus.hover", (event, f) => onHover(f.untraced ? null : { kind: "test", id: f.key }))
        .on("mouseleave.hover blur.hover", () => onHover(null));
      fli.select(".fname").text((f) => f.name);
      fli.select(".fwhere").text((f) => (f.node ? `Broken in ${partName(f.node)}` : "")).attr("hidden", (f) => (f.node ? null : ""));
      fli.select(".fcause").text((f) => f.cause ?? "Cause not found yet").classed("unknown", (f) => !f.cause);
      fli.select(".ferr").text((f) => f.error ?? "").attr("hidden", (f) => (f.error ? null : ""));

      // ---- least covered parts -----------------------------------------------
      // Measured parts, weakest first; parts with no tests at all get one line of their own.
      const all = coverage ? [...coverage.byNode.entries()].filter(([, c]) => c.leaves === 1).map(([id, c]) => ({ id, ...c })) : [];
      const leaves = all.filter((d) => d.pct != null).sort((a, b) => a.pct - b.pct).slice(0, weakest);
      const none = all.filter((d) => !d.tested);
      const wk = root.selectAll("div.weak").data([null]).join((e) => {
        const d = e.append("div").attr("class", "weak");
        d.append("span").attr("class", "label").text("Least covered");
        d.append("ul");
        d.append("p").attr("class", "untested").attr("tabindex", 0).call((p) => { p.append("b"); p.append("span"); });
        return d;
      }).attr("hidden", leaves.length || none.length ? null : "");
      wk.select("p.untested").attr("hidden", none.length ? null : "")
        .on("mouseenter.hover focus.hover", () => onHover({ kind: "coverage", id: "untested" }))
        .on("mouseleave.hover blur.hover", () => onHover(null));
      wk.select("p.untested b").text(`No tests (${none.length}): `);
      wk.select("p.untested span").text(none.map((d) => partName(d.id)).join(", "));
      const rows = wk.select("ul").selectAll("li").data(leaves, (d) => d.id).join((e) => {
        const li = e.append("li").attr("tabindex", 0);
        li.append("span").attr("class", "wname");
        const bar = li.append("span").attr("class", "wbar");
        bar.append("i");
        li.append("span").attr("class", "wpct");
        return li;
      })
        .attr("class", (d) => `cov-${d.band}`)
        .on("mouseenter.hover focus.hover", (event, d) => onHover({ kind: "part", id: d.id }))
        .on("mouseleave.hover blur.hover", () => onHover(null))
        .order();
      rows.select(".wname").text((d) => partName(d.id));
      rows.select(".wbar i").style("width", (d) => `${(d.pct ?? 0) * 100}%`).style("background", (d) => (d.pct != null ? color(d.pct) : null));
      rows.select(".wpct").text((d) => (d.pct != null ? pct(d.pct) : d.tested ? "?" : "none"));
    });
  }
  chart.onHover = function (v) { if (!arguments.length) return onHover; onHover = v; return chart; };
  chart.runs = function (v) { if (!arguments.length) return runs; runs = v; return chart; };
  chart.formatAgo = function (v) { if (!arguments.length) return formatAgo; formatAgo = v; return chart; };
  chart.color = function (v) { if (!arguments.length) return color; color = v; return chart; };
  chart.weakest = function (v) { if (!arguments.length) return weakest; weakest = v; return chart; };
  return chart;
}
