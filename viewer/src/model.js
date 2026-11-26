// Pure data logic for the Claude GUI viewer. Nothing in this file touches the
// DOM, the clock or randomness: every function takes its inputs (including
// `now`) and returns plain objects, so it can be tested in Node.
import { path as d3path, max, pairs, cumsum, bisectLeft } from "d3";

export const NODE_STATUSES = ["active", "planned", "idea", "blocked", "done", "untouched"];
export const TEST_STATUSES = ["failing", "running", "passing", "not_run"];
export const TODO_STATUSES = ["in_progress", "blocked", "pending", "done"];
export const DEP_KINDS = ["calls", "data", "events"];

/**
 * Converts a path glob to a RegExp. `**` matches across folders, `*` within one
 * folder, `?` one character. The match is anchored at the end and at a folder
 * boundary at the start, so `src/**` matches both `src/a.ts` and
 * `/home/me/repo/src/a.ts`.
 */
export function globToRe(glob) {
  let s = "";
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        s += ".*";
        i++;
        if (g[i + 1] === "/") i++; // `a/**/b` also matches `a/b`
      } else s += "[^/]*";
    } else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("(^|/)" + s + "$");
}

/** Returns epoch milliseconds for an ISO-like time, or null when missing or invalid. */
export function toMs(t) {
  if (t == null || t === "") return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Takes new raw texts for the three inputs (state.yaml, events.jsonl,
 * coverage.json) and returns what the page should hold next. A field that is
 * not a string (missing from a database document, a 404) leaves that input as
 * it was. A state or coverage text that does not parse keeps the last good
 * value, because Claude may be halfway through writing it.
 *
 * prev   { state, events, coverage, texts: { state, events, coverage } }
 * texts  { state, events, coverage }, each a string or absent
 * parse  YAML parser (js-yaml's load), passed in to keep this module free of it
 * Returns { ...next, changed, error } where error is a one-line message or null.
 */
export function applyTexts(prev, texts = {}, parse) {
  const next = { state: prev.state ?? null, events: prev.events ?? [], coverage: prev.coverage ?? null, texts: { ...(prev.texts ?? {}) } };
  let changed = false;
  let error = null;
  const { state: st, events: ev, coverage: cov } = texts ?? {};
  if (typeof st === "string" && st !== next.texts.state) {
    next.texts.state = st;
    try {
      const parsed = parse(st);
      if (!parsed || typeof parsed !== "object") throw new Error("the file is empty");
      next.state = parsed;
      changed = true;
    } catch (err) {
      error = `state.yaml did not parse, so the last good version is shown. ${String(err?.message || err).split("\n")[0]}`;
    }
  }
  if (typeof ev === "string" && ev !== next.texts.events) {
    next.texts.events = ev;
    next.events = parseEvents(ev);
    changed = true;
  }
  if (typeof cov === "string" && cov !== next.texts.coverage) {
    try {
      next.coverage = cov.trim() ? JSON.parse(cov) : null;
      next.texts.coverage = cov;
      changed = true;
    } catch { /* a half-written report: keep the last good one and try again next time */ }
  }
  return { ...next, changed, error };
}

/**
 * Parses the JSON Lines event log. Blank and broken lines are skipped, because
 * the last line can be half-written while a hook is appending to it.
 * Returns new objects with `_i` (position) and `_t` (epoch ms or null).
 * Options: `maxLines` keeps only the tail of a long log.
 */
export function parseEvents(text, { maxLines = 3000 } = {}) {
  const out = [];
  for (const line of String(text ?? "").split("\n").slice(-maxLines)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e;
    try { e = JSON.parse(trimmed); } catch { continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    out.push(e);
  }
  return out.map((e, i) => ({ ...e, _i: i, _t: toMs(e.t) }));
}

/** `uses` entries may be an id string or { to, kind, weight }. */
function normalizeUse(u) {
  const to = typeof u === "object" && u ? u.to : u;
  if (to == null || to === "") return null;
  const weight = Number(typeof u === "object" ? u.weight : 1);
  return {
    to: String(to),
    kind: typeof u === "object" && DEP_KINDS.includes(u.kind) ? u.kind : "calls",
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
  };
}

/** Copies the `structure` section into a clean tree with unique string ids. */
function normalizeStructure(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const byId = new Map();
  const parentOf = new Map();
  const matchers = [];
  const walk = (items, parentId, depth) => {
    const out = [];
    for (const n of items || []) {
      if (!n || typeof n !== "object" || n.id == null) continue;
      const id = String(n.id);
      if (byId.has(id)) continue; // keys must stay unique for the joins
      const node = {
        id,
        name: String(n.name ?? id),
        status: NODE_STATUSES.includes(n.status) ? n.status : "untouched",
        note: n.note == null ? null : String(n.note),
        paths: [].concat(n.paths ?? []).map(String),
        uses: [].concat(n.uses ?? []).map(normalizeUse).filter(Boolean),
        coverage: toFraction(n.coverage), // Claude's own estimate, used when no coverage report covers the part
        // Where this part came from while the plan was reshaped: split off from, or merged out of, these ids.
        from: [].concat(n.from ?? n.split_from ?? []).filter((f) => f != null).map(String),
        children: [],
      };
      byId.set(id, node);
      parentOf.set(id, parentId);
      for (const p of node.paths) matchers.push({ id, depth, re: globToRe(p) });
      node.children = walk(Array.isArray(n.children) ? n.children : [], id, depth + 1);
      out.push(node);
    }
    return out;
  };
  const roots = walk(list, null, 0);
  matchers.sort((a, b) => b.depth - a.depth); // deepest match wins
  return { roots, byId, parentOf, matchers };
}

// Every key the state format uses. Anything else with an empty value is a fragment of text
// that YAML split off at a comma, e.g. `{ name: Words (a, b) }` in flow style.
const KNOWN_KEYS = new Set(["version", "project", "updated", "session", "goal", "phase", "focus", "thinking", "structure", "id", "name",
  "status", "paths", "note", "children", "uses", "to", "kind", "weight", "from", "split_from", "coverage", "agents", "role", "about",
  "task", "nodes", "skills", "description", "tests", "suites", "passed", "failed", "failures", "test", "cause", "error", "todos",
  "text", "owner", "node"]);
const TEXT_KEYS = ["name", "text", "task", "about", "note", "thinking", "cause", "description", "goal"];

/**
 * Undoes YAML's comma splits: an unknown key with no value is glued back onto the
 * text field before it, so `{ name: IndexedDB (words, sightings) }` reads
 * "IndexedDB (words, sightings)" instead of "IndexedDB (words". Returns a copy;
 * objects without fragments are returned as they are.
 */
export function repairCommaSplits(value) {
  if (Array.isArray(value)) {
    const out = value.map(repairCommaSplits);
    return out.every((v, i) => v === value[i]) ? value : out;
  }
  if (!value || typeof value !== "object") return value;
  let changed = false;
  const out = {};
  let lastText = null;
  for (const [k, v] of Object.entries(value)) {
    if (v == null && !KNOWN_KEYS.has(k) && lastText) {
      out[lastText] = `${out[lastText]}, ${k}`;
      changed = true;
      continue;
    }
    const r = repairCommaSplits(v);
    if (r !== v) changed = true;
    out[k] = r;
    // Fragments always follow their text directly, so any other key ends the run.
    lastText = TEXT_KEYS.includes(k) && typeof r === "string" ? k : null;
  }
  return changed ? out : value;
}

/**
 * Merges the state snapshot with the event log into everything the views draw.
 *
 * state   parsed state.yaml (any shape; missing sections are treated as empty)
 * events  output of parseEvents
 * options now (ms), workingWindow (s an agent counts as working after its last
 *         event), heatHalfLife (s for a part's edit heat to halve)
 */
export function buildModel(state, events = [], { now = 0, workingWindow = 90, heatHalfLife = 60, coverage = null } = {}) {
  const s = state && typeof state === "object" ? repairCommaSplits(state) : {};
  const session = s.session && typeof s.session === "object" ? s.session : {};
  const { roots, byId, parentOf, matchers } = normalizeStructure(s.structure);

  const nodeForEvent = (e) => {
    if (e.node != null && byId.has(String(e.node))) return String(e.node);
    if (!e.target) return null;
    const target = String(e.target).replace(/\\/g, "/");
    const m = matchers.find((m) => m.re.test(target));
    return m ? m.id : null;
  };

  const agentMap = new Map();
  for (const a of [].concat(s.agents ?? [])) {
    if (!a || typeof a !== "object" || a.id == null) continue;
    const id = String(a.id);
    if (agentMap.has(id)) continue;
    agentMap.set(id, {
      id,
      name: String(a.name ?? id),
      role: a.role == null ? null : String(a.role),
      task: a.task == null ? null : String(a.task),
      declaredStatus: a.status == null ? null : String(a.status),
      nodes: [].concat(a.nodes ?? []).map(String),
      about: a.about == null ? null : String(a.about),
      skills: normalizeSkills(a.skills),
      last: null,
      lastEvent: null,
      lastNode: null,
    });
  }
  const ensureAgent = (id) => {
    id = String(id);
    if (!agentMap.has(id)) {
      agentMap.set(id, { id, name: id === "user" ? "You" : id, role: null, task: null, declaredStatus: null, nodes: [], about: null, skills: [], last: null, lastEvent: null, lastNode: null });
    }
    return agentMap.get(id);
  };
  ensureAgent("main");

  const heat = new Map();
  const nodeAgents = new Map();
  const edgeMap = new Map();
  const addNodeAgent = (nodeId, agentId) => {
    if (!nodeAgents.has(nodeId)) nodeAgents.set(nodeId, new Set());
    nodeAgents.get(nodeId).add(agentId);
  };

  const annotated = events.map((e) => {
    const node = nodeForEvent(e);
    if (e.agent == null) return { ...e, node };
    const agent = ensureAgent(e.agent);
    if (e.to != null) ensureAgent(e.to);
    const t = e._t;
    if (t != null && (agent.last == null || t >= agent.last)) { agent.last = t; agent.lastEvent = e; }
    if (node && t != null && (agent.lastNode == null || t >= agent.lastNode.t)) agent.lastNode = { id: node, t };
    if (node && t != null) {
      const age = Math.max(0, (now - t) / 1000); // events stamped in the future count as now
      const weight = Math.pow(0.5, age / heatHalfLife) * (e.type === "edit" ? 1 : 0.5);
      heat.set(node, (heat.get(node) || 0) + weight);
      if (age < workingWindow * 2) addNodeAgent(node, agent.id);
    }
    if (e.to != null && String(e.to) !== String(e.agent)) {
      const [source, target] = [String(e.agent), String(e.to)].sort();
      const key = source + "|" + target;
      const edge = edgeMap.get(key) || { key, source, target, count: 0, last: null };
      edge.count++;
      if (t != null) edge.last = Math.max(edge.last ?? t, t);
      edgeMap.set(key, edge);
    }
    return { ...e, node };
  });

  const agents = [...agentMap.values()].map((a) => {
    const isPerson = a.id === "user";
    const age = a.last == null ? Infinity : (now - a.last) / 1000;
    const type = a.lastEvent?.type;
    let status = a.declaredStatus;
    if (!status) {
      if (isPerson) status = "person";
      else if (type === "done") status = "done";
      else if (type === "stop") status = "idle";
      // With no events at all, trust state.yaml: an agent placed on a part is working on it.
      else if (a.last == null && a.nodes.some((n) => byId.has(n))) status = "working";
      else status = age < workingWindow ? "working" : "idle";
    }
    // Where the agent stands on the map: the part it touched most recently, else the first part it was given.
    // Idle and finished agents stand nowhere, so the map parks them aside.
    let at = null;
    if (status === "working") {
      const recent = a.lastNode && (now - a.lastNode.t) / 1000 < workingWindow * 2 ? a.lastNode.id : null;
      at = recent ?? a.nodes.find((n) => byId.has(n)) ?? null;
    }
    let task = a.task;
    if (!task && a.lastEvent) task = a.lastEvent.text || (a.lastEvent.target ? `${a.lastEvent.type} ${a.lastEvent.target}` : null);
    if (status !== "done") for (const n of a.nodes) if (byId.has(n)) addNodeAgent(n, a.id);
    return {
      id: a.id, name: a.name, role: a.role, task: task ?? null, status, isPerson,
      initials: initials(a.name), last: a.last, at, nodes: a.nodes.filter((n) => byId.has(n)),
      about: a.about, skills: a.skills,
      lastAction: a.lastEvent ? { type: a.lastEvent.type, target: a.lastEvent.target ?? null, text: a.lastEvent.text ?? null, to: a.lastEvent.to ?? null, t: a.lastEvent._t } : null,
    };
  });

  const edges = [...edgeMap.values()].map((e) => ({ ...e, recent: e.last != null && (now - e.last) / 1000 < workingWindow }));

  const todos = normalizeTodos(s.todos, byId);
  const todoLeaves = flattenTodos(todos, { collapsed: null }).filter((r) => !r.children.length);
  const todoCounts = { total: todoLeaves.length };
  for (const st of TODO_STATUSES) todoCounts[st] = todoLeaves.filter((t) => t.status === st).length;

  const deps = [];
  for (const n of byId.values()) {
    for (const u of n.uses) if (byId.has(u.to) && u.to !== n.id) deps.push({ from: n.id, to: u.to, kind: u.kind, weight: u.weight });
  }

  const focus = session.focus != null && byId.has(String(session.focus)) ? String(session.focus) : null;
  const focusPath = [];
  for (let id = focus; id; id = parentOf.get(id)) focusPath.unshift(id);

  const lastEventTime = max(annotated, (e) => e._t);
  const stamps = [toMs(s.updated), lastEventTime].filter((x) => x != null);

  const tests = buildTests(s.tests, annotated, byId, { now });
  // A part whose test files Claude has written counts as tested even before a suite names it.
  const testFileNodes = new Set(annotated
    .filter((e) => e.node && (e.type === "edit" || e.type === "write") && TEST_FILE.test(String(e.target ?? "")))
    .map((e) => e.node));
  const cov = buildCoverage(coverage, roots, matchers, tests, testFileNodes);

  return {
    project: String(s.project ?? "Claude Work View"),
    goal: session.goal == null ? null : String(session.goal),
    phase: session.phase == null ? null : String(session.phase),
    thinking: session.thinking == null ? null : String(session.thinking).trim(),
    focus,
    focusPath,
    updatedAt: stamps.length ? Math.max(...stamps) : null,
    structure: roots,
    byId,
    parentOf,
    heat,
    nodeAgents,
    agents,
    edges,
    events: annotated,
    todos,
    todoCounts,
    deps,
    parts: partCounts(roots),
    tests,
    coverage: cov,
  };
}

/** 0.84, 84 and "84%" all mean 84%. Anything else is null. */
export function toFraction(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : +v;
  if (!Number.isFinite(n) || n < 0) return null;
  const f = typeof v === "string" && v.trim().endsWith("%") ? n / 100 : n > 1 ? n / 100 : n;
  return Math.min(1, f);
}

export const COVERAGE_BANDS = ["good", "partial", "low", "tested", "untested"];
export const COVERAGE_LABEL = { good: "80%+ covered", partial: "50–80%", low: "Under 50%", tested: "Tested, no %", untested: "No tests" };

/** Paths that look like test files: test/ or spec/ dirs, *.test.ts, *_test.go, test_*.py. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|(^|\/)test_[^/]*\.py$/;

/**
 * How well each part is tested. Line counts come from the coverage report the
 * hook saved (files matched to parts by their `paths`, deepest glob wins);
 * a part with no matching files falls back to its own `coverage:` estimate.
 * A part is "tested" if it has line data, a suite lists it, or Claude wrote
 * test files for it.
 *
 * raw            parsed .claude-gui/coverage.json: { t, source, files: { path: [covered, total] } }
 * testFileNodes  ids of parts that test files were written for (from events)
 * Returns { source, t, covered, total, pct, byNode, bands } where byNode maps
 * every part id (groups too, summed over their leaves) to
 * { covered, total, pct, tested, band }, and bands counts leaves per band.
 */
export function buildCoverage(raw, roots = [], matchers = [], tests = null, testFileNodes = new Set()) {
  const files = raw && typeof raw === "object" && raw.files && typeof raw.files === "object" ? raw.files : {};
  const lines = new Map();
  for (const [path, v] of Object.entries(files)) {
    const [c, t] = Array.isArray(v) ? v : [v?.covered, v?.total];
    if (!(+t > 0)) continue;
    const m = matchers.find((x) => x.re.test(String(path).replace(/\\/g, "/")));
    if (!m) continue;
    const cur = lines.get(m.id) || { covered: 0, total: 0, files: 0 };
    lines.set(m.id, { covered: cur.covered + Math.min(+c || 0, +t), total: cur.total + +t, files: cur.files + 1 });
  }
  const suiteNodes = new Set([...(tests?.suites ?? []).flatMap((s) => s.nodes), ...testFileNodes]);
  const byNode = new Map();
  const bands = Object.fromEntries(COVERAGE_BANDS.map((b) => [b, 0]));
  const band = (pct, tested) => (pct == null ? (tested ? "tested" : "untested") : pct >= 0.8 ? "good" : pct >= 0.5 ? "partial" : "low");

  // Returns a node's summed lines. Lines on a group's own paths count toward the group only
  // when none of its children claim them, which the deepest-match rule already ensures.
  const walk = (n) => {
    if (!n.children.length) {
      const own = lines.get(n.id);
      let covered = own?.covered ?? null;
      let total = own?.total ?? null;
      let estimated = false;
      if (total == null && n.coverage != null) { covered = n.coverage; total = 1; estimated = true; }
      const pct = total ? covered / total : null;
      const tested = pct != null || suiteNodes.has(n.id);
      const r = { covered, total, pct, tested, estimated, band: band(pct, tested), leaves: 1, files: own?.files ?? 0 };
      bands[r.band]++;
      byNode.set(n.id, r);
      return r;
    }
    const kids = n.children.map(walk);
    const own = lines.get(n.id);
    // Estimates count as one leaf-weight unit, report lines as lines; mixing them weights by leaf.
    const measured = kids.filter((k) => k.total);
    let covered = 0, total = 0;
    for (const k of measured) { covered += k.estimated ? k.covered : k.covered / k.total; total += 1; }
    if (own) { covered += own.covered / own.total; total += 1; }
    const pct = total ? covered / total : null;
    const tested = kids.some((k) => k.tested) || suiteNodes.has(n.id);
    const r = { covered: null, total: null, pct, tested, estimated: false, band: band(pct, tested), leaves: kids.reduce((a, k) => a + k.leaves, 0) };
    byNode.set(n.id, r);
    return r;
  };
  roots.forEach(walk);

  let covered = 0, total = 0;
  for (const v of lines.values()) { covered += v.covered; total += v.total; }
  const leafPcts = [...byNode.entries()].filter(([, v]) => v.leaves === 1 && v.pct != null).map(([, v]) => v.pct);
  return {
    source: raw?.source ?? null,
    t: raw?.t ? toMs(raw.t) : null,
    covered, total,
    // Overall: the report's own line ratio when there is one, else the mean of the parts' estimates.
    pct: total ? covered / total : leafPcts.length ? leafPcts.reduce((a, b) => a + b, 0) / leafPcts.length : null,
    byNode,
    bands: { ...bands, total: COVERAGE_BANDS.reduce((a, b) => a + bands[b], 0) },
  };
}

/**
 * Test suites (Claude's account in state.yaml: what each covers and why it
 * fails) merged with test runs (logged by the hook from test commands).
 *
 * raw     state.tests: a list of { id, name, nodes, passed, failed, status,
 *         failures: [{ name, node, cause, error }] }, or { suites: [...] }
 * events  annotated events; type "test" carries ok/passed/failed/failures and
 *         type "test_start" marks a run in progress
 * Returns { suites, runs, latest, running, status, passed, failed, untraced, byNode }.
 * A green run newer than everything clears the failures Claude wrote, since
 * the run is the fresher fact; a red run leaves Claude's diagnosis in place.
 */
export function buildTests(raw, events = [], byId = new Map(), { runningWindow = 600, now = 0 } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.suites) ? raw.suites : [];
  const num = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.max(0, Math.round(+v)) : null);
  const known = (id) => (id != null && byId.has(String(id)) ? String(id) : null);

  const runs = [];
  let startedAt = null;
  for (const e of [...events].filter((e) => e.type === "test" || e.type === "test_start").sort((a, b) => (a._t ?? 0) - (b._t ?? 0))) {
    if (e.type === "test_start") { startedAt = e._t ?? null; continue; }
    const failed = num(e.failed);
    const failures = [].concat(e.failures ?? []).map(String);
    const ok = e.ok == null ? !(failed || failures.length) : Boolean(e.ok);
    runs.push({ i: e._i, t: e._t ?? null, agent: e.agent == null ? null : String(e.agent), target: e.target ?? null,
      ok, passed: num(e.passed), failed: failed ?? (ok ? 0 : failures.length || null), failures, text: e.text ?? null,
      coverage: toFraction(e.coverage) });
    startedAt = null;
  }
  const latest = runs.length ? runs[runs.length - 1] : null;
  const running = startedAt != null && (!now || (now - startedAt) / 1000 < runningWindow);
  const cleared = Boolean(latest?.ok); // the newest run passed: earlier failures are fixed

  const seen = new Set();
  const suites = [];
  for (const [i, t] of list.entries()) {
    if (!t || typeof t !== "object") continue;
    const id = String(t.id ?? t.name ?? `suite-${i}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const nodes = [].concat(t.nodes ?? t.node ?? []).map(known).filter(Boolean);
    const failures = cleared ? [] : [].concat(t.failures ?? []).filter((f) => f != null).map((f, j) => {
      const o = typeof f === "object" ? f : { name: f };
      return {
        key: `${id}/${j}`, suite: id, name: String(o.name ?? o.test ?? `Failure ${j + 1}`),
        node: known(o.node), cause: o.cause == null ? null : String(o.cause), error: o.error == null ? null : String(o.error),
      };
    });
    const passed = num(t.passed);
    let failed = cleared ? 0 : num(t.failed);
    if (failed == null) failed = failures.length;
    const declared = TEST_STATUSES.includes(t.status) ? t.status : null;
    // A green run only vouches for suites known to have run; one marked not_run stays that way.
    const ranBefore = declared !== "not_run" && (passed != null || num(t.failed) != null || [].concat(t.failures ?? []).length > 0);
    const status = cleared && ranBefore ? "passing" : declared && !(declared === "passing" && failed) ? declared
      : failed ? "failing" : passed != null ? "passing" : "not_run";
    suites.push({ id, name: String(t.name ?? id), nodes, passed, failed, failures, status, note: t.note == null ? null : String(t.note) });
  }

  // Failing names from the newest run that no suite explains yet: shown as "not traced to a part".
  const explained = suites.flatMap((s) => s.failures.map((f) => f.name.toLowerCase()));
  const untraced = latest && !latest.ok
    ? latest.failures.filter((n) => !explained.some((x) => n.toLowerCase().includes(x) || x.includes(n.toLowerCase())))
    : [];

  const passed = latest?.passed ?? (suites.some((s) => s.passed != null) ? suites.reduce((a, s) => a + (s.passed ?? 0), 0) : null);
  const failed = latest ? (latest.failed ?? (latest.ok ? 0 : null)) : suites.reduce((a, s) => a + s.failed, 0);
  const status = running ? "running"
    : latest ? (latest.ok ? "passing" : "failing")
    : suites.some((s) => s.status === "failing") ? "failing"
    : suites.some((s) => s.status === "passing") ? "passing" : "not_run";

  // Where failures live on the map: a failure's own part, else the parts its suite covers.
  const byNode = new Map();
  const add = (node, key) => { if (!byNode.has(node)) byNode.set(node, new Set()); byNode.get(node).add(key); };
  for (const s of suites) {
    for (const f of s.failures) for (const n of f.node ? [f.node] : s.nodes) add(n, f.key);
    if (s.status === "failing" && !s.failures.length) for (const n of s.nodes) add(n, s.id);
  }
  return { suites, runs, latest, running, status, passed, failed, untraced, byNode };
}

/** Skills may be names or { name, description }. Returns [{ name, description }] without duplicates. */
export function normalizeSkills(raw) {
  const seen = new Set();
  const out = [];
  for (const s of [].concat(raw ?? [])) {
    const name = typeof s === "object" && s ? s.name : s;
    if (name == null || name === "" || seen.has(String(name))) continue;
    seen.add(String(name));
    out.push({ name: String(name), description: typeof s === "object" && s.description != null ? String(s.description) : null });
  }
  return out;
}

/** Up to two letters for an agent chip: "Explorer" -> "Ex", "Code Reviewer" -> "CR". */
export function initials(name) {
  const words = String(name ?? "").trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

/** Counts leaf parts by status, for the overview bar and the headline. */
export function partCounts(roots) {
  const counts = { total: 0 };
  for (const st of NODE_STATUSES) counts[st] = 0;
  const walk = (n) => {
    if (n.children.length) n.children.forEach(walk);
    else { counts.total++; counts[n.status]++; }
  };
  roots.forEach(walk);
  return counts;
}

/**
 * Normalizes todos into a tree. A todo may hold sub-todos under `children`
 * (or `subtasks`). A parent with no status of its own takes it from its
 * children: done when all are done, in progress when any is, blocked when any
 * is blocked and none is moving, pending otherwise. Siblings sort by status.
 */
export function normalizeTodos(raw, byId = new Map(), prefix = "") {
  const list = [].concat(raw ?? []).filter((t) => t && typeof t === "object");
  const seen = new Set();
  return list.map((t, i) => {
    let key = t.id != null ? String(t.id) : `${prefix}#${i}`;
    if (seen.has(key)) key = `${key}#${i}`; // duplicate ids would break keyed joins
    seen.add(key);
    const children = normalizeTodos(t.children ?? t.subtasks, byId, `${key}/`);
    let status = TODO_STATUSES.includes(t.status) ? t.status : null;
    if (!status && children.length) {
      const st = new Set(children.map((c) => c.status));
      status = st.size === 1 && st.has("done") ? "done" : st.has("in_progress") ? "in_progress" : st.has("blocked") ? "blocked" : "pending";
    }
    const leaves = children.length ? todoLeafCount(children) : null;
    return {
      key,
      text: String(t.text ?? t.id ?? ""),
      note: t.note == null ? null : String(t.note),
      status: status ?? "pending",
      owner: t.owner == null ? null : String(t.owner),
      node: t.node != null && byId.has(String(t.node)) ? String(t.node) : null,
      index: i,
      children,
      progress: leaves,
    };
  }).sort((a, b) => TODO_STATUSES.indexOf(a.status) - TODO_STATUSES.indexOf(b.status) || a.index - b.index);
}
function todoLeafCount(items) {
  let done = 0, total = 0;
  const walk = (t) => { if (t.children.length) t.children.forEach(walk); else { total++; if (t.status === "done") done++; } };
  items.forEach(walk);
  return { done, total };
}

/**
 * Turns the todo tree into rows for a list, depth first, with `depth` and
 * `parent`. Children of keys in `collapsed` are left out. By default, finished
 * parents are collapsed; pass `collapsed: null` to include every row.
 */
export function flattenTodos(todos, { collapsed = undefined, expanded = new Set() } = {}) {
  const rows = [];
  const walk = (items, depth, parent) => {
    for (const t of items) {
      const folded = collapsed === null ? false
        : collapsed?.has(t.key) ? true
        : expanded.has(t.key) ? false
        : t.children.length > 0 && t.status === "done";
      rows.push({ ...t, depth, parent, folded: t.children.length > 0 && folded });
      if (t.children.length && !folded) walk(t.children, depth + 1, t.key);
    }
  };
  walk(todos, 0, null);
  return rows;
}

/**
 * The headline finding and the numbers behind it, computed from the model so
 * a test can check them. Returns { kicker, headline, deck }.
 */
export function summarize(model) {
  const p = model.parts;
  const working = model.agents.filter((a) => a.status === "working" && !a.isPerson).length;
  const phase = model.phase ? model.phase.toLowerCase() : null;
  const kicker = ["Live", phase].filter(Boolean).join(" · ");
  if (!p.total) return { kicker, headline: "Waiting for Claude to sketch the app", deck: model.goal ?? "" };
  const t = model.tests;
  const failText = t?.status === "failing"
    ? `${t.failed ? `${t.failed} ${t.failed === 1 ? "test" : "tests"} failing` : "The last test run failed"}`
    : null;
  if (phase === "brainstorming" || phase === "planning") {
    const ideas = p.idea + p.planned;
    return {
      kicker,
      headline: `Sketching the app: ${p.total} ${p.total === 1 ? "part" : "parts"} so far, ${ideas} still ${ideas === 1 ? "an idea" : "ideas"}`,
      deck: [model.goal, "Parts split, merge and move as the plan changes."].filter(Boolean).join(". ").replace(/\.\./g, "."),
    };
  }
  const doneText = `${p.done} of ${p.total} parts done`;
  const focusName = model.focus ? model.byId.get(model.focus).name : null;
  let headline;
  if (phase === "done") headline = `Finished, with ${doneText}`;
  else if (focusName) headline = `Claude is on ${focusName}, with ${doneText}`;
  else if (p.active) headline = `Claude is working on ${p.active} ${p.active === 1 ? "part" : "parts"}, with ${doneText}`;
  else headline = `${doneText[0].toUpperCase()}${doneText.slice(1)}`;
  const agentText = working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "No agents working right now";
  const blocked = p.blocked ? `, ${p.blocked} blocked` : "";
  return { kicker, headline, deck: [model.goal, `${agentText}${blocked}.`, failText ? `${failText}.` : null].filter(Boolean).join(". ").replace(/\.\./g, ".") };
}

/** Counts finished leaves under a node (a leaf counts itself). */
export function leafStats(node) {
  if (!node.children || !node.children.length) return { done: node.status === "done" ? 1 : 0, total: 1 };
  return node.children.reduce((acc, c) => {
    const r = leafStats(c);
    return { done: acc.done + r.done, total: acc.total + r.total };
  }, { done: 0, total: 0 });
}

/**
 * Decides whether a node's children are hidden. The person's own choice wins;
 * otherwise the branch holding the focus stays open and finished branches fold.
 */
export function isFolded(node, { collapsed = new Set(), expanded = new Set(), focusPath = [] } = {}) {
  if (!node.children || !node.children.length) return false;
  if (collapsed.has(node.id)) return true;
  if (expanded.has(node.id) || focusPath.includes(node.id)) return false;
  const st = leafStats(node);
  return st.done === st.total;
}

/** Distinct failures on a part, or on anything under it when it is drawn folded or as a group. */
function failingIn(node, byNode, deep) {
  if (!byNode) return 0;
  const keys = new Set();
  const walk = (n) => { for (const k of byNode.get(n.id) || []) keys.add(k); if (deep) n.children.forEach(walk); };
  walk(node);
  return keys.size;
}

function subtreeHeat(node, heat) {
  return (heat.get(node.id) || 0) + node.children.reduce((a, c) => a + subtreeHeat(c, heat), 0);
}
function subtreeAgents(node, nodeAgents, into = new Set()) {
  for (const a of nodeAgents.get(node.id) || []) into.add(a);
  for (const c of node.children) subtreeAgents(c, nodeAgents, into);
  return into;
}

/**
 * Lays out the structure as nested boxes with dependency arrows, like a module
 * dependency diagram. Uses ELK's layered algorithm, which places dependencies
 * top to bottom and routes edges across nesting levels.
 *
 * Three things keep a busy plan readable:
 * - Finished top-level branches nobody is on float off to a "done" shelf,
 *   beside or under the map (whichever suits `aspect`), as small chips.
 * - Finished parts inside open groups shrink to one-line chips.
 * - A group whose children have no arrows between them packs them in a grid
 *   instead of one long row; arrows to those children land on the group.
 *
 * model    output of buildModel
 * options  elk (an ELK instance; injected so this stays testable in Node),
 *          collapsed / expanded (Sets of ids the person folded or opened),
 *          charWidth, leafHeight, chipHeight, header (px above a container's children),
 *          aspect (width / height of the space the map is drawn in; picks the shelf's side),
 *          shelf, pack (false turns that behaviour off)
 * Returns a Promise of { nodes, edges, tokens, shelf, visibleOf, width, height }, with
 * absolute x/y. Nodes are ordered parents first, so later nodes draw on top.
 * Agents with no part are not drawn on the map (the Agents panel lists them).
 */
export async function layoutStructure(model, {
  elk, collapsed = new Set(), expanded = new Set(), charWidth = 7.4, leafHeight = 52, chipHeight = 30, header = 34, minLeafWidth = 128,
  token = 26, tokenGap = 6, lane = 34, direction = "DOWN", aspect = null, shelf: useShelf = true, pack = true,
} = {}) {
  if (!model.structure.length) return { nodes: [], edges: [], tokens: [], shelf: null, bullpen: null, visibleOf: new Map(), width: 0, height: 0 };
  if (!elk) throw new Error("layoutStructure needs an elk instance");
  const foldOpts = { collapsed, expanded, focusPath: model.focusPath };
  const gap = 10; // between grid cells and shelf chips

  const workers = model.agents.filter((a) => !a.isPerson && a.at);
  const inSubtree = (root, id) => { for (let p = id; p; p = model.parentOf.get(p)) if (p === root.id) return true; return false; };
  const standing = (n, folded) => workers.filter((a) => (folded ? inSubtree(n, a.at) : a.at === n.id)).length;
  const allDone = (n) => { const s = leafStats(n); return s.done === s.total; };

  // A finished top-level branch with nobody on it and nothing failing is history:
  // it waits on the shelf until the person opens it or work comes back to it.
  const shelvable = (n) => useShelf && allDone(n) && !model.focusPath.includes(n.id) && !expanded.has(n.id)
    && !standing(n, true) && !failingIn(n, model.tests?.byNode, true);
  const shelvedTop = model.structure.filter(shelvable);
  // If everything is finished there is nothing to set it beside, so it all stays in the map.
  const shelved = new Set(shelvedTop.length < model.structure.length ? shelvedTop.map((n) => n.id) : []);

  // Pass 1: what is drawn, and how. visibleOf maps every part to the box that stands in for it.
  const visibleOf = new Map();
  const meta = new Map();
  const sizeOf = (n, folded, compact) => {
    const here = standing(n, folded);
    const laneWidth = here * token + Math.max(0, here - 1) * tokenGap + 24;
    if (compact) return { width: Math.max(88, n.name.length * charWidth + 26), height: chipHeight };
    return { width: Math.max(minLeafWidth, n.name.length * charWidth + 32, here ? laneWidth : 0), height: leafHeight + (here ? lane : 0) };
  };
  const visit = (n, depth, parentId, onShelf) => {
    const folded = (onShelf && n.children.length > 0) || isFolded(n, foldOpts);
    const container = n.children.length > 0 && !folded;
    // A finished part with nobody on it shrinks to a chip; the focus and failures keep full size.
    const compact = !container && allDone(n) && n.id !== model.focus && !standing(n, folded) && !failingIn(n, model.tests?.byNode, folded);
    const m = { n, depth, parentId, folded, container, compact, shelved: onShelf, packed: false, ...(container ? {} : sizeOf(n, folded, compact)) };
    meta.set(n.id, m);
    if (container) { visibleOf.set(n.id, n.id); n.children.forEach((c) => visit(c, depth + 1, n.id, false)); }
    else { const mark = (x) => { visibleOf.set(x.id, n.id); x.children.forEach(mark); }; mark(n); }
  };
  model.structure.forEach((n) => visit(n, 0, null, shelved.has(n.id)));

  const ancestorsOf = (id) => { const out = []; for (let p = model.parentOf.get(id); p; p = model.parentOf.get(p)) out.push(p); return out; };
  const related = (a, b) => a === b || ancestorsOf(a).includes(b) || ancestorsOf(b).includes(a);
  const visibleEdges = [];
  for (const d of model.deps) {
    const a = visibleOf.get(d.from);
    const b = visibleOf.get(d.to);
    // Folding can merge both ends into one box, or put one inside the other; neither can be drawn as an arrow.
    if (!a || !b || related(a, b) || meta.get(a).shelved || meta.get(b).shelved) continue;
    visibleEdges.push({ a, b, d });
  }

  // Pass 2: groups whose children are all single boxes with no arrows between them
  // get packed into a grid. ELK sees the group as one fixed-size box.
  const packedIn = new Map(); // child id -> packed group id
  if (pack) {
    for (const m of meta.values()) {
      if (!m.container || m.n.children.length < 3) continue;
      const kids = m.n.children.map((c) => meta.get(c.id));
      if (kids.some((k) => k.container)) continue;
      const ids = new Set(m.n.children.map((c) => c.id));
      if (visibleEdges.some((e) => ids.has(e.a) && ids.has(e.b))) continue;
      m.packed = true;
      for (const id of ids) packedIn.set(id, m.n.id);
      const cw = Math.max(...kids.map((k) => k.width));
      // Roughly square blocks: wide cells mean fewer columns than rows.
      const ch = Math.max(...kids.map((k) => k.height));
      const cols = Math.max(1, Math.min(kids.length, Math.round(Math.sqrt(kids.length * 1.4 * ch / cw)) || 1));
      const rows = [];
      kids.forEach((k, i) => { (rows[Math.floor(i / cols)] ||= []).push(k); });
      let y = header;
      for (const row of rows) {
        const rh = Math.max(...row.map((k) => k.height));
        row.forEach((k, i) => { k.gx = 14 + i * (cw + gap); k.gy = y; k.width = cw; });
        y += rh + gap;
      }
      m.width = 28 + cols * cw + (cols - 1) * gap;
      m.height = Math.max(header + 20, y - gap + 14);
      m.headerName = m.n.name.length * charWidth + 120; // room for the name and roll-up in the header
      m.width = Math.max(m.width, m.headerName);
    }
  }
  // An arrow to a packed child is drawn to its group.
  const lift = (id) => packedIn.get(id) ?? id;

  const elkNodes = new Map();
  const toElk = (n) => {
    const m = meta.get(n.id);
    if (!m.container || m.packed) return { id: n.id, width: m.width, height: m.height };
    const elkNode = {
      id: n.id,
      layoutOptions: { "elk.padding": `[top=${header},left=14,bottom=14,right=14]` },
      children: n.children.map(toElk),
      edges: [],
    };
    elkNodes.set(n.id, elkNode);
    return elkNode;
  };
  const children = model.structure.filter((n) => !shelved.has(n.id)).map(toElk);

  const edgeMap = new Map();
  for (const { a: a0, b: b0, d } of visibleEdges) {
    const a = lift(a0);
    const b = lift(b0);
    if (related(a, b)) continue;
    const key = `${a}>${b}`;
    const e = edgeMap.get(key) || { id: key, source: a, target: b, weight: 0, count: 0, kinds: new Set() };
    e.weight += d.weight; e.count++; e.kinds.add(d.kind);
    edgeMap.set(key, e);
  }
  const edgeList = [...edgeMap.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
  // ELK reports an edge's route relative to the box that contains both ends, so
  // each edge is declared on that box (or the root) and offset back afterwards.
  const rootEdges = [];
  for (const e of edgeList) {
    const up = ancestorsOf(e.source);
    const lca = ancestorsOf(e.target).length ? up.find((id) => ancestorsOf(e.target).includes(id)) : undefined;
    const elkEdge = { id: e.id, sources: [e.source], targets: [e.target] };
    (lca && elkNodes.has(lca) ? elkNodes.get(lca).edges : rootEdges).push(elkEdge);
  }

  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "RIGHT" ? "RIGHT" : "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "SPLINES",
      "elk.spacing.nodeNode": "22",
      "elk.layered.spacing.nodeNodeBetweenLayers": "46",
      "elk.spacing.edgeNode": "14",
      "elk.padding": "[top=8,left=8,bottom=8,right=8]",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", // keeps the file's order where it can, so boxes do not jump between updates
    },
    children,
    edges: rootEdges,
  });

  const heatOf = (n, folded) => (folded ? subtreeHeat(n, model.heat) : model.heat.get(n.id) || 0);
  const hotIds = new Set();
  const nodes = [];
  const routed = [];
  const emit = (m, x, y, width, height) => {
    const n = m.n;
    const heat = heatOf(n, m.folded || m.container);
    const active = n.status === "active" || (m.container || m.folded ? subtreeHas(n, "active") : false);
    const hot = active || heat > 0.15;
    if (hot) hotIds.add(n.id);
    nodes.push({
      id: n.id, name: n.name, status: n.status, note: n.note, paths: n.paths, from: n.from,
      failing: failingIn(n, model.tests?.byNode, m.folded || m.container),
      coverage: model.coverage?.byNode.get(n.id) ?? null,
      x, y, width, height, depth: m.depth, parentId: m.parentId,
      container: m.container, folded: m.folded, hasChildren: n.children.length > 0,
      compact: m.compact, shelved: m.shelved, packed: m.packed,
      rollup: n.children.length ? leafStats(n) : null,
      heat, hot, containsActive: active,
      agents: [...(m.container ? [] : m.folded ? subtreeAgents(n, model.nodeAgents) : model.nodeAgents.get(n.id) || [])],
      focus: n.id === model.focus,
      onFocusPath: model.focusPath.includes(n.id),
    });
  };
  const walk = (g, ox, oy) => {
    for (const ge of g.edges || []) routed.push({ ge, ox, oy });
    for (const c of g.children || []) {
      const m = meta.get(c.id);
      const x = ox + c.x;
      const y = oy + c.y;
      emit(m, x, y, c.width, c.height);
      if (m.packed) for (const k of m.n.children) { const km = meta.get(k.id); emit(km, x + km.gx, y + km.gy, km.width, km.height); }
      walk(c, x, y);
    }
  };
  walk(graph, 0, 0);

  // The shelf: finished branches as chips in rows, beside the map or under it,
  // whichever leaves the map drawn larger in the space it has.
  let shelf = null;
  let width = graph.width;
  let height = graph.height;
  if (shelved.size) {
    const chips = model.structure.filter((n) => shelved.has(n.id)).map((n) => meta.get(n.id));
    const pad = 12;
    const head = 26;
    const flow = (maxW) => {
      let x = 0; let y = 0; let w = 0;
      const at = chips.map((c) => {
        if (x > 0 && x + c.width > maxW) { x = 0; y += chipHeight + gap; }
        const p = { x, y };
        x += c.width + gap; w = Math.max(w, x - gap);
        return p;
      });
      return { at, w, h: y + chipHeight };
    };
    const widest = Math.max(...chips.map((c) => c.width));
    // Under: rows as wide as the map. Beside: a column about as tall as the map.
    const under = flow(Math.max(graph.width - 16 - pad * 2, widest));
    let side = null;
    for (let w = widest; ; w += widest + gap) {
      side = flow(w);
      if (side.h + head + pad <= Math.max(graph.height - 16, chipHeight + head + pad) || side.w >= under.w) break;
    }
    const box = (f) => ({ width: f.w + pad * 2, height: f.h + head + pad });
    const fit = (W, H) => (aspect ? Math.min(aspect / W, 1 / H) : (W === graph.width ? 1 : 0));
    const ub = box(under);
    const sb = box(side);
    const uW = Math.max(graph.width, ub.width + 16);
    const uH = graph.height + 8 + ub.height + 8;
    const sW = graph.width + 8 + sb.width + 8;
    const sH = Math.max(graph.height, sb.height + 16);
    const beside = aspect != null && fit(sW, sH) > fit(uW, uH) * 1.05;
    const f = beside ? side : under;
    const b = beside ? sb : ub;
    shelf = beside
      ? { x: graph.width + 8, y: 8, width: b.width, height: b.height, count: chips.length, side: "right" }
      : { x: 8, y: graph.height + 8, width: Math.max(b.width, graph.width - 16), height: b.height, count: chips.length, side: "below" };
    chips.forEach((c, i) => emit(c, shelf.x + pad + f.at[i].x, shelf.y + head + f.at[i].y, c.width, chipHeight));
    width = beside ? sW : uW;
    height = beside ? sH : uH;
  }

  const edges = routed.sort((a, b) => (a.ge.id < b.ge.id ? -1 : 1)).map(({ ge, ox, oy }) => {
    const e = edgeMap.get(ge.id);
    const points = [];
    for (const sec of ge.sections || []) {
      points.push([ox + sec.startPoint.x, oy + sec.startPoint.y]);
      for (const b of sec.bendPoints || []) points.push([ox + b.x, oy + b.y]);
      points.push([ox + sec.endPoint.x, oy + sec.endPoint.y]);
    }
    return {
      id: e.id, source: e.source, target: e.target, weight: e.weight, count: e.count,
      kind: e.kinds.size === 1 ? [...e.kinds][0] : "calls",
      hot: hotIds.has(e.source) || hotIds.has(e.target),
      points,
    };
  });

  // Tokens: one per working agent, standing in the lane of its part (or the
  // header of an open group). Agents with no part live in the Agents panel only.
  const byBox = new Map(nodes.map((n) => [n.id, n]));
  const tokens = [];
  const perBox = new Map();
  for (const a of model.agents) {
    if (a.isPerson) continue;
    const box = a.at ? byBox.get(visibleOf.get(a.at)) : null;
    if (!box) continue;
    const i = perBox.get(box.id) ?? 0;
    perBox.set(box.id, i + 1);
    const r = token / 2;
    tokens.push(box.container
      ? { id: a.id, x: box.x + box.width - 60 - r - i * (token + tokenGap), y: box.y + header / 2, at: box.id, parked: false }
      : { id: a.id, x: box.x + 12 + r + i * (token + tokenGap), y: box.y + leafHeight + lane / 2 - 4, at: box.id, parked: false });
  }

  return { nodes, edges, tokens, shelf, bullpen: null, visibleOf, width, height };
}

/**
 * Everything related to what the person is pointing at, so every panel can
 * light up the same things. `layout` maps hidden parts to their visible box.
 * Point at a part: it, its groups and contents, the todos on them and the
 * agents on them. A todo: its part (and its sub-todos' parts), its owner, its
 * parents and sub-todos. An agent: its parts and the todos it owns. An event:
 * its part and its agents. Returns { parts, agents, todos } of Sets, or null.
 */
export function relations(model, layout, target) {
  if (!target || target.id == null) return null;
  const vis = (id) => layout?.visibleOf?.get(id) ?? id;
  const withAncestors = (ids) => {
    const out = new Set();
    for (const id of ids) for (let p = vis(id); p; p = model.parentOf.get(p)) out.add(p);
    return out;
  };
  const subtreeIds = (id) => {
    const out = new Set([id]);
    const walk = (n) => n.children.forEach((c) => { out.add(c.id); walk(c); });
    if (model.byId.has(id)) walk(model.byId.get(id));
    return out;
  };
  const todoRows = flattenTodos(model.todos, { collapsed: null });
  const todoByKey = new Map(todoRows.map((t) => [t.key, t]));
  const todoFamily = (key) => {
    const out = new Set([key]);
    for (let p = todoByKey.get(key)?.parent; p; p = todoByKey.get(p)?.parent) out.add(p);
    const down = (t) => t.children.forEach((c) => { out.add(c.key); down(c); });
    if (todoByKey.has(key)) down(todoByKey.get(key));
    return out;
  };
  const agentParts = (a) => [a.at, ...a.nodes].filter(Boolean);
  const suites = model.tests?.suites ?? [];
  const testParts = (s, f) => (f ? (f.node ? [f.node] : s.nodes) : [...s.nodes, ...s.failures.map((x) => x.node).filter(Boolean)]);

  let partIds = [];
  const tests = new Set();
  const agents = new Set();
  const todos = new Set();
  if (target.kind === "part") {
    const sub = subtreeIds(target.id);
    partIds = [...sub];
    for (const a of model.agents) if (agentParts(a).some((n) => sub.has(n))) agents.add(a.id);
    for (const t of todoRows) if (t.node && sub.has(t.node)) todoFamily(t.key).forEach((k) => todos.add(k));
    for (const s of suites) {
      if (s.nodes.some((n) => sub.has(n))) tests.add(s.id);
      for (const f of s.failures) if (testParts(s, f).some((n) => sub.has(n))) { tests.add(f.key); tests.add(s.id); }
    }
  } else if (target.kind === "coverage") {
    const walk = (n) => { if (n.children.length) n.children.forEach(walk); else if (model.coverage?.byNode.get(n.id)?.band === target.id) partIds.push(n.id); };
    model.structure.forEach(walk);
    const set = new Set(partIds);
    for (const s of suites) if (s.nodes.some((n) => set.has(n))) tests.add(s.id);
    if (!partIds.length) return null;
  } else if (target.kind === "status" || target.kind === "todo-status") {
    // A segment of a status bar: every part (or todo) with that status, and what touches them.
    if (target.kind === "status") {
      const walk = (n) => { if (n.children.length) n.children.forEach(walk); else if (n.status === target.id) partIds.push(n.id); };
      model.structure.forEach(walk);
      const set = new Set(partIds);
      for (const a of model.agents) if (agentParts(a).some((n) => set.has(n))) agents.add(a.id);
      for (const t of todoRows) if (t.node && set.has(t.node)) todos.add(t.key);
    } else {
      for (const t of todoRows) {
        if (t.children.length || t.status !== target.id) continue;
        todos.add(t.key);
        for (let p = t; p; p = todoByKey.get(p.parent)) {
          todos.add(p.key);
          if (p.node) { partIds.push(p.node); break; } // a sub-todo without a part takes its parent's
        }
        if (t.owner) agents.add(t.owner);
      }
    }
    if (!partIds.length && !todos.size) return null;
  } else if (target.kind === "test") {
    // A suite id, or a failure key "suite/index".
    for (const s of suites) {
      const f = s.failures.find((x) => x.key === target.id);
      if (s.id !== target.id && !f) continue;
      tests.add(s.id);
      if (f) tests.add(f.key); else s.failures.forEach((x) => tests.add(x.key));
      partIds.push(...testParts(s, f));
    }
    if (!tests.size) return null;
  } else if (target.kind === "todo") {
    const fam = todoFamily(target.id);
    fam.forEach((k) => todos.add(k));
    for (const k of fam) {
      const t = todoByKey.get(k);
      if (t?.node) partIds.push(t.node);
      if (t?.owner) agents.add(t.owner);
    }
  } else if (target.kind === "agent") {
    agents.add(target.id);
    const a = model.agents.find((x) => x.id === target.id);
    if (a) partIds = agentParts(a);
    for (const t of todoRows) if (t.owner === target.id) todoFamily(t.key).forEach((k) => todos.add(k));
  } else if (target.kind === "event") {
    const e = model.events.find((x) => x._i === target.id);
    if (!e) return null;
    if (e.node) partIds.push(e.node);
    if (e.agent != null) agents.add(String(e.agent));
    if (e.to != null) agents.add(String(e.to));
  } else return null;

  const parts = withAncestors(partIds);
  if (target.kind === "part") for (const id of partIds) parts.add(vis(id)); // a part's contents, as drawn
  return { parts, agents, todos, tests };
}

function subtreeHas(node, status) {
  return node.status === status || node.children.some((c) => subtreeHas(c, status));
}

/**
 * Ids to keep at full strength while the person points at an agent or a part:
 * the parts that agent is on, or the part plus its ancestors and descendants.
 * Returns null when nothing is highlighted.
 */
export function highlightSet(layout, { agent = null, node = null } = {}) {
  if (agent) {
    const keep = new Set();
    const parentOf = new Map(layout.nodes.map((n) => [n.id, n.parentId]));
    for (const n of layout.nodes) if (n.agents.includes(agent)) for (let id = n.id; id; id = parentOf.get(id)) keep.add(id);
    return keep;
  }
  if (!node || !layout.nodes.some((n) => n.id === node)) return null;
  const parentOf = new Map(layout.nodes.map((n) => [n.id, n.parentId]));
  const keep = new Set();
  for (let id = node; id; id = parentOf.get(id)) keep.add(id);
  for (const n of layout.nodes) if (isDescendant(n.id, node, parentOf)) keep.add(n.id);
  return keep;
}
function isDescendant(id, ancestor, parentOf) {
  for (let p = parentOf.get(id); p; p = parentOf.get(p)) if (p === ancestor) return true;
  return false;
}

/**
 * Places agents for the communication graph: the lead ("main", else the first)
 * in the centre and the rest on an ellipse, starting at the top.
 * Returns [{ id, x, y }] in the same order as `agents`.
 */
export function layoutAgents(agents, { width = 380, height = 250, rx = 140, ry = 82 } = {}) {
  if (!agents.length) return [];
  const cx = width / 2;
  const cy = height / 2 - 4;
  const lead = agents.find((a) => a.id === "main") || agents[0];
  const others = agents.filter((a) => a !== lead);
  // With exactly two others, a quarter turn puts them left and right of the lead, which reads better than top and bottom.
  const offset = others.length === 2 ? Math.PI / 2 : 0;
  const pos = new Map([[lead.id, { id: lead.id, x: cx, y: cy }]]);
  others.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i / others.length) * Math.PI * 2 + offset;
    pos.set(a.id, { id: a.id, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  });
  return agents.map((a) => pos.get(a.id));
}

/** A gently curved path from a to b ({x, y}), bowed to one side by `bend` of the distance. */
export function edgePath(a, b, bend = 0.15) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const p = d3path();
  p.moveTo(a.x, a.y);
  p.quadraticCurveTo(mx - (b.y - a.y) * bend, my + (b.x - a.x) * bend, b.x, b.y);
  return p.toString();
}

/** Messages (events with a different `to`) that arrived after the first `seen` events. */
export function messagesSince(events, seen) {
  return events.slice(Math.max(0, seen)).filter((e) => e.agent != null && e.to != null && String(e.to) !== String(e.agent));
}

/** "just now", "12s ago", "5m ago", "3h ago", "2d ago". */
export function formatAgo(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export const STATUS_LABEL = { active: "Working", planned: "Planned", idea: "Idea", blocked: "Blocked", done: "Done", untouched: "Not started" };
export const VERB = {
  prompt: "asked", read: "read", edit: "edited", run: "ran", search: "searched", spawn: "started",
  done: "finished", message: "messaged", note: "noted", state: "updated the plan", stop: "stopped",
  test: "ran tests", test_start: "started tests",
};

/**
 * Resamples an open polyline to `n` evenly spaced points, so two edge routes
 * with different bend counts can be interpolated point by point.
 * Non-finite points are dropped; 0 points gives [], 1 point repeats it.
 */
export function resamplePoints(points, n = 24) {
  const pts = (points || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  n = Math.max(2, Math.floor(n));
  if (!pts.length) return [];
  if (pts.length === 1) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const seg = pairs(pts, (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const cum = cumsum(seg);
  const total = cum[cum.length - 1] || 1;
  return Array.from({ length: n }, (_, k) => {
    const s = (k / (n - 1)) * total;
    const j = Math.min(bisectLeft(cum, s), seg.length - 1);
    const t = seg[j] ? (s - (j ? cum[j - 1] : 0)) / seg[j] : 0;
    const a = pts[j], b = pts[j + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  });
}

// Event types that draw as ribbon runs, and the run kind each becomes.
const RUN_KIND = { read: "read", search: "read", edit: "edit", state: "edit", run: "run", note: "note" };

/**
 * Everything the agent cards draw: one entry per working agent with its
 * activity ribbon, plus the idle agents for the chip row.
 *
 * options now (ms), window (s of history on the ribbon), gap (s; actions
 *         of the same kind on the same file closer than this join one run)
 * Returns { t0, t1, working, idle }. Each working agent:
 *   { id, name, initials, task, at (part id), todos: { done, total },
 *     runs: [{ key, kind: read|edit|run|fail|pass|note, t0, t1, target, count, node, i, live }],
 *     pins: [{ key, t, dir: in|out, other, text, i }],
 *     recent: last 5 actions [{ t, type, target, text, ok }],
 *     message: the latest pin, or null, about, skills, role }
 * Idle: { id, name, initials, status }.
 */
export function agentCardsData(model, { now = 0, window = 600, gap = 60 } = {}) {
  const t1 = now;
  const t0 = now - window * 1000;
  const rows = flattenTodos(model.todos, { collapsed: null }).filter((t) => !t.children.length);
  const evs = model.events.filter((e) => e._t != null && e.agent != null).sort((a, b) => a._t - b._t);
  const working = [];
  const idle = [];
  for (const a of model.agents) {
    if (a.isPerson) continue;
    if (a.status !== "working") { idle.push({ id: a.id, name: a.name, initials: a.initials, status: a.status }); continue; }
    const mine = evs.filter((e) => String(e.agent) === a.id);
    const runs = [];
    for (const e of mine) {
      if (e._t < t0) continue;
      let kind = e.type === "test" ? (e.ok === false || +e.failed > 0 ? "fail" : "pass") : RUN_KIND[e.type];
      if (!kind) continue;
      const target = e.target ?? null;
      const last = runs[runs.length - 1];
      // Same kind on the same file (reads join regardless of file) within the gap: one run.
      if (last && last.kind === kind && (kind === "read" || last.target === target) && e._t - last.t1 <= gap * 1000 && kind !== "fail" && kind !== "pass") {
        last.t1 = e._t; last.count++; last.i = e._i; last.node = e.node ?? last.node;
      } else {
        runs.push({ key: `${a.id}:${e._i}`, kind, t0: e._t, t1: e._t, target, count: 1, node: e.node ?? null, i: e._i, live: false });
      }
    }
    // A run lasts until the agent's next action when that follows soon, so the ribbon
    // shows time spent on each thing rather than a row of instants.
    for (let k = 0; k + 1 < runs.length; k++) {
      if (runs[k + 1].t0 - runs[k].t1 <= gap * 1000) runs[k].t1 = runs[k + 1].t0;
    }
    // The newest run is what the agent is doing now: it stretches to the present.
    const lastRun = runs[runs.length - 1];
    if (lastRun && now - lastRun.t1 < gap * 2000) { lastRun.live = true; lastRun.t1 = now; }
    const pins = evs
      .filter((e) => e._t >= t0 && e.to != null && ["message", "spawn", "done", "prompt"].includes(e.type) && String(e.to) !== String(e.agent)
        && (String(e.agent) === a.id || String(e.to) === a.id))
      .map((e) => {
        const out = String(e.agent) === a.id;
        const other = String(out ? e.to : e.agent);
        return { key: `${a.id}:p${e._i}`, t: e._t, dir: out ? "out" : "in", other, otherName: model.agents.find((x) => x.id === other)?.name ?? other, type: e.type, text: e.text ?? null, i: e._i };
      });
    const owned = rows.filter((t) => t.owner === a.id);
    working.push({
      id: a.id, name: a.name, initials: a.initials, task: a.task, at: a.at, role: a.role, about: a.about, skills: a.skills,
      todos: { done: owned.filter((t) => t.status === "done").length, total: owned.length },
      runs, pins,
      recent: mine.filter((e) => e.type !== "test_start").slice(-5).reverse()
        .map((e) => ({ t: e._t, type: e.type, target: e.target ?? null, text: e.text ?? null, ok: e.type === "test" ? !(e.ok === false || +e.failed > 0) : null, failed: e.failed ?? null, to: e.to ?? null })),
      message: pins.length ? pins[pins.length - 1] : null,
    });
  }
  // Lead first, then whoever has been working longest; stable so cards do not shuffle on every tick.
  working.sort((x, y) => (x.id === "main" ? -1 : y.id === "main" ? 1 : (x.runs[0]?.t0 ?? Infinity) - (y.runs[0]?.t0 ?? Infinity) || x.id.localeCompare(y.id)));
  idle.sort((x, y) => x.name.localeCompare(y.name));
  return { t0, t1, working, idle };
}

// ---- live sources -------------------------------------------------------------

/**
 * Merges event lists from several sources into one timeline, sorted by time.
 * The same line read from two places (the shared log and the database copy) is
 * kept once. An event the hook logged by itself (`auto: true`) gives way to one
 * Claude wrote by hand for the same target within `slack` ms, which says more.
 * Returns new objects with `_i` renumbered in timeline order.
 */
export function mergeEvents(lists, { slack = 2000 } = {}) {
  const seen = new Set();
  const all = [];
  for (const list of lists) {
    for (const e of list ?? []) {
      const { _i, ...rest } = e;
      const key = JSON.stringify(rest);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(rest);
    }
  }
  const byTarget = new Map();
  for (const e of all) {
    if (e.auto || e._t == null) continue;
    const k = String(e.target ?? "");
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(e._t);
  }
  const kept = all.filter((e) => !(e.auto && e._t != null &&
    (byTarget.get(String(e.target ?? "")) ?? []).some((t) => Math.abs(t - e._t) <= slack)));
  // Stable sort: events with no time keep their place after the timed ones before them.
  const order = kept.map((e, i) => ({ e, i, t: e._t ?? -Infinity }));
  let last = -Infinity;
  for (const o of order) { if (o.e._t == null) o.t = last; else last = o.t; }
  order.sort((a, b) => a.t - b.t || a.i - b.i);
  return order.map((o, i) => ({ ...o.e, _i: i }));
}

/**
 * Plans the next read of an append-only log, given the bytes already read and the
 * file's size now. Returns null when nothing is new, `{ offset }` to read only the
 * new tail, or `{ offset: 0, reset: true }` when the file shrank (it was trimmed),
 * so it must be read again from the start.
 */
export function tailRead(known, size) {
  if (known == null || size < known) return { offset: 0, reset: true };
  return size === known ? null : { offset: known };
}

/** True while the last logged action is under `window` seconds old. */
export function isLive(heartbeatMs, now, window = 60) {
  return heartbeatMs != null && now - heartbeatMs >= 0 && now - heartbeatMs < window * 1000;
}

/**
 * True when Claude is clearly working (a fresh heartbeat) but the to-dos and
 * focus in state.yaml have not changed for `after` minutes: the view's
 * hand-written half may be behind its automatic half.
 */
export function todosBehind({ heartbeatMs, stateMs, now }, { after = 10, window = 60 } = {}) {
  if (!isLive(heartbeatMs, now, window) || stateMs == null) return false;
  return heartbeatMs - stateMs > after * 60 * 1000;
}
