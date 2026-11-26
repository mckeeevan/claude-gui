import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeColumns, resizeStack, toShares, isShut, readLayout } from "../src/panes.js";

const cols = { left: 300, right: 320, total: 1400 };

test("resizeColumns widens the left column and leaves the right alone", () => {
  assert.deepEqual(resizeColumns(cols, "left", 50), { left: 350, right: 320 });
});

test("resizeColumns: dragging the right divider left widens the right column", () => {
  assert.deepEqual(resizeColumns(cols, "right", -80), { left: 300, right: 400 });
});

test("resizeColumns keeps the map and the sides at their minimums", () => {
  assert.equal(resizeColumns(cols, "left", 5000).left, 1400 - 320 - 320);
  assert.equal(resizeColumns(cols, "left", -5000).left, 200);
  assert.equal(resizeColumns(cols, "right", -5000).right, 1400 - 300 - 320);
});

test("resizeStack moves one divider and keeps the column's height", () => {
  const out = resizeStack([300, 200, 100], 0, 50);
  assert.deepEqual(out, [350, 150, 100]);
  assert.equal(out.reduce((a, b) => a + b), 600);
});

test("resizeStack stops at each panel's header", () => {
  assert.deepEqual(resizeStack([300, 200, 100], 1, 500, [40, 40, 40]), [300, 260, 40]);
  assert.deepEqual(resizeStack([300, 200, 100], 0, -500, [40, 40, 40]), [40, 460, 100]);
});

test("resizeStack ignores a divider that does not exist", () => {
  assert.deepEqual(resizeStack([1, 2], 1, 10), [1, 2]);
  assert.deepEqual(resizeStack([1, 2], -1, 10), [1, 2]);
});

test("toShares turns heights into fractions, and splits evenly when all are zero", () => {
  assert.deepEqual(toShares([100, 300]), [0.25, 0.75]);
  assert.deepEqual(toShares([0, 0]), [0.5, 0.5]);
});

test("isShut is true near the header height", () => {
  assert.equal(isShut(42, 40), true);
  assert.equal(isShut(80, 40), false);
});

test("readLayout keeps good parts and drops bad ones", () => {
  assert.equal(readLayout("not json"), null);
  assert.equal(readLayout("null"), null);
  const l = readLayout(JSON.stringify({ cols: { left: 300, right: "x" }, stacks: { right: [1, 3], left: [1], bad: [1, -2] } }));
  assert.deepEqual(l, { cols: null, stacks: { right: [0.25, 0.75] } });
});
