// The inset map: pure viewport maths in Node, and the drawn inset in jsdom.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import ELK from "elkjs/lib/elk.bundled.js";

let select, minimap, viewportOf, scrollToCenter, buildModel, layoutStructure;
const elk = new ELK();
const STATE = { project: "P", structure: [
  { id: "a", name: "A", status: "active", children: [{ id: "a1", name: "One", status: "active", uses: ["b"] }, { id: "a2", name: "Two", status: "done" }] },
  { id: "b", name: "B", status: "planned" },
] };

before(async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  ({ select } = await import("d3"));
  ({ minimap, viewportOf, scrollToCenter } = await import("../src/minimap.js"));
  ({ buildModel, layoutStructure } = await import("../src/model.js"));
});

test("viewportOf reports the whole map when it all fits", () => {
  const v = viewportOf({ left: 10, top: 10, width: 400, height: 300 }, { left: 0, top: 0, right: 800, bottom: 600 }, [0, 0, 400, 300]);
  assert.deepEqual(v, { x: 0, y: 0, width: 400, height: 300, full: true });
});

test("viewportOf converts the visible slice of a scrolled map to layout units", () => {
  // Map drawn at 2x, scrolled 200px right and 100px down inside a 300x200 box.
  const v = viewportOf({ left: -200, top: -100, width: 1600, height: 1200 }, { left: 0, top: 0, right: 300, bottom: 200 }, [-6, -20, 800, 600]);
  assert.deepEqual(v, { x: 94, y: 30, width: 150, height: 100, full: false });
});

test("viewportOf ignores a sliver hidden under a scrollbar", () => {
  const v = viewportOf({ left: 0, top: 0, width: 767, height: 379 }, { left: 0, top: 0, right: 764, bottom: 600 }, [0, 0, 767, 379]);
  assert.equal(v.full, true);
});

test("viewportOf treats an unmeasured map as fully visible", () => {
  assert.equal(viewportOf({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, right: 10, bottom: 10 }, [0, 0, 100, 100]).full, true);
});

test("scrollToCenter moves the visible box so the point sits in its middle", () => {
  assert.deepEqual(scrollToCenter({ x: 300, y: 50 }, { x: 0, y: 0, width: 200, height: 100 }, 2), { dx: 400, dy: 0 });
});

test("minimap draws every box and the viewport, and shows only when the map does not fit", async () => {
  const layout = await layoutStructure(buildModel(STATE, [], { now: Date.now() }), { elk });
  const el = select(document.body).append("div").node();
  const chart = minimap().duration(0);
  select(el).datum({ layout, view: { x: 0, y: 0, width: 50, height: 40, full: false } }).call(chart);
  assert.equal(el.classList.contains("on"), true);
  assert.equal(el.querySelectorAll("g.boxes rect").length, layout.nodes.length + (layout.shelf ? 1 : 0)); // the done shelf too
  assert.ok(el.querySelector("g.boxes rect.leaf.st-active"));
  assert.equal(el.querySelector("rect.view").getAttribute("width"), "50");
  const svg = el.querySelector("svg.mini");
  assert.equal(Math.round(Math.max(+svg.getAttribute("width"), +svg.getAttribute("height"))), chart.size());
  select(el).datum({ layout, view: { x: 0, y: 0, width: layout.width, height: layout.height, full: true } }).call(chart);
  assert.equal(el.classList.contains("on"), false);
});

test("minimap reports the clicked point in layout units", async () => {
  const layout = await layoutStructure(buildModel(STATE, [], { now: Date.now() }), { elk });
  const el = select(document.body).append("div").node();
  let got = null;
  select(el).datum({ layout, view: null }).call(minimap().duration(0).onJump((p) => { got = p; }));
  const svg = el.querySelector("svg.mini");
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 });
  svg.dispatchEvent(new window.MouseEvent("click", { clientX: 50, clientY: 25, bubbles: true }));
  assert.deepEqual(got, { x: layout.width / 2, y: layout.height / 2 });
});
