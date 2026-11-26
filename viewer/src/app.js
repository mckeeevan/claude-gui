// Page wiring: reads the two files, builds the model and calls each view.
// This is the only module that touches `document`, `window` or the clock.
import { select } from "d3";
import { load as parseYaml } from "js-yaml";
import { buildModel, parseEvents, applyTexts, mergeEvents, tailRead, isLive, todosBehind, toMs, layoutStructure, relations, formatAgo, summarize, flattenTodos, agentCardsData, COVERAGE_BANDS, COVERAGE_LABEL } from "./model.js";
import { capture, play } from "./flip.js";
import { structureMap, coverageColor } from "./structure-chart.js";
import { agentCards } from "./agent-chart.js";
import { todoList, stackedBar, activityFeed, agentCard, testsPanel } from "./panels.js";
import { DEMO_SCRIPT } from "./demo.js";
import { splitters } from "./splitters.js";

const CFG = {
  state: "state/state.yaml", events: "state/events.jsonl", coverage: "state/coverage.json", heartbeat: "state/heartbeat", poll: 1000,
  dbDoc: "workview/live",
  filesDir: "work-view", filesPoll: 2000, // a folder in the claude.ai project, read when the page declares the files capability
  ...(window.CLAUDE_GUI || {}),
};
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const elk = window.ELK ? new window.ELK() : null;

let state = null;
let events = [];
let coverage = null; // parsed coverage.json, written by the hook after a test run
let lastCoverageText = null;
let lens = "work";
let mode = "starting";
let lastStateText = null;
let lastEventsText = null;
let seenEvents = 0;
let firstRender = true;
let layout = null;
let renderToken = 0;
let model = null;
let hover = null; // { kind: "part" | "todo" | "agent" | "event" | "test", id }
let pinned = null; // agent id whose card was opened by a click
const collapsed = new Set();
const expanded = new Set();
const todoCollapsed = new Set();
const todoExpanded = new Set();

const toggle = (folded, id, open, closed) => {
  if (folded) { closed.delete(id); open.add(id); } else { open.delete(id); closed.add(id); }
};

const map = structureMap()
  .onToggle((id) => {
    const node = layout?.nodes.find((n) => n.id === id);
    if (!node) return;
    toggle(!node.container, id, expanded, collapsed);
    render();
  })
  .onHover((id) => setHover(id && { kind: "part", id }))
  .agentInfo((id) => model?.agents.find((a) => a.id === id))
  .onAgentHover((id, el) => { setHover(id && { kind: "agent", id }); showCard(id, el); })
  .onAgentClick((id, el) => pinCard(id, el));
const openCards = new Set();
const cardsView = agentCards()
  .open(openCards)
  .tooltip(document.getElementById("tip"))
  .formatAgo(formatAgo)
  .onHover((target) => setHover(target))
  .onToggle((id) => { if (openCards.has(id)) openCards.delete(id); else openCards.add(id); renderPanels(Date.now(), 450); });
const todos = todoList()
  .collapsed(todoCollapsed)
  .expanded(todoExpanded)
  .onHover((key) => setHover(key && { kind: "todo", id: key }))
  .onToggle((key, folded) => { toggle(folded, key, todoExpanded, todoCollapsed); render(); });
const partsBar = stackedBar().onHover((st) => setHover(st && { kind: "status", id: st }));
const todoBar = stackedBar()
  .order(["done", "in_progress", "blocked", "pending"])
  .labels({ done: "Done", in_progress: "In progress", blocked: "Blocked", pending: "To do" })
  .onHover((st) => setHover(st && { kind: "todo-status", id: st }));
const feed = activityFeed().onHover((i) => setHover(i != null && { kind: "event", id: i }));
const testsView = testsPanel().formatAgo(formatAgo).color(coverageColor).onHover((target) => setHover(target));
const covBar = stackedBar().order(COVERAGE_BANDS).labels(COVERAGE_LABEL)
  .onHover((band) => setHover(band && { kind: "coverage", id: band }));
const card = agentCard().formatAgo(formatAgo).onClose(() => { pinned = null; showCard(null); });

// Linked highlighting: whatever the person points at, every panel lights up
// what is related to it and fades the rest.
function setHover(target) {
  hover = target || null;
  applyHighlight();
}
function applyHighlight() {
  const rel = model && hover ? relations(model, layout, hover) : null;
  map.highlight(rel).refreshHighlight(select("#map"));
  const mark = (sel, has) => sel.classed("dim", (d) => rel != null && !has(d)).classed("lit", (d) => rel != null && has(d));
  mark(select("#todos").selectAll("li.todo"), (t) => rel.todos.has(t.key));
  mark(select("#agents").selectAll("div.ag"), (a) => rel.agents.has(a.id));
  mark(select("#agents").selectAll("span.c"), (a) => rel.agents.has(a.id));
  const segOn = (kind) => (s) => hover?.kind === kind && hover.id === s.key;
  select("#parts-bar").selectAll("div.seg").classed("dim", (s) => rel != null && !segOn("status")(s)).classed("lit", segOn("status"));
  select("#todo-bar").selectAll("div.seg").classed("dim", (s) => rel != null && !segOn("todo-status")(s)).classed("lit", segOn("todo-status"));
  select("#cov-bar").selectAll("div.seg").classed("dim", (s) => rel != null && !segOn("coverage")(s)).classed("lit", segOn("coverage"));
  mark(select("#tests").selectAll(".weak li"), (d) => rel.parts.has(layout?.visibleOf?.get(d.id) ?? d.id));
  select("#tests").select(".weak .untested").classed("dim", rel != null && !(hover?.kind === "coverage" && hover.id === "untested"));
  mark(select("#tests").selectAll("li.failure"), (f) => rel.tests?.has(f.key));
  mark(select("#tests").selectAll("li.suite:not(.untraced)"), (s) => rel.tests?.has(s.id));
  mark(select("#tests").selectAll("li.suite:not(.untraced) li.failure"), (f) => rel.tests?.has(f.key));
  mark(select("#feed").selectAll("li.ev"), (e) =>
    (e.node && rel.parts.has(layout?.visibleOf?.get(e.node) ?? e.node)) || rel.agents.has(String(e.agent)));
}

// The explainer card follows the pointer; a click pins it open with every skill.
function showCard(id, el) {
  if (pinned && id !== pinned) return;
  const host = select("#card");
  const agent = id && model?.agents.find((a) => a.id === id);
  if (!agent || !el) { if (!pinned) host.attr("hidden", ""); return; }
  const todoCount = flattenTodos(model.todos, { collapsed: null }).filter((t) => t.owner === id).length;
  host.attr("hidden", null).datum({
    agent, todoCount, now: Date.now(), pinned: pinned === id,
    partName: (pid) => model.byId.get(pid)?.name ?? pid,
  }).call(card);
  const r = el.getBoundingClientRect();
  const node = host.node();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
  const top = r.bottom + 10 + h < window.innerHeight ? r.bottom + 10 : Math.max(12, r.top - h - 10);
  host.style("left", `${left}px`).style("top", `${top}px`);
}
function pinCard(id, el) {
  pinned = pinned === id ? null : id;
  showCard(pinned ? id : null, el);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pinned) { pinned = null; showCard(null); } });
document.addEventListener("click", (e) => {
  if (pinned && !e.target.closest("#card") && !e.target.closest("g.token")) { pinned = null; showCard(null); }
});
window.addEventListener("scroll", () => { if (!pinned) select("#card").attr("hidden", ""); }, { passive: true });

// The HTML panels whose rows can reorder or move between lists: drawn together so
// one FLIP pass glides every row and agent ring from its old place to its new one.
function renderPanels(now, duration) {
  const page = document.querySelector(".dash");
  const before = page ? capture(page) : null;
  const agentsEl = document.getElementById("agents");
  cardsView.duration(reduceMotion ? 0 : duration).width(Math.max(220, (agentsEl.clientWidth || 300)));
  select(agentsEl).datum({ data: agentCardsData(model, { now }), partName: (id) => model.byId.get(id)?.name ?? id, now }).call(cardsView);
  select("#todos").datum(model).call(todos);
  select("#todos").selectAll("li.todo").attr("data-flip", (t) => `todo:${t.key}`);
  select("#feed").datum(model).call(feed);
  select("#feed").selectAll("li.ev").attr("data-flip", (e) => `ev:${e._i}`);
  select("#agent-count").text(`${model.agents.filter((a) => a.status === "working" && !a.isPerson).length} working`);
  if (page && !reduceMotion) play(page, before, { duration: duration || 0 });
  if (hover) applyHighlight();
}

async function render() {
  if (!state) return;
  const token = ++renderToken;
  const now = Date.now();
  model = buildModel(state, events, { now, coverage });
  const duration = firstRender || reduceMotion ? 0 : 700;
  seenEvents = events.length;
  firstRender = false;

  renderHeader(model, now);


  renderPanels(now, duration);

  select("#todo-count").text(model.todoCounts.total ? `${model.todoCounts.done} of ${model.todoCounts.total} done` : "");
  select("#todo-bar").datum(model.todoCounts).call(todoBar);

  select("#tests").datum({ tests: model.tests, coverage: model.coverage, byId: model.byId, now }).call(testsView);
  select("#cov-bar").datum(model.coverage.bands).call(covBar);

  if (!elk) { showError("The layout library did not load, so the structure map cannot be drawn. Check the internet connection and reload."); return; }
  const next = await layoutForSpace(model);
  if (token !== renderToken) return; // a newer render started while ELK was working; drop this one
  layout = next;
  const host = select("#map");
  host.selectAll("p.empty").data(layout.nodes.length ? [] : [null]).join("p").attr("class", "empty")
    .text("No structure yet. Claude adds the app's parts under structure: as it learns them.");
  map.duration(duration).lens(lens).coverageSource(model.coverage.source);
  host.datum(layout).call(map);
  // Fit the map to its column on wide screens, but never blow it up past its natural size.
  // Narrow screens scroll the map at full size instead (text would drop under 10px), so the caps come off there.
  const fitting = wide?.matches;
  host.select("svg.map")
    .style("max-width", fitting ? `min(100%, ${layout.width + 12}px)` : null)
    .style("max-height", fitting ? `min(100%, ${layout.height + 26}px)` : null);
  applyHighlight();
  revealFocus(layout, model.focus);
}

// On a wide screen the map must fit its column, so lay it out both top-down and
// left-to-right and keep whichever is drawn larger. The current direction is kept
// unless the other is clearly better, so the map does not flip on small changes.
let direction = "DOWN";
const wide = window.matchMedia?.("(min-width: 1100px)");
async function layoutForSpace(m) {
  const opts = { elk, collapsed, expanded };
  const box = document.querySelector(".map-scroll");
  if (!wide?.matches || !box || !box.clientHeight) return layoutStructure(m, { ...opts, direction: "DOWN" });
  const [down, right] = await Promise.all([layoutStructure(m, { ...opts, direction: "DOWN" }), layoutStructure(m, { ...opts, direction: "RIGHT" })]);
  const fit = (l) => Math.min(box.clientWidth / (l.width + 12), box.clientHeight / (l.height + 26));
  const [cur, other] = direction === "DOWN" ? [down, right] : [right, down];
  if (fit(other) > fit(cur) * 1.15) direction = direction === "DOWN" ? "RIGHT" : "DOWN";
  return direction === "DOWN" ? down : right;
}
// Work / Tests switch for the map: the same boxes, shaded by status or by test coverage.
select(".lens").selectAll("button").on("click", function () {
  lens = this.dataset.lens;
  document.body.classList.toggle("lens-tests", lens === "tests");
  select(".lens").selectAll("button").attr("aria-pressed", function () { return String(this.dataset.lens === lens); });
  render();
});

// The fitted map can get small on a big plan; this button swaps to full size and back.
select("#zoom").on("click", function () {
  const full = !document.body.classList.contains("map-full");
  document.body.classList.toggle("map-full", full);
  select(this).attr("aria-pressed", String(full)).text(full ? "Fit to screen" : "Full size");
});
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { panes.refresh(); render(); }, 200); });
// Dividers between the columns and panels; the map refits once a drag ends.
const panes = splitters(document, { active: () => !!wide?.matches, onChange: () => render() });

// On a narrow screen the map scrolls sideways; bring the focus into view when it
// changes, but leave the person's own scrolling alone otherwise.
let revealed = null;
function revealFocus(l, focus) {
  if (!focus || focus === revealed) return;
  const box = l.nodes.find((n) => n.id === focus);
  const scroller = document.querySelector(".map-scroll");
  if (!box || !scroller || scroller.scrollWidth <= scroller.clientWidth) return;
  revealed = focus;
  scroller.scrollTo({ left: Math.max(0, box.x + box.width / 2 - scroller.clientWidth / 2), behavior: reduceMotion ? "auto" : "smooth" });
}

function renderHeader(model, now) {
  const claim = summarize(model);
  select("#kicker").text(claim.kicker);
  select("#headline").text(claim.headline);
  select("#deck").text(claim.deck);
  select("#updated").text(model.updatedAt ? `Updated ${formatAgo(model.updatedAt, now)}` : "");
  select("#project").text(model.project);
  const p = model.parts;
  select("#num-parts").text(p.total ? `${Math.round((100 * p.done) / p.total)}%` : "–");
  select("#num-parts-note").text(p.total ? `of ${p.total} parts done` : "no parts yet");
  select("#num-todos").text(model.todoCounts.total ? `${model.todoCounts.done}/${model.todoCounts.total}` : "–");
  select("#num-agents").text(model.agents.filter((a) => a.status === "working").length);
  const t = model.tests;
  select("#num-tests")
    .attr("class", t.status === "failing" ? "bad" : t.status === "running" ? "hot" : "ok")
    .text(t.status === "failing" ? (t.failed ? `✕ ${t.failed}` : "✕") : t.status === "running" ? "…" : t.passed != null ? `✓ ${t.passed}` : "–");
  select("#num-tests-note").text(t.status === "failing" ? "tests failing" : t.status === "running" ? "tests running" : t.status === "passing" ? "tests passing" : "no test runs yet");
  select("#parts-bar").datum(p).call(partsBar);

  const crumbs = model.focusPath.map((id) => model.byId.get(id).name);
  select("#crumb").selectAll("span")
    .data(crumbs.length ? crumbs : ["No focus set"])
    .join("span")
    .classed("here", (d, i, all) => crumbs.length > 0 && i === all.length - 1)
    .text((d) => d);
  select("#thought").text(model.thinking || "Nothing written yet.");
}

function setConn(kind, text) {
  select("#conn").attr("class", `conn conn-${kind}`);
  select("#conn-text").text(text);
}
function showError(msg) { select("#error").attr("hidden", msg ? null : "").text(msg || ""); }

async function fetchText(url) {
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

// Every source (project files, the artifact database, files over http) hands in raw
// texts; the state and coverage come from the first source that has them, and the
// event logs of all of them merge into one timeline.
const ORDER = ["files", "db", "http"];
const sources = {};
const logs = {}; // source -> { text, list }, so an unchanged log is not parsed again
let texts = {}; // the raw texts last applied, so unchanged inputs are not parsed again
let heartbeatMs = null; // the last action any hook logged
let stateSeenAt = null; // when the state text last changed, for states with no `updated` stamp
let connected = false;
function take(name, raw) {
  sources[name] = { ...sources[name], ...raw };
  const pick = (k) => ORDER.map((n) => sources[n]?.[k]).find((v) => typeof v === "string");
  const next = applyTexts({ state, events, coverage, texts }, { state: pick("state"), coverage: pick("coverage") }, parseYaml);
  if (next.texts.state !== texts.state) stateSeenAt = Date.now();
  ({ state, coverage, texts } = next);
  let changed = next.changed;
  let logChanged = false;
  for (const [n, src] of Object.entries(sources)) {
    if (typeof src.events !== "string" || logs[n]?.text === src.events) continue;
    logs[n] = { text: src.events, list: parseEvents(src.events) };
    logChanged = true;
  }
  if (logChanged) {
    const lists = Object.values(logs).map((l) => l.list);
    events = lists.length === 1 ? lists[0] : mergeEvents(lists);
    changed = true;
  }
  const beats = Object.values(sources).map((src) => toMs(String(src.heartbeat ?? "").trim())).filter(Number.isFinite);
  heartbeatMs = beats.length ? Math.max(...beats) : null;
  if (next.error) showError(next.error);
  else if (next.changed) showError("");
  renderLive();
  return changed;
}

// The dot says whether Claude is acting right now (the hooks' heartbeat), and a
// quiet note says when the to-dos have not kept up with what the log shows.
function renderLive(now = Date.now()) {
  if (mode === "demo") return;
  if (!connected) return setConn("off", mode === "starting" ? "Waiting for data" : "Lost connection");
  if (heartbeatMs == null) setConn("live", "Live");
  else if (isLive(heartbeatMs, now)) setConn("live", "Live");
  else setConn("idle", `Idle ${formatAgo(heartbeatMs, now)}`);
  const stateMs = model?.updatedAt ?? stateSeenAt;
  const behind = todosBehind({ heartbeatMs, stateMs, now });
  select("#behind").classed("on", behind)
    .attr("title", behind ? `Claude is working, but the to-dos last changed ${formatAgo(stateMs, now)}` : null);
}
setInterval(() => renderLive(), 5000);

function goLive() {
  connected = true;
  if (mode !== "live") { mode = "live"; firstRender = true; }
}

let dbLive = false; // set once the artifact database serves the state; file polling then stops
let filesLive = false; // set once the project's files are readable; the other sources then only add events
async function poll() {
  if (dbLive || filesLive) return;
  let changed = false;
  try {
    const raw = { state: await fetchText(CFG.state) };
    // Events, coverage and heartbeat are optional: a missing log is empty, a missing report keeps the last one.
    raw.events = await fetchText(CFG.events).catch(() => "");
    raw.coverage = await fetchText(CFG.coverage).catch(() => undefined);
    raw.heartbeat = await fetchText(CFG.heartbeat).catch(() => undefined);
    goLive();
    changed = take("http", raw);
  } catch {
    if (mode === "starting") { startDemo(); return; }
    connected = false;
    renderLive();
  }
  if (changed) render();
  setTimeout(poll, CFG.poll);
}

const within = (p, ms) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(null), ms))]).catch(() => null);

// In a claude.ai project the hooks write straight into a shared project folder,
// and a page that declares the `files` capability reads it there: nobody has to
// push anything for the view to stay current. Every tick reads the small
// heartbeat; only when it changed are the new tail of events.jsonl and
// state.yaml read, so an idle session costs one tiny read per tick.
async function startFiles() {
  if (!CFG.filesDir) return false;
  const files = await within(window.claude?.use?.("files"), 4000);
  if (!files) return false;
  const dir = String(CFG.filesDir).replace(/\/+$/, "");
  const path = (name) => `${dir}/${name}`;
  const text = (r) => new TextDecoder().decode(r.bytes);
  const opt = (p) => p.catch((e) => (e?.code === "not_found" ? null : Promise.reject(e)));
  // The first call asks the viewer for access; a missing or refused folder hands over to the next source.
  let first = await opt(files.read(path("state.yaml"))).catch(() => null);
  if (!first) { await new Promise((r) => setTimeout(r, 1500)); first = await opt(files.read(path("state.yaml"))).catch(() => null); }
  if (!first) return false;
  filesLive = true;
  goLive();
  let beat = null; // the heartbeat's revision last seen
  let known = null; // bytes of events.jsonl read so far
  let log = "";
  let decoder = new TextDecoder();
  let fresh = ""; // the text the last read added
  async function readLog() {
    let r = await opt(files.read(path("events.jsonl"), { offset: known ?? 0 })).catch((e) => {
      if (e?.code === "bad_request") return null; // an offset past the end: the log was trimmed
      throw e;
    });
    if (!r) { known = null; r = await opt(files.read(path("events.jsonl"))); if (!r) return ""; }
    const plan = tailRead(known, r.size);
    if (plan?.reset && known != null) { known = null; return readLog(); }
    if (plan?.reset) { log = ""; decoder = new TextDecoder(); }
    // stream: a character cut at the end of one read is finished by the next.
    fresh = decoder.decode(r.bytes, { stream: true });
    log += fresh;
    known = (plan?.offset ?? known) + r.bytes.length;
    return log;
  }
  async function tick(stateRead) {
    let wait = CFG.filesPoll;
    try {
      const hb = await opt(files.read(path("heartbeat")));
      // No heartbeat (an older hook): read on every tick.
      if (stateRead || !hb || hb.revision !== beat) {
        beat = hb?.revision ?? null;
        const raw = { heartbeat: hb ? text(hb) : undefined };
        const st = stateRead ?? await opt(files.read(path("state.yaml")));
        if (st) raw.state = text(st);
        const startup = known == null;
        raw.events = await readLog();
        // Coverage only changes after a test run, so it is read when the new tail mentions one.
        if (startup || /"type":\s*"test"/.test(fresh)) {
          const cov = await opt(files.read(path("coverage.json")));
          if (cov) raw.coverage = text(cov);
        }
        connected = true;
        if (take("files", raw)) render();
      }
    } catch (e) {
      if (e?.code === "not_granted") { filesLive = false; poll(); return; } // hand over; never ask again
      if (e?.code === "rate_limited") wait = Math.max(wait, e.retryAfterMs ?? 5000);
      else if (e?.code === "changed") wait = 250; // caught mid-write; read again soon
      else { connected = false; renderLive(); }
    }
    setTimeout(() => tick(), wait);
  }
  tick(first);
  return true;
}

// On claude.ai a page's own files only change with a new artifact version, and a
// new version reloads every open view. So when the artifact database is there,
// the state lives in one document ({ state, events, coverage } as text) and
// updates arrive live with no reload. serve.py and other hosts have no database
// and keep polling files.
async function startDb() {
  const db = await within(window.claude?.use?.("db"), 4000);
  if (!db) return false;
  let answered = false;
  let fellBack = false;
  const timer = setTimeout(() => { if (!answered && !filesLive) setConn("off", "Waiting for data"); }, 10000);
  db.doc(CFG.dbDoc).onSnapshot((snap) => {
    if (!snap.metadata?.fromCache) { answered = true; clearTimeout(timer); }
    if (!snap.exists) {
      // No live document yet: show the published files (or the demo) until one appears.
      if (!fellBack && mode === "starting" && !filesLive) { fellBack = true; poll(); }
      return;
    }
    dbLive = true;
    goLive();
    if (take("db", snap.data() || {})) render();
  }, () => { clearTimeout(timer); if (!filesLive) { connected = false; renderLive(); } });
  return true;
}

// Re-render now and then even without changes, so heat cools and "ago" labels age.
setInterval(() => { if (state) render(); }, 15000);

function startDemo() {
  mode = "demo";
  setConn("demo", "Demo data");
  const baseState = document.getElementById("demo-state").textContent;
  const baseEvents = document.getElementById("demo-events").textContent;
  try { coverage = JSON.parse(document.getElementById("demo-coverage").textContent); } catch { coverage = null; }
  let step = 0;
  const reset = () => {
    state = parseYaml(baseState);
    const parsed = parseEvents(baseEvents);
    const last = parsed.length ? parsed[parsed.length - 1]._t : Date.now();
    const shift = Date.now() - 4000 - last; // make the sample log end a few seconds ago
    events = parsed.map((e) => ({ ...e, _t: e._t + shift, t: new Date(e._t + shift).toISOString() }));
    state.updated = new Date().toISOString();
    step = 0;
    seenEvents = 0;
    firstRender = true;
    for (const s of [collapsed, expanded, todoCollapsed, todoExpanded]) s.clear();
    render();
  };
  reset();
  setInterval(() => {
    if (step >= DEMO_SCRIPT.length) { reset(); return; }
    const { patch, ...ev } = DEMO_SCRIPT[step++];
    if (patch) { state = structuredClone(state); patch(state); state.updated = new Date().toISOString(); }
    events = [...events, { ...ev, t: new Date().toISOString(), _t: Date.now(), _i: events.length }];
    render();
  }, 2800);
}

// Sources in order: the project's files, then the artifact database, then files over http.
// The database still runs beside the files, because events Claude writes there join the timeline.
if (location.protocol === "file:") startDemo();
else startFiles().then(async (files) => { const db = await startDb(); if (!files && !db) poll(); });
