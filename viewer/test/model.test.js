import { test } from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  globToRe, toMs, parseEvents, buildModel, leafStats, isFolded, layoutStructure,
  highlightSet, layoutAgents, edgePath, messagesSince, formatAgo, summarize,
  normalizeTodos, flattenTodos, initials, resamplePoints, relations, buildTests, buildCoverage, toFraction, agentCardsData, TEST_FILE, repairCommaSplits,
} from "../src/model.js";

const elk = new ELK();

const NOW = Date.parse("2026-11-24T21:40:00-05:00");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

const STATE = {
  project: "Demo",
  session: { goal: "Ship it", phase: "building", focus: "ui.tree", thinking: "  Folding helps.  " },
  structure: [
    { id: "ui", name: "UI", status: "active", paths: ["ui/**"], children: [
      { id: "ui.tree", name: "Tree", status: "active", paths: ["ui/tree.js"], uses: ["fmt.a", { to: "docs", kind: "events", weight: 3 }] },
      { id: "ui.list", name: "List", status: "planned", uses: [{ to: "fmt.b", kind: "data" }, "ui.tree", "nope", { kind: "calls" }] },
    ] },
    { id: "fmt", name: "Format", status: "done", children: [
      { id: "fmt.a", name: "A", status: "done" },
      { id: "fmt.b", name: "B", status: "done" },
    ] },
    { id: "docs", name: "Docs" },
  ],
  agents: [{ id: "main", name: "Claude", role: "Lead", nodes: ["ui.list"] }, { id: "helper", name: "Helper" }],
  todos: [
    { id: "t1", text: "Done thing", status: "done", owner: "main" },
    { id: "t2", text: "Doing thing", status: "in_progress", owner: "helper", node: "ui.tree" },
    { id: "t3", text: "Blocked thing", status: "blocked" },
    { text: "No id, odd status", status: "whatever" },
  ],
};
const EVENTS = parseEvents([
  { t: at(600), agent: "user", type: "prompt", to: "main", text: "Go" },
  { t: at(30), agent: "main", type: "edit", target: "/home/me/repo/ui/tree.js" },
  { t: at(20), agent: "main", type: "spawn", to: "helper", text: "Help" },
  { t: at(10), agent: "helper", type: "message", to: "main", text: "Hi" },
  { t: at(5), agent: "scout", type: "read", target: "ui/other.js" },
].map((e) => JSON.stringify(e)).join("\n"));

test("globToRe matches the expected paths", () => {
  const cases = [
    ["src/**", "src/a/b.ts", true],
    ["src/**", "/abs/repo/src/a.ts", true],
    ["src/**", "notsrc/a.ts", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", true],
    ["docs/*.md", "docs/a/b.md", false],
    ["a/**/b.js", "a/b.js", true],
    ["file?.txt", "file1.txt", true],
    ["a.b", "axb", false],
  ];
  for (const [glob, path, expected] of cases) assert.equal(globToRe(glob).test(path), expected, `${glob} vs ${path}`);
});

test("toMs returns null for missing or invalid times", () => {
  assert.equal(toMs(undefined), null);
  assert.equal(toMs(""), null);
  assert.equal(toMs("not a date"), null);
  assert.equal(toMs("2026-11-24T21:40:00-05:00"), NOW);
});

test("parseEvents skips blank, broken and non-object lines", () => {
  const out = parseEvents('{"a":1}\n\n{broken\n[1,2]\nnull\n{"t":"bad","b":2}\n{"half": ');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e._i), [0, 1]);
  assert.equal(out[1]._t, null);
});

test("parseEvents keeps only the last maxLines lines", () => {
  const text = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i })).join("\n");
  assert.deepEqual(parseEvents(text, { maxLines: 3 }).map((e) => e.n), [7, 8, 9]);
});

test("parseEvents handles empty and missing input", () => {
  assert.deepEqual(parseEvents(""), []);
  assert.deepEqual(parseEvents(undefined), []);
});

test("buildModel returns an empty model for an empty state", () => {
  const m = buildModel(null, [], { now: NOW });
  assert.equal(m.structure.length, 0);
  assert.deepEqual(m.agents.map((a) => a.id), ["main"]);
  assert.equal(m.todos.length, 0);
  assert.equal(m.todoCounts.total, 0);
  assert.equal(m.updatedAt, null);
  assert.equal(m.focus, null);
});

test("buildModel does not mutate its input", () => {
  const copy = structuredClone(STATE);
  buildModel(STATE, EVENTS, { now: NOW });
  assert.deepEqual(STATE, copy);
});

test("buildModel adds agents that only appear in events", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  assert.deepEqual(m.agents.map((a) => a.id), ["main", "helper", "user", "scout"]);
  assert.equal(m.agents.find((a) => a.id === "user").isPerson, true);
  assert.equal(m.agents.find((a) => a.id === "main").initials, "Cl");
});

test("buildModel places a working agent on the part it touched last", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  const at = Object.fromEntries(m.agents.map((a) => [a.id, a.at]));
  assert.equal(at.main, "ui.tree");   // its edit 30 s ago
  assert.equal(at.scout, "ui");       // read matched by path
  assert.equal(at.helper, null);      // working, but never on a part
  assert.equal(at.user, null);
});

test("buildModel trusts state.yaml for an agent with parts and no events", () => {
  const m = buildModel({ structure: STATE.structure, agents: [{ id: "x", nodes: ["docs"] }, { id: "y" }] }, [], { now: NOW });
  const by = Object.fromEntries(m.agents.map((a) => [a.id, a]));
  assert.equal(by.x.status, "working");
  assert.equal(by.x.at, "docs");
  assert.equal(by.y.status, "idle");
  assert.equal(by.y.at, null);
});

test("buildModel reads skills as names or name and description", () => {
  const m = buildModel({ agents: [{ id: "a", skills: ["one", { name: "two", description: "Second" }, "one", "", null, { description: "no name" }] }] }, [], { now: NOW });
  assert.deepEqual(m.agents.find((a) => a.id === "a").skills, [{ name: "one", description: null }, { name: "two", description: "Second" }]);
});

test("initials picks two letters from one or two words", () => {
  const cases = [["Explorer", "Ex"], ["code reviewer", "CR"], ["general-purpose", "GP"], ["", "?"], [null, "?"], ["x", "X"]];
  for (const [name, expected] of cases) assert.equal(initials(name), expected, String(name));
});

test("buildModel keeps dependencies whose ends both exist", () => {
  const m = buildModel(STATE, [], { now: NOW });
  assert.deepEqual(m.deps.map((d) => `${d.from}>${d.to}:${d.kind}:${d.weight}`), [
    "ui.tree>fmt.a:calls:1", "ui.tree>docs:events:3", "ui.list>fmt.b:data:1", "ui.list>ui.tree:calls:1",
  ]);
});

test("buildModel counts leaf parts by status", () => {
  const p = buildModel(STATE, [], { now: NOW }).parts;
  assert.deepEqual(p, { total: 5, active: 1, planned: 1, idea: 0, blocked: 0, done: 2, untouched: 1 });
});

test("buildModel derives agent status from the last event", () => {
  const events = parseEvents([
    { t: at(10), agent: "a", type: "edit" },
    { t: at(500), agent: "b", type: "edit" },
    { t: at(10), agent: "c", type: "done" },
    { t: at(10), agent: "d", type: "stop" },
  ].map((e) => JSON.stringify(e)).join("\n"));
  const status = Object.fromEntries(buildModel({ agents: [{ id: "e", status: "waiting" }] }, events, { now: NOW }).agents.map((a) => [a.id, a.status]));
  assert.deepEqual(status, { e: "waiting", main: "idle", a: "working", b: "idle", c: "done", d: "idle" });
});

test("buildModel maps a file edit to the deepest matching part", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  assert.equal(m.events[1].node, "ui.tree");
  assert.equal(m.events[4].node, "ui");
  assert.ok(m.heat.get("ui.tree") > 0.6 && m.heat.get("ui.tree") < 0.8); // 30 s old with a 60 s half-life
});

test("buildModel prefers an explicit node over a path match", () => {
  const events = parseEvents(JSON.stringify({ t: at(1), agent: "main", type: "edit", target: "ui/tree.js", node: "docs" }));
  assert.equal(buildModel(STATE, events, { now: NOW }).events[0].node, "docs");
});

test("buildModel treats events from the future as happening now", () => {
  const events = parseEvents(JSON.stringify({ t: at(-3600), agent: "main", type: "edit", target: "ui/tree.js" }));
  assert.equal(buildModel(STATE, events, { now: NOW }).heat.get("ui.tree"), 1);
});

test("buildModel keeps the first of two parts with the same id", () => {
  const m = buildModel({ structure: [{ id: "x", name: "First" }, { id: "x", name: "Second" }, { id: 5 }] }, [], { now: NOW });
  assert.deepEqual(m.structure.map((n) => n.name), ["First", "5"]);
});

test("buildModel turns unknown statuses into defaults", () => {
  const m = buildModel(STATE, [], { now: NOW });
  assert.equal(m.byId.get("docs").status, "untouched");
  assert.equal(m.todos.find((t) => t.key === "#3").status, "pending");
});

test("buildModel sorts todos by status and counts them", () => {
  const m = buildModel(STATE, [], { now: NOW });
  assert.deepEqual(m.todos.map((t) => t.key), ["t2", "t3", "#3", "t1"]);
  assert.deepEqual(m.todoCounts, { total: 4, in_progress: 1, blocked: 1, pending: 1, done: 1 });
});

const NESTED = [
  { id: "p", text: "Parent", children: [
    { id: "c1", text: "One", status: "done" },
    { id: "c2", text: "Two", status: "in_progress", children: [{ id: "g1", text: "Deep", status: "pending" }] },
  ] },
  { id: "q", text: "All done", children: [{ id: "q1", status: "done" }, { id: "q2", status: "done" }] },
  { id: "r", text: "Blocked parent", subtasks: [{ id: "r1", status: "blocked" }, { id: "r2" }] },
  { id: "p", text: "Duplicate id" },
];

test("normalizeTodos derives a parent's status from its children", () => {
  const t = normalizeTodos(NESTED);
  const by = Object.fromEntries(t.map((x) => [x.key, x]));
  assert.equal(by.p.status, "in_progress");
  assert.equal(by.q.status, "done");
  assert.equal(by.r.status, "blocked");
  assert.deepEqual(by.p.progress, { done: 1, total: 2 });
  assert.equal(by.p.children.find((c) => c.key === "c2").status, "in_progress"); // its own status wins
});

test("normalizeTodos makes duplicate ids unique", () => {
  const keys = normalizeTodos(NESTED).map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("flattenTodos nests rows depth first and folds finished parents", () => {
  const rows = flattenTodos(normalizeTodos(NESTED));
  assert.deepEqual(rows.map((r) => `${r.depth}:${r.key}`), ["0:p", "1:c2", "2:g1", "1:c1", "0:r", "1:r1", "1:r2", "0:p#3", "0:q"]);
  assert.equal(rows.find((r) => r.key === "q").folded, true);
});

test("flattenTodos respects the person's folding and can show everything", () => {
  const t = normalizeTodos(NESTED);
  const rows = flattenTodos(t, { collapsed: new Set(["p"]), expanded: new Set(["q"]) });
  assert.ok(!rows.some((r) => r.parent === "p"));
  assert.ok(rows.some((r) => r.parent === "q"));
  assert.equal(flattenTodos(t, { collapsed: null }).length, 11);
});

test("buildModel counts only leaf todos", () => {
  const m = buildModel({ todos: NESTED }, [], { now: NOW });
  assert.deepEqual(m.todoCounts, { total: 7, in_progress: 0, blocked: 1, pending: 3, done: 3 });
});

test("summarize states the focus and how much is done", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  const c = summarize(m);
  assert.equal(c.headline, "Claude is on Tree, with 2 of 5 parts done");
  assert.equal(c.kicker, "Live · building");
  assert.equal(c.deck, "Ship it. 3 agents working.");
});

test("summarize handles an empty project and a finished one", () => {
  assert.equal(summarize(buildModel({}, [], { now: NOW })).headline, "Waiting for Claude to sketch the app");
  const done = buildModel({ session: { phase: "Done" }, structure: [{ id: "a", status: "done" }, { id: "b" }] }, [], { now: NOW });
  assert.equal(summarize(done).headline, "Finished, with 1 of 2 parts done");
  const noFocus = buildModel({ structure: [{ id: "a", status: "active" }, { id: "b", status: "active" }] }, [], { now: NOW });
  assert.equal(summarize(noFocus).headline, "Claude is working on 2 parts, with 0 of 2 parts done");
});

test("buildModel collects undirected message edges", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  const edge = m.edges.find((e) => e.key === "helper|main");
  assert.equal(edge.count, 2);
  assert.equal(edge.recent, true);
  assert.equal(m.edges.find((e) => e.key === "main|user").recent, false);
});

test("buildModel lists who is on each part from events and declared nodes", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  assert.deepEqual([...m.nodeAgents.get("ui.tree")], ["main"]);
  assert.deepEqual([...m.nodeAgents.get("ui.list")], ["main"]);
  assert.deepEqual([...m.nodeAgents.get("ui")], ["scout"]);
});

test("buildModel builds the focus path and trims thinking", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  assert.deepEqual(m.focusPath, ["ui", "ui.tree"]);
  assert.equal(m.thinking, "Folding helps.");
  assert.equal(m.updatedAt, NOW - 5000);
});

test("buildModel ignores a focus that names no part", () => {
  assert.equal(buildModel({ ...STATE, session: { focus: "nope" } }, [], { now: NOW }).focus, null);
});

test("leafStats counts finished leaves", () => {
  const m = buildModel(STATE, [], { now: NOW });
  assert.deepEqual(leafStats(m.byId.get("ui")), { done: 0, total: 2 });
  assert.deepEqual(leafStats(m.byId.get("fmt")), { done: 2, total: 2 });
  assert.deepEqual(leafStats(m.byId.get("docs")), { done: 0, total: 1 });
});

test("isFolded folds finished branches unless opened or on the focus path", () => {
  const m = buildModel(STATE, [], { now: NOW });
  const fmt = m.byId.get("fmt");
  const ui = m.byId.get("ui");
  assert.equal(isFolded(fmt), true);
  assert.equal(isFolded(fmt, { expanded: new Set(["fmt"]) }), false);
  assert.equal(isFolded(fmt, { focusPath: ["fmt"] }), false);
  assert.equal(isFolded(ui), false);
  assert.equal(isFolded(ui, { collapsed: new Set(["ui"]) }), true);
  assert.equal(isFolded(m.byId.get("docs"), { collapsed: new Set(["docs"]) }), false);
});

test("layoutStructure returns an empty layout for an empty structure", async () => {
  const l = await layoutStructure(buildModel({}, [], { now: NOW }), { elk });
  assert.deepEqual([l.nodes, l.edges, l.tokens, l.bullpen, l.width, l.height], [[], [], [], null, 0, 0]);
});

test("layoutStructure nests open groups and folds finished ones", async () => {
  const l = await layoutStructure(buildModel(STATE, EVENTS, { now: NOW }), { elk });
  const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.deepEqual(Object.keys(by).sort(), ["docs", "fmt", "ui", "ui.list", "ui.tree"]);
  assert.equal(by.ui.container, true);
  assert.equal(by.fmt.container, false);
  assert.equal(by.fmt.folded, true);
  for (const child of [by["ui.tree"], by["ui.list"]]) {
    assert.equal(child.parentId, "ui");
    assert.ok(child.x >= by.ui.x && child.x + child.width <= by.ui.x + by.ui.width + 1e-6, child.id);
    assert.ok(child.y >= by.ui.y && child.y + child.height <= by.ui.y + by.ui.height + 1e-6, child.id);
  }
});

test("layoutStructure merges dependencies into folded groups and sums their weight", async () => {
  const l = await layoutStructure(buildModel(STATE, EVENTS, { now: NOW }), { elk });
  const ids = l.edges.map((e) => e.id).sort();
  assert.deepEqual(ids, ["ui.list>fmt", "ui.list>ui.tree", "ui.tree>docs", "ui.tree>fmt"]);
  assert.equal(l.edges.find((e) => e.id === "ui.tree>docs").kind, "events");
  assert.equal(l.edges.find((e) => e.id === "ui.tree>docs").weight, 3);
  for (const e of l.edges) assert.ok(e.points.length >= 2 && e.points.flat().every(Number.isFinite), e.id);
});

test("layoutStructure routes every arrow from its source box to its target box", async () => {
  const state = structuredClone(STATE);
  state.structure[0].children.push({ id: "ui.deep", name: "Deep", children: [{ id: "ui.deep.x", name: "X", uses: ["ui.tree"] }] });
  const l = await layoutStructure(buildModel(state, EVENTS, { now: NOW }), { elk });
  const box = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  const touches = ([x, y], b) => x >= b.x - 2 && x <= b.x + b.width + 2 && y >= b.y - 2 && y <= b.y + b.height + 2;
  assert.ok(l.edges.some((e) => e.id === "ui.deep.x>ui.tree")); // an arrow inside a group, the case that broke
  for (const e of l.edges) {
    assert.ok(touches(e.points[0], box[e.source]), `${e.id} starts at its source`);
    assert.ok(touches(e.points[e.points.length - 1], box[e.target]), `${e.id} ends at its target`);
  }
});

test("layoutStructure drops arrows that folding turns inward", async () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk, collapsed: new Set(["ui"]) });
  assert.ok(!l.edges.some((e) => e.source === e.target));
  assert.deepEqual(l.edges.map((e) => e.id).sort(), ["ui>docs", "ui>fmt"]);
  assert.equal(l.edges.find((e) => e.id === "ui>fmt").weight, 2);
});

test("layoutStructure marks live parts and the arrows that touch them", async () => {
  const l = await layoutStructure(buildModel(STATE, EVENTS, { now: NOW }), { elk });
  const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.equal(by["ui.tree"].focus, true);
  assert.equal(by.ui.containsActive, true);
  assert.equal(by.docs.hot, false);
  assert.equal(l.edges.find((e) => e.id === "ui.tree>docs").hot, true);
  assert.deepEqual(by["ui.tree"].agents, ["main"]);
});

test("layoutStructure gives a part with agents on it a lane for their tokens", async () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk });
  const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.equal(by["ui.tree"].height, 52 + 34); // main stands here
  assert.equal(by.docs.height, 52);
  const tok = Object.fromEntries(l.tokens.map((t) => [t.id, t]));
  assert.equal(tok.main.at, "ui.tree");
  const b = by["ui.tree"];
  assert.ok(tok.main.x > b.x && tok.main.x < b.x + b.width && tok.main.y > b.y + 52 && tok.main.y < b.y + b.height);
});

test("layoutStructure parks idle agents in the bullpen under the map", async () => {
  const state = { ...STATE, agents: [...STATE.agents, { id: "rest", name: "Rest", status: "idle" }] };
  const l = await layoutStructure(buildModel(state, EVENTS, { now: NOW }), { elk });
  const rest = l.tokens.find((t) => t.id === "rest");
  assert.equal(rest.parked, true);
  assert.ok(rest.y > l.bullpen.y && rest.y < l.bullpen.y + l.bullpen.height);
  assert.ok(l.bullpen.y >= Math.max(...l.nodes.map((n) => n.y + n.height)));
  assert.ok(!l.tokens.some((t) => t.id === "user")); // people are not agents on the map
});

test("layoutStructure puts an agent on a folded group when its part is hidden inside", async () => {
  const state = structuredClone(STATE);
  state.agents.push({ id: "f", name: "F", nodes: ["fmt.a"] });
  const l = await layoutStructure(buildModel(state, [], { now: NOW }), { elk });
  assert.equal(l.tokens.find((t) => t.id === "f").at, "fmt");
  assert.equal(l.nodes.find((n) => n.id === "fmt").height, 52 + 34);
});

test("layoutStructure needs an ELK instance", async () => {
  await assert.rejects(layoutStructure(buildModel(STATE, [], { now: NOW })), /elk/);
});

test("highlightSet keeps a part with its ancestors and descendants", async () => {
  const l = await layoutStructure(buildModel(STATE, EVENTS, { now: NOW }), { elk });
  assert.deepEqual([...highlightSet(l, { node: "ui" })].sort(), ["ui", "ui.list", "ui.tree"]);
  assert.deepEqual([...highlightSet(l, { node: "ui.tree" })].sort(), ["ui", "ui.tree"]);
});

test("highlightSet keeps the parts an agent is on, with their groups", async () => {
  const l = await layoutStructure(buildModel(STATE, EVENTS, { now: NOW }), { elk });
  assert.deepEqual([...highlightSet(l, { agent: "main" })].sort(), ["ui", "ui.list", "ui.tree"]);
});

test("highlightSet returns null when nothing is highlighted", async () => {
  const l = await layoutStructure(buildModel(STATE, EVENTS, { now: NOW }), { elk });
  assert.equal(highlightSet(l, {}), null);
  assert.equal(highlightSet(l, { node: "missing" }), null);
});

test("resamplePoints returns n finite points, keeping both ends", () => {
  const out = resamplePoints([[0, 0], [10, 0], [10, 10]], 5);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[4], [10, 10]);
  assert.deepEqual(out[2], [10, 0]);
  assert.deepEqual(resamplePoints([], 5), []);
  assert.equal(resamplePoints([[3, 3]], 4).length, 4);
  assert.ok(resamplePoints([[0, 0], [NaN, 1], [4, 4]], 1).flat().every(Number.isFinite));
});

test("layoutAgents centres the lead and rings the rest", () => {
  assert.deepEqual(layoutAgents([]), []);
  const one = layoutAgents([{ id: "solo" }], { width: 200, height: 100 });
  assert.deepEqual(one, [{ id: "solo", x: 100, y: 46 }]);
  const many = layoutAgents([{ id: "a" }, { id: "main" }, { id: "b" }, { id: "c" }], { width: 200, height: 100, rx: 50, ry: 30 });
  assert.deepEqual(many.map((p) => p.id), ["a", "main", "b", "c"]);
  assert.deepEqual(many[1], { id: "main", x: 100, y: 46 });
  assert.ok(Math.abs(many[0].y - 16) < 1e-9); // the first of the others sits at the top
});

test("edgePath draws a quadratic curve between the two points", () => {
  assert.equal(edgePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.1), "M0,0Q50,10,100,0");
});

test("messagesSince returns only new messages between different agents", () => {
  const m = messagesSince(EVENTS, 1);
  assert.deepEqual(m.map((e) => e.text), ["Help", "Hi"]);
  assert.deepEqual(messagesSince(EVENTS, 99), []);
});

test("formatAgo picks a readable unit", () => {
  const cases = [[0, "just now"], [-5000, "just now"], [12_000, "12s ago"], [300_000, "5m ago"], [3 * 3600_000, "3h ago"], [72 * 3600_000, "3d ago"]];
  for (const [ago, expected] of cases) assert.equal(formatAgo(NOW - ago, NOW), expected);
});

const REL_STATE = {
  ...STATE,
  todos: [
    { id: "a", text: "Parent", owner: "helper", children: [{ id: "a1", node: "ui.tree" }, { id: "a2", node: "docs" }] },
    { id: "b", text: "Other", node: "fmt.b", owner: "main" },
  ],
};
const sorted = (set) => [...set].sort();

test("relations from a todo light its parts, owner, parents and sub-todos", async () => {
  const m = buildModel(REL_STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk });
  const r = relations(m, l, { kind: "todo", id: "a1" });
  assert.deepEqual(sorted(r.todos), ["a", "a1"]);
  assert.deepEqual(sorted(r.parts), ["ui", "ui.tree"]);
  const p = relations(m, l, { kind: "todo", id: "a" });
  assert.deepEqual(sorted(p.todos), ["a", "a1", "a2"]);
  assert.deepEqual(sorted(p.parts), ["docs", "ui", "ui.tree"]);
  assert.deepEqual(sorted(p.agents), ["helper"]);
});

test("relations map a todo on a hidden part to its folded group", async () => {
  const m = buildModel(REL_STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk });
  assert.deepEqual(sorted(relations(m, l, { kind: "todo", id: "b" }).parts), ["fmt"]);
});

test("relations from a part light its contents, todos and agents", async () => {
  const m = buildModel(REL_STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk });
  const r = relations(m, l, { kind: "part", id: "ui" });
  assert.deepEqual(sorted(r.parts), ["ui", "ui.list", "ui.tree"]);
  assert.deepEqual(sorted(r.todos), ["a", "a1"]);
  assert.deepEqual(sorted(r.agents), ["main", "scout"]);
});

test("relations from an agent light its parts and the todos it owns", async () => {
  const m = buildModel(REL_STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk });
  const r = relations(m, l, { kind: "agent", id: "main" });
  assert.deepEqual(sorted(r.parts), ["ui", "ui.list", "ui.tree"]);
  assert.deepEqual(sorted(r.todos), ["b"]);
});

test("relations from an event light its part and both agents", async () => {
  const m = buildModel(REL_STATE, EVENTS, { now: NOW });
  const l = await layoutStructure(m, { elk });
  assert.deepEqual(sorted(relations(m, l, { kind: "event", id: 1 }).parts), ["ui", "ui.tree"]);
  assert.deepEqual(sorted(relations(m, l, { kind: "event", id: 2 }).agents), ["helper", "main"]);
});

test("relations returns null for nothing or an unknown target", () => {
  const m = buildModel(REL_STATE, EVENTS, { now: NOW });
  assert.equal(relations(m, null, null), null);
  assert.equal(relations(m, null, { kind: "event", id: 99 }), null);
  assert.equal(relations(m, null, { kind: "mystery", id: "x" }), null);
});

// ---- tests and brainstorming ----------------------------------------------

const TESTS = [
  { id: "map", name: "Map", nodes: ["ui.tree"], passed: 9, failed: 1, failures: [
    { name: "arrows start on their box", node: "fmt.a", cause: "Group offset missing", error: "expected 1 to be 2" },
  ] },
  { id: "list", name: "List", nodes: ["ui.list"], failed: 2 },
  { id: "docs", name: "Docs", nodes: ["docs", "nope"], status: "not_run" },
];
const evs = (list) => parseEvents(list.map((e) => JSON.stringify(e)).join("\n"));
const run = (secondsAgo, extra) => ({ t: at(secondsAgo), agent: "main", type: "test", target: "npm test", ...extra });

test("buildTests takes pass and fail counts from the newest run and keeps Claude's diagnosis", () => {
  const events = evs([run(90, { ok: true, passed: 10, failed: 0 }), run(30, { ok: false, passed: 9, failed: 3, failures: ["arrows start on their box", "list sorts"] })]);
  const m = buildModel({ ...STATE, tests: TESTS }, events, { now: NOW });
  const t = m.tests;
  assert.equal(t.status, "failing");
  assert.equal(t.failed, 3);
  assert.equal(t.passed, 9);
  assert.equal(t.runs.length, 2);
  assert.deepEqual(t.suites.map((s) => [s.id, s.status]), [["map", "failing"], ["list", "failing"], ["docs", "not_run"]]);
  assert.deepEqual(t.suites[2].nodes, ["docs"], "unknown part ids are dropped");
  assert.equal(t.suites[0].failures[0].cause, "Group offset missing");
  assert.deepEqual(t.untraced, ["list sorts"], "a failing name no suite explains is listed apart");
});

test("buildTests clears earlier failures when the newest run passes", () => {
  const events = evs([run(30, { ok: true, passed: 12, failed: 0 })]);
  const t = buildModel({ ...STATE, tests: TESTS }, events, { now: NOW }).tests;
  assert.equal(t.status, "passing");
  assert.ok(t.suites.every((s) => s.failures.length === 0 && s.failed === 0));
  assert.equal(t.suites.find((s) => s.id === "docs").status, "not_run", "a suite that never ran is not called passing");
  assert.equal(t.byNode.size, 0);
});

test("buildTests reports a run in progress, and a crash with no counts as a failure", () => {
  const events = evs([run(60, { ok: false, text: "SyntaxError" }), { t: at(5), agent: "main", type: "test_start", target: "npm test" }]);
  const t = buildModel({ ...STATE, tests: [] }, events, { now: NOW }).tests;
  assert.equal(t.status, "running");
  assert.equal(t.runs[0].ok, false);
  const after = buildModel({ ...STATE }, evs([run(60, { ok: false })]), { now: NOW }).tests;
  assert.equal(after.status, "failing");
});

test("buildTests with no suites and no runs is not_run, and survives junk", () => {
  for (const raw of [undefined, null, "x", 3, [null, "y", { failures: "z" }], { suites: [{ id: "a" }] }]) {
    const t = buildTests(raw, [], new Map());
    assert.ok(["not_run", "failing"].includes(t.status));
    assert.ok(Array.isArray(t.suites) && Array.isArray(t.runs));
  }
});

test("failures sit on their own part, else on the parts their suite covers, and roll up into groups", async () => {
  const m = buildModel({ ...STATE, tests: TESTS }, [], { now: NOW });
  assert.deepEqual([...m.tests.byNode.keys()].sort(), ["fmt.a", "ui.list"]);
  const layout = await layoutStructure(m, { elk, expanded: new Set(["fmt"]) });
  const n = (id) => layout.nodes.find((x) => x.id === id);
  assert.equal(n("fmt.a").failing, 1);
  assert.equal(n("ui.list").failing, 1);
  assert.equal(n("ui.tree").failing, 0);
  assert.equal(n("fmt").failing, 1, "a group counts the failures inside it");
});

test("relations links a failure to its part and a part to its tests", async () => {
  const m = buildModel({ ...STATE, tests: TESTS }, [], { now: NOW });
  const layout = await layoutStructure(m, { elk, expanded: new Set(["fmt"]) });
  const f = relations(m, layout, { kind: "test", id: "map/0" });
  assert.ok(f.parts.has("fmt.a") && f.parts.has("fmt"));
  assert.ok(!f.parts.has("ui.tree"), "a failure points at its own part, not the whole suite");
  assert.ok(f.tests.has("map") && f.tests.has("map/0"));
  const s = relations(m, layout, { kind: "test", id: "map" });
  assert.ok(s.parts.has("ui.tree") && s.parts.has("fmt.a"));
  const p = relations(m, layout, { kind: "part", id: "fmt.a" });
  assert.ok(p.tests.has("map/0"));
  assert.equal(relations(m, layout, { kind: "test", id: "nope" }), null);
});

test("idea parts count as their own status, and from is kept as a list of ids", () => {
  const state = { ...STATE, structure: [...STATE.structure, { id: "x", name: "X", status: "idea", from: "docs" }, { id: "y", status: "idea", from: ["a", "b"] }] };
  const m = buildModel(state, [], { now: NOW });
  assert.equal(m.parts.idea, 2);
  assert.deepEqual(m.byId.get("x").from, ["docs"]);
  assert.deepEqual(m.byId.get("y").from, ["a", "b"]);
  assert.deepEqual(m.byId.get("docs").from, []);
});

test("summarize talks about sketching while brainstorming, and about failing tests while building", () => {
  const b = summarize(buildModel({ ...STATE, session: { ...STATE.session, phase: "brainstorming" } }, [], { now: NOW }));
  assert.match(b.headline, /^Sketching the app: 5 parts so far, 1 still an idea$/);
  const f = summarize(buildModel({ ...STATE, tests: TESTS }, evs([run(10, { ok: false, passed: 5, failed: 2 })]), { now: NOW }));
  assert.match(f.deck, /2 tests failing\.$/);
});

// ---- coverage, status hover, timeline ---------------------------------------

test("toFraction reads 0.84, 84 and 84% the same and rejects junk", () => {
  assert.equal(toFraction(0.84), 0.84);
  assert.equal(toFraction(84), 0.84);
  assert.equal(toFraction("84%"), 0.84);
  assert.equal(toFraction("0.5"), 0.5);
  for (const v of [null, undefined, "", "x", -1, NaN]) assert.equal(toFraction(v), null);
  assert.equal(toFraction(250), 1);
});

test("buildCoverage maps report files to parts by their paths and rolls groups up by part", () => {
  const state = { ...STATE, structure: [
    { id: "ui", name: "UI", paths: ["ui/**"], children: [
      { id: "ui.tree", name: "Tree", paths: ["ui/tree.js"] },
      { id: "ui.list", name: "List", coverage: 0.4 },
      { id: "ui.none", name: "None" },
    ] },
  ] };
  const m = buildModel(state, [], { now: NOW, coverage: { files: { "ui/tree.js": [8, 10], "ui/other.js": [1, 10], "elsewhere.js": [0, 5], "empty.js": [0, 0] } } });
  const c = m.coverage;
  assert.equal(c.byNode.get("ui.tree").pct, 0.8);
  assert.equal(c.byNode.get("ui.tree").band, "good");
  assert.equal(c.byNode.get("ui.list").pct, 0.4);
  assert.ok(c.byNode.get("ui.list").estimated);
  assert.equal(c.byNode.get("ui.none").band, "untested");
  // Group: tree 0.8, list 0.4, and the group's own unclaimed file 0.1, one vote each.
  assert.ok(Math.abs(c.byNode.get("ui").pct - (0.8 + 0.4 + 0.1) / 3) < 1e-9);
  assert.equal(c.covered, 9, "files outside every part are not counted");
  assert.equal(c.total, 20);
  assert.deepEqual([c.bands.good, c.bands.low, c.bands.untested, c.bands.total], [1, 1, 1, 3]);
});

test("buildCoverage counts a part a suite covers as tested even without line data", () => {
  const m = buildModel({ ...STATE, tests: [{ id: "s", nodes: ["docs"], passed: 1 }] }, [], { now: NOW });
  assert.equal(m.coverage.byNode.get("docs").band, "tested");
  assert.equal(m.coverage.pct, null);
  assert.equal(buildCoverage(null).bands.total, 0);
});

test("relations lights every part with a hovered status, todo status or coverage band", async () => {
  const m = buildModel(STATE, [], { now: NOW });
  const layout = await layoutStructure(m, { elk, expanded: new Set(["fmt"]) });
  const done = relations(m, layout, { kind: "status", id: "done" });
  assert.ok(done.parts.has("fmt.a") && done.parts.has("fmt.b") && !done.parts.has("ui.tree"));
  const doing = relations(m, layout, { kind: "todo-status", id: "in_progress" });
  assert.ok(doing.parts.has("ui.tree"));
  assert.ok(doing.agents.has("helper"));
  const none = relations(m, layout, { kind: "coverage", id: "untested" });
  assert.ok(none.parts.has("docs"));
  assert.equal(relations(m, layout, { kind: "status", id: "blocked" }), null, "nothing to light");
});

test("agentCardsData gives working agents a ribbon of runs and message pins, main first", () => {
  const m = buildModel(STATE, EVENTS, { now: NOW });
  const d = agentCardsData(m, { now: NOW });
  assert.equal(d.t1, NOW);
  assert.equal(d.t0, NOW - 600 * 1000);
  assert.equal(d.working[0].id, "main", "main first");
  const main = d.working[0];
  assert.ok(main.runs.some((r) => r.kind === "edit"));
  assert.ok(main.pins.some((p) => p.dir === "out" && p.other === "helper"), "the spawn it sent");
  assert.ok(main.pins.some((p) => p.dir === "in" && p.other === "helper"), "the message it got");
  assert.deepEqual(main.todos, { done: 1, total: 1 });
  const helper = d.working.find((a) => a.id === "helper");
  assert.equal(helper.message.text, "Hi");
  assert.ok(!d.working.some((a) => a.id === "user"), "people get no card");
});

test("agentCardsData stretches an agent's last run to now and joins repeated actions", () => {
  const e = evs([
    { t: at(50), agent: "main", type: "edit", target: "ui/tree.js" },
    { t: at(40), agent: "main", type: "edit", target: "ui/tree.js" },
    { t: at(30), agent: "main", type: "read", target: "a.js" },
    { t: at(25), agent: "main", type: "read", target: "b.js" },
  ]);
  const d = agentCardsData(buildModel(STATE, e, { now: NOW }), { now: NOW });
  const runs = d.working.find((a) => a.id === "main").runs;
  assert.deepEqual(runs.map((r) => [r.kind, r.count]), [["edit", 2], ["read", 2]]);
  assert.ok(runs.at(-1).live);
  assert.equal(runs.at(-1).t1, NOW);
});

test("agentCardsData with no events still gives a window and no cards", () => {
  const d = agentCardsData(buildModel({}, [], { now: NOW }), { now: NOW });
  assert.equal(d.working.length, 0);
  assert.ok(d.t1 > d.t0);
});

test("TEST_FILE spots test files across languages", () => {
  for (const f of ["test/a.test.ts", "src/__tests__/x.js", "a.spec.tsx", "pkg/x_test.go", "tests/test_x.py", "test_y.py"]) assert.ok(TEST_FILE.test(f), f);
  for (const f of ["src/attest.ts", "src/latest.js", "contest/a"]) assert.ok(!TEST_FILE.test(f), f);
});

test("a part counts as tested once Claude writes test files for it, before any suite names it", () => {
  const e = evs([{ t: at(10), agent: "main", type: "edit", node: "ui.list", target: "test/list.test.ts" }]);
  const m = buildModel(STATE, e, { now: NOW });
  assert.equal(m.coverage.byNode.get("ui.list").band, "tested");
  const plain = buildModel(STATE, evs([{ t: at(10), agent: "main", type: "edit", node: "ui.list", target: "src/list.ts" }]), { now: NOW });
  assert.notEqual(plain.coverage.byNode.get("ui.list").band, "tested");
});

test("repairCommaSplits glues text that YAML split at commas back together", () => {
  const raw = { structure: [{ id: "bg.db", name: "IndexedDB (words", "sightings)": null, status: "done" }],
    todos: [{ id: "t1a", text: "package.json", tsconfig: null, "esbuild script": null, status: "done" }] };
  const fixed = repairCommaSplits(raw);
  assert.equal(fixed.structure[0].name, "IndexedDB (words, sightings)");
  assert.ok(!("sightings)" in fixed.structure[0]));
  assert.equal(fixed.todos[0].text, "package.json, tsconfig, esbuild script");
  assert.equal(raw.structure[0].name, "IndexedDB (words", "input untouched");
  const clean = { structure: [{ id: "a", name: "A", note: null }] };
  assert.equal(repairCommaSplits(clean), clean, "known keys with no value are left alone");
  const m = buildModel(raw, [], { now: NOW });
  assert.equal(m.byId.get("bg.db").name, "IndexedDB (words, sightings)");
});
