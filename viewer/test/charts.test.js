// DOM tests in jsdom. jsdom has no SVG layout, so these use duration 0 and
// assert on structure and attributes, not geometry.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import ELK from "elkjs/lib/elk.bundled.js";

let select, structureMap, agentCards, agentCardsData, todoList, activityFeed, stackedBar, agentCard, agentRoster, testsPanel, buildModel, layoutStructure, parseEvents;
const elk = new ELK();

const NOW = Date.parse("2026-11-24T21:40:00-05:00");
const STATE = {
  project: "Demo",
  session: { focus: "ui.tree" },
  structure: [
    { id: "ui", name: "UI", status: "active", paths: ["ui/**"], children: [
      { id: "ui.tree", name: "Tree", status: "active", uses: ["fmt.a"] },
      { id: "ui.list", name: "<b>List</b>", status: "blocked", uses: [{ to: "ui.tree", kind: "events" }] },
    ] },
    { id: "fmt", name: "Format", status: "done", children: [{ id: "fmt.a", name: "A", status: "done" }] },
  ],
  agents: [{ id: "main", name: "Claude", role: "Lead", about: "Plans the work.", nodes: ["ui.tree"],
    skills: ["a-skill", { name: "b-skill", description: "Does B" }, "c", "d", "e"] }],
  todos: [
    { id: "t1", text: "<script>alert(1)</script>", status: "pending" },
    { id: "t2", text: "Doing", owner: "main", node: "ui.tree", children: [
      { id: "t2a", text: "Half", status: "done" },
      { id: "t2b", text: "Other half", status: "in_progress" },
    ] },
  ],
};
const EVENTS_TEXT = [
  { t: "2026-11-24T21:39:00-05:00", agent: "main", type: "spawn", to: "helper", text: "Go" },
  { t: "2026-11-24T21:39:30-05:00", agent: "helper", type: "edit", target: "ui/a.js" },
].map((e) => JSON.stringify(e)).join("\n");

before(async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  ({ select } = await import("d3"));
  ({ structureMap } = await import("../src/structure-chart.js"));
  ({ agentCards } = await import("../src/agent-chart.js"));
  ({ todoList, activityFeed, stackedBar, agentCard, agentRoster, testsPanel } = await import("../src/panels.js"));
  ({ buildModel, layoutStructure, parseEvents, agentCardsData } = await import("../src/model.js"));
});

const model = (state = STATE) => buildModel(state, parseEvents(EVENTS_TEXT), { now: NOW });
const container = (tag = "div") => select(document.body).append(tag).node();
const byId = (el, sel, id) => [...el.querySelectorAll(sel)].find((g) => g.__data__.id === id);

test("structureMap draws a group box per open group and a box per part, with a title", async () => {
  const el = container();
  const layout = await layoutStructure(model(), { elk });
  select(el).datum(layout).call(structureMap().duration(0));
  const svg = el.querySelector("svg.map");
  assert.equal(svg.getAttribute("role"), "group");
  assert.equal(svg.querySelector("title").textContent, "Structure of the app");
  assert.match(svg.querySelector("desc").textContent, /Working on Tree/);
  assert.equal(el.querySelectorAll("g.part.group").length, layout.nodes.filter((n) => n.container).length);
  assert.equal(el.querySelectorAll("g.part.leaf").length, layout.nodes.filter((n) => !n.container).length);
  assert.equal(el.querySelectorAll("path.dep").length, layout.edges.length);
});

test("structureMap shows status as a class and a word, not color alone", async () => {
  const el = container();
  select(el).datum(await layoutStructure(model(), { elk })).call(structureMap().duration(0));
  const blocked = byId(el, "g.leaf", "ui.list");
  assert.ok(blocked.classList.contains("st-blocked"));
  assert.equal(blocked.querySelector("text.sub").textContent, "blocked");
  assert.match(blocked.getAttribute("aria-label"), /Blocked/);
});

test("structureMap sets names as text, so markup in names is not parsed", async () => {
  const el = container();
  select(el).datum(await layoutStructure(model(), { elk })).call(structureMap().duration(0));
  assert.equal(el.querySelectorAll("svg b").length, 0);
  assert.equal(byId(el, "g.leaf", "ui.list").querySelector("text.name").textContent, "<b>List</b>");
});

test("structureMap styles arrows by kind and by whether they touch live work", async () => {
  const el = container();
  select(el).datum(await layoutStructure(model(), { elk })).call(structureMap().duration(0));
  const ev = byId(el, "path.dep", "ui.list>ui.tree");
  assert.ok(ev.classList.contains("kind-events"));
  assert.ok(ev.classList.contains("hot"));
  assert.ok(!/NaN|undefined/.test(ev.getAttribute("d")));
});

test("structureMap puts working agents' tokens on their part and parks the rest", async () => {
  const el = container();
  const m = model();
  const chart = structureMap().duration(0).agentInfo((id) => m.agents.find((a) => a.id === id));
  select(el).datum(await layoutStructure(m, { elk })).call(chart);
  const tokens = Object.fromEntries([...el.querySelectorAll("g.token")].map((g) => [g.__data__.id, g]));
  assert.deepEqual(Object.keys(tokens).sort(), ["helper", "main"]);
  assert.equal(tokens.main.__data__.at, "ui.tree");
  assert.equal(tokens.main.querySelector("text.ini").textContent, "Cl");
  assert.ok(!tokens.main.classList.contains("parked"));
  assert.ok(byId(el, "g.leaf", "ui.tree").classList.contains("focus"));
});

test("structureMap reports hovering and clicking an agent token", async () => {
  const el = container();
  const m = model();
  const calls = [];
  const chart = structureMap().duration(0).agentInfo((id) => m.agents.find((a) => a.id === id))
    .onAgentHover((id) => calls.push(["hover", id])).onAgentClick((id) => calls.push(["click", id]));
  select(el).datum(await layoutStructure(m, { elk })).call(chart);
  const tok = [...el.querySelectorAll("g.token")].find((g) => g.__data__.id === "main");
  tok.dispatchEvent(new window.FocusEvent("focus"));
  tok.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(calls, [["hover", "main"], ["click", "main"]]);
});

test("structureMap lights related parts and agents and fades the rest", async () => {
  const el = container();
  const chart = structureMap().duration(0);
  select(el).datum(await layoutStructure(model(), { elk })).call(chart);
  chart.highlight({ parts: new Set(["ui", "ui.tree"]), agents: new Set(["main"]) }).refreshHighlight(select(el));
  assert.ok(byId(el, "g.leaf", "ui.tree").classList.contains("lit"));
  assert.ok(byId(el, "g.leaf", "ui.list").classList.contains("dim"));
  const tok = (id) => [...el.querySelectorAll("g.token")].find((g) => g.__data__.id === id);
  assert.ok(tok("main").classList.contains("lit"));
  assert.ok(tok("helper").classList.contains("dim"));
});

test("structureMap folds a group on Enter through onToggle", async () => {
  const el = container();
  const toggled = [];
  select(el).datum(await layoutStructure(model(), { elk })).call(structureMap().duration(0).onToggle((id) => toggled.push(id)));
  const folded = byId(el, "g.leaf", "fmt");
  assert.equal(folded.getAttribute("aria-expanded"), "false");
  folded.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  byId(el, "g.group", "ui").dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  assert.deepEqual(toggled, ["fmt", "ui"]);
});

test("structureMap keeps elements for the same parts across updates", async () => {
  const el = container();
  const chart = structureMap().duration(0);
  select(el).datum(await layoutStructure(model(), { elk })).call(chart);
  const before = byId(el, "g.leaf", "ui.tree");
  select(el).datum(await layoutStructure(model(), { elk, expanded: new Set(["fmt"]) })).call(chart);
  assert.equal(byId(el, "g.leaf", "ui.tree"), before);
  assert.ok(byId(el, "g.leaf", "fmt.a"));
  assert.ok(byId(el, "g.group", "fmt"));
});

test("structureMap dims parts outside the highlight", async () => {
  const el = container();
  const chart = structureMap().duration(0);
  select(el).datum(await layoutStructure(model(), { elk })).call(chart);
  chart.highlight(new Set(["ui", "ui.tree"])).refreshHighlight(select(el));
  const dimmed = [...el.querySelectorAll("g.part.dim")].map((g) => g.__data__.id).sort();
  assert.deepEqual(dimmed, ["fmt", "ui.list"]);
});

test("structureMap.destroy removes the drawing", async () => {
  const el = container();
  const chart = structureMap().duration(0);
  select(el).datum(await layoutStructure(model(), { elk })).call(chart);
  chart.destroy(select(el));
  assert.equal(el.querySelectorAll("svg").length, 0);
});

test("the getter-setters return the chart for chaining", () => {
  const chart = structureMap();
  assert.equal(chart.duration(0), chart);
  assert.equal(chart.duration(), 0);
  const g = agentCards();
  assert.equal(g.width(500).duration(0), g);
  assert.equal(g.width(), 500);
});

const cardsDatum = (now = NOW) => ({ data: agentCardsData(model(), { now }), partName: (id) => id, now });

test("agentCards draws a card per working agent with a ring, a ribbon of runs and message pins", () => {
  const el = container();
  const hovered = [];
  select(el).datum(cardsDatum()).call(agentCards().duration(0).width(300).onHover((t) => hovered.push(t)));
  assert.deepEqual([...el.querySelectorAll("div.ag .nm")].map((t) => t.textContent), ["Claude", "helper"]);
  assert.equal(el.querySelectorAll("div.ag svg.ring").length, 2);
  assert.ok(el.querySelector("g.run.k-edit"), "the helper's edit is a run");
  assert.ok(el.querySelector("g.pin.out") && el.querySelector("g.pin.in"), "the spawn pins both agents");
  el.querySelector("g.run").dispatchEvent(new window.Event("mouseenter"));
  assert.deepEqual(hovered.at(-1), { kind: "event", id: 1 });
});

test("agentCards opens a card through onToggle and keeps cards above the axis", () => {
  const el = container();
  const toggled = [];
  const chart = agentCards().duration(0).onToggle((id) => toggled.push(id));
  select(el).datum(cardsDatum()).call(chart);
  el.querySelector("div.ag button.hd").dispatchEvent(new window.Event("click"));
  assert.deepEqual(toggled, ["main"]);
  chart.open(new Set(["main"]));
  select(el).datum(cardsDatum()).call(chart);
  assert.ok(el.querySelector("div.ag").classList.contains("open"));
  assert.equal(el.querySelector("div.ag button.hd").getAttribute("aria-expanded"), "true");
  const kids = [...el.children].map((c) => c.className);
  assert.ok(kids.indexOf("cards") < kids.indexOf("axis"));
});

test("agentCards keeps each card's element across updates", () => {
  const el = container();
  const chart = agentCards().duration(0);
  select(el).datum(cardsDatum()).call(chart);
  const card = el.querySelector("div.ag");
  select(el).datum(cardsDatum(NOW + 5000)).call(chart);
  assert.equal(el.querySelector("div.ag"), card);
  assert.equal(el.querySelectorAll("div.ag").length, 2);
});

test("todoList indents sub-todos under their parent and shows the parent's progress", () => {
  const el = container("ul");
  select(el).datum(model()).call(todoList());
  const rows = [...el.querySelectorAll("li.todo")];
  assert.deepEqual(rows.map((r) => `${r.__data__.depth}:${r.__data__.key}`), ["0:t2", "1:t2b", "1:t2a", "0:t1"]);
  assert.equal(rows[0].querySelector(".prog").textContent, "1/2");
  assert.equal(rows[0].getAttribute("aria-expanded"), "true");
  assert.equal(rows[1].getAttribute("aria-level"), "2");
});

test("todoList escapes text", () => {
  const el = container("ul");
  select(el).datum(model()).call(todoList());
  assert.equal(el.querySelectorAll("script").length, 0);
  const t1 = [...el.querySelectorAll("li.todo")].find((li) => li.__data__.key === "t1");
  assert.equal(t1.querySelector(".ttl").textContent, "<script>alert(1)</script>");
});

test("todoList's fold button reports the todo and whether it was folded", () => {
  const el = container("ul");
  const calls = [];
  select(el).datum(model()).call(todoList().onToggle((key, folded) => calls.push([key, folded])));
  el.querySelector("li.todo button.fold").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(calls, [["t2", false]]);
});

test("todoList reports the hovered todo by key", () => {
  const el = container("ul");
  const seen = [];
  select(el).datum(model()).call(todoList().onHover((k) => seen.push(k)));
  el.querySelector("li.todo").dispatchEvent(new window.MouseEvent("mouseenter"));
  assert.deepEqual(seen, ["t2"]);
});

test("todoList hides children of a collapsed parent", () => {
  const el = container("ul");
  select(el).datum(model()).call(todoList().collapsed(new Set(["t2"])));
  assert.deepEqual([...el.querySelectorAll("li.todo")].map((r) => r.__data__.key), ["t2", "t1"]);
});

test("todoList keeps each todo's element when the order changes", () => {
  const el = container("ul");
  const chart = todoList();
  select(el).datum(model()).call(chart);
  const t1 = [...el.querySelectorAll("li.todo")].find((li) => li.__data__.key === "t1");
  const moved = structuredClone(STATE);
  moved.todos[0].status = "in_progress";
  moved.todos[1].children.forEach((c) => { c.status = "done"; });
  select(el).datum(buildModel(moved, [], { now: NOW })).call(chart);
  assert.equal(el.querySelector("li.todo"), t1);
});

test("todoList shows an empty message when there are no todos", () => {
  const el = container("ul");
  select(el).datum(buildModel({}, [], { now: NOW })).call(todoList());
  assert.equal(el.querySelectorAll("li.empty").length, 1);
  assert.equal(el.querySelectorAll("li.todo").length, 0);
});

test("stackedBar places segments end to end and labels the wide ones", () => {
  const el = container();
  select(el).datum({ total: 10, done: 5, active: 1, blocked: 0, planned: 4, untouched: 0 }).call(stackedBar());
  const segs = [...el.querySelectorAll(".seg")];
  assert.deepEqual(segs.map((d) => [d.style.left, d.style.width]), [["0%", "50%"], ["50%", "10%"], ["60%", "0%"], ["60%", "40%"], ["100%", "0%"], ["100%", "0%"]]);
  assert.deepEqual(segs.map((d) => d.textContent), ["5 done", "", "", "4 planned", "", ""]);
  assert.equal(el.getAttribute("aria-label"), "5 done, 1 working, 4 planned");
});

test("stackedBar survives an empty set", () => {
  const el = container();
  select(el).datum({ total: 0 }).call(stackedBar());
  assert.ok([...el.querySelectorAll(".seg")].every((d) => d.style.width === "0%"));
  assert.equal(el.getAttribute("aria-label"), "Nothing yet");
});

test("activityFeed lists newest first and flashes only rows added since the last call", () => {
  const el = container("ul");
  const feed = activityFeed().formatTime(() => "t");
  select(el).datum(model()).call(feed);
  let rows = [...el.querySelectorAll("li.ev")];
  assert.deepEqual(rows.map((r) => r.querySelector(".verb").textContent), ["edited", "started"]);
  assert.equal(el.querySelectorAll("li.new").length, 0);
  const more = buildModel(STATE, parseEvents(EVENTS_TEXT + "\n" + JSON.stringify({ t: "2026-11-24T21:39:50-05:00", agent: "main", type: "run", target: "npm test" })), { now: NOW });
  select(el).datum(more).call(feed);
  rows = [...el.querySelectorAll("li.ev")];
  assert.equal(rows[0].querySelector(".tgt").textContent, "npm test");
  assert.deepEqual([...el.querySelectorAll("li.new")], [rows[0]]);
});

test("agentRoster folds each agent's skills into a disclosure", () => {
  const el = container();
  select(el).datum(model().agents).call(agentRoster());
  const row = [...el.querySelectorAll("div.arow")].find((r) => r.__data__.id === "main");
  assert.equal(row.querySelector("summary").textContent, "5 skills");
  assert.deepEqual([...row.querySelectorAll("details li code")].map((c) => c.textContent), ["a-skill", "b-skill", "c", "d", "e"]);
  const helper = [...el.querySelectorAll("div.arow")].find((r) => r.__data__.id === "helper");
  assert.ok(helper.querySelector("details").hasAttribute("hidden"));
});

test("agentCard explains the agent and shows a few skills until it is pinned", () => {
  const el = container();
  const agent = model().agents.find((a) => a.id === "main");
  const datum = { agent, todoCount: 1, now: NOW, pinned: false, partName: (id) => `part ${id}` };
  select(el).datum(datum).call(agentCard());
  const facts = Object.fromEntries([...el.querySelectorAll(".fact")].map((f) => [f.querySelector("dt").textContent, f.querySelector("dd").textContent]));
  assert.equal(facts["What it's for"], "Plans the work.");
  assert.equal(facts.Where, "part ui.tree");
  assert.equal(facts.Todos, "1 assigned");
  assert.equal(el.querySelectorAll(".card-skills li").length, 4);
  assert.match(el.querySelector(".hint").textContent, /1 more/);
  assert.ok(el.querySelector(".card-close").hasAttribute("hidden"));
  select(el).datum({ ...datum, pinned: true }).call(agentCard());
  assert.equal(el.querySelectorAll(".card-skills li").length, 5);
  assert.equal([...el.querySelectorAll(".card-skills li span")].map((s) => s.textContent).join("|"), "|Does B|||");
  assert.ok(!el.querySelector(".card-close").hasAttribute("hidden"));
});

// ---- tests panel, failing parts, and parts that split ----------------------

const TESTS = [
  { id: "ok", name: "Fine", nodes: ["fmt.a"], passed: 4, failed: 0 },
  { id: "map", name: "Map", nodes: ["ui.tree"], passed: 9, failed: 1, failures: [
    { name: "<i>arrows</i>", node: "ui.list", cause: "Group offset missing", error: "expected 1 to be 2" },
    { name: "no cause yet" },
  ] },
];

test("testsPanel shows coverage and pass/fail, each failure with where and why, and the weakest parts", () => {
  const el = container();
  const events = parseEvents([
    { t: "2026-11-24T21:38:00-05:00", agent: "main", type: "test", ok: true, passed: 13, failed: 0 },
    { t: "2026-11-24T21:39:00-05:00", agent: "main", type: "test", ok: false, passed: 13, failed: 1, failures: ["<i>arrows</i>", "mystery"] },
  ].map((e) => JSON.stringify(e)).join("\n"));
  const state = { ...STATE, structure: STATE.structure.map((n) => (n.id === "ui" ? { ...n, children: [{ ...n.children[0], paths: ["ui/tree.js"] }, n.children[1]] } : n)), tests: TESTS };
  const m = buildModel(state, events, { now: NOW, coverage: { files: { "ui/tree.js": [3, 4] } } });
  const hovered = [];
  select(el).datum({ tests: m.tests, coverage: m.coverage, byId: m.byId, now: NOW }).call(testsPanel().onHover((k) => hovered.push(k)));
  assert.equal(el.querySelector(".tnum.cov b").textContent, "75%");
  assert.equal(el.querySelector(".tnum.pass b").textContent, "✕ 1");
  assert.equal(el.querySelector(".tnum.pass span").textContent, "test failing");
  const f = el.querySelectorAll("li.failure");
  assert.equal(f.length, 3, "two explained, one untraced");
  assert.equal(f[0].querySelector(".fname").textContent, "<i>arrows</i>");
  assert.equal(f[0].querySelector("i"), null, "names are text, never markup");
  assert.equal(f[0].querySelector(".fwhere").textContent, "Broken in <b>List</b>");
  assert.equal(f[0].querySelector(".fcause").textContent, "Group offset missing");
  assert.equal(f[1].querySelector(".fcause").textContent, "Cause not found yet");
  assert.deepEqual([...el.querySelectorAll(".weak li .wname")].map((n) => n.textContent), ["Tree"]);
  assert.match(el.querySelector(".weak .untested").textContent, /^No tests \(\d+\): /);
  assert.equal(el.querySelectorAll("g.run").length, 2);
  f[0].dispatchEvent(new window.Event("mouseenter"));
  assert.deepEqual(hovered, [{ kind: "test", id: "map/0" }]);
});

test("testsPanel says when nothing has run yet", () => {
  const el = container();
  const m = buildModel(STATE, [], { now: NOW });
  select(el).datum({ tests: m.tests, coverage: m.coverage, byId: m.byId, now: NOW }).call(testsPanel());
  assert.equal(el.querySelector(".tnum.pass span").textContent, "no runs yet");
  assert.equal(el.querySelector(".tnum.cov b").textContent, "–");
  assert.ok(el.querySelector(".runs").hasAttribute("hidden"));
  assert.ok(el.querySelector("ul.failures").hasAttribute("hidden"));
});

test("structureMap's tests lens shades parts by coverage and hatches untested ones", async () => {
  const el = container();
  const state = { ...STATE, structure: [{ id: "a", name: "A", paths: ["a/**"] }, { id: "b", name: "B", coverage: "20%" }, { id: "c", name: "C" }] };
  const layout = await layoutStructure(buildModel(state, [], { now: NOW, coverage: { files: { "a/x.js": [9, 10] } } }), { elk });
  const chart = structureMap().duration(0).lens("tests");
  select(el).datum(layout).call(chart);
  const box = (id) => byId(el, "g.part.leaf", id);
  assert.ok(el.querySelector("svg.map").classList.contains("lens-tests"));
  assert.match(box("a").querySelector("text.sub").textContent, /^90% covered$/);
  assert.ok(box("a").classList.contains("on-dark"), "deep fill gets light text");
  assert.match(box("b").querySelector("text.sub").textContent, /^20% est\. covered$/);
  assert.equal(box("c").querySelector("text.sub").textContent, "no tests");
  assert.match(box("c").querySelector("rect.box").style.fill, /url\(/);
  chart.lens("work");
  select(el).datum(layout).call(chart);
  assert.equal(box("a").querySelector("rect.box").style.fill, "", "work lens leaves fills to the stylesheet");
});

test("structureMap badges a part with failing tests and says so in its label", async () => {
  const el = container();
  const layout = await layoutStructure(buildModel({ ...STATE, tests: TESTS }, [], { now: NOW }), { elk });
  select(el).datum(layout).call(structureMap().duration(0));
  const list = byId(el, "g.part.leaf", "ui.list");
  assert.ok(list.classList.contains("failing"));
  assert.equal(list.querySelector("g.fail-badge text").textContent, "✕");
  assert.match(list.getAttribute("aria-label"), /1 failing test/);
  // "no cause yet" names no part, so it sits on the part its suite covers.
  assert.ok(byId(el, "g.part.leaf", "ui.tree").classList.contains("failing"));
  assert.ok(!byId(el, "g.part.leaf", "fmt").classList.contains("failing"));
});

test("structureMap grows parts split from another out of that part's old box", async () => {
  const el = container();
  const before = { ...STATE, structure: [{ id: "x", name: "X", status: "idea" }, { id: "y", name: "Y", status: "idea" }] };
  const after = { ...STATE, structure: [
    { id: "x1", name: "X one", status: "idea", from: "x" },
    { id: "x2", name: "X two", status: "idea", from: "x" },
    { id: "y", name: "Y", status: "idea", children: [{ id: "y.a", name: "Y a" }] },
  ] };
  const map = structureMap().duration(0);
  const l1 = await layoutStructure(buildModel(before, [], { now: NOW }), { elk });
  select(el).datum(l1).call(map);
  const old = l1.nodes.find((n) => n.id === "x");
  const oldY = l1.nodes.find((n) => n.id === "y");
  map.duration(700);
  const l2 = await layoutStructure(buildModel(after, [], { now: NOW }), { elk });
  select(el).datum(l2).call(map);
  const centre = (b) => `translate(${b.x + b.width / 2},${b.y + b.height / 2})`;
  for (const id of ["x1", "x2"]) {
    const g = [...el.querySelectorAll("g.part.leaf")].find((n) => n.__data__.id === id);
    assert.ok(g.getAttribute("transform").startsWith(centre(old)), `${id} starts where X was`);
    assert.equal(+g.querySelector("rect.box").getAttribute("width"), old.width);
  }
  const ya = [...el.querySelectorAll("g.part.leaf")].find((n) => n.__data__.id === "y.a");
  assert.ok(ya.getAttribute("transform").startsWith(centre(oldY)), "a new child grows out of its parent's old box");
  const group = [...el.querySelectorAll("g.part.group")].find((n) => n.__data__.id === "y");
  assert.ok(group.getAttribute("transform").startsWith(centre(oldY)), "a part that gains children opens out of its old box");
  map.destroy(select(el));
});
