// Pure sizing logic for the dashboard's draggable dividers. No DOM: app wiring
// (src/splitters.js) measures, calls these, and writes the results as styles.

/**
 * Moves the divider between the side columns and the map by `dx` px.
 * `which` is "left" (the divider right of the left column) or "right".
 * Widths are clamped so each side keeps `minSide` px and the map `minMap` px.
 * Returns new { left, right } widths in px.
 */
export function resizeColumns({ left, right, total }, which, dx, { minSide = 200, minMap = 320 } = {}) {
  const room = (other) => Math.max(minSide, total - other - minMap);
  if (which === "left") return { left: clamp(left + dx, minSide, room(right)), right };
  return { left, right: clamp(right - dx, minSide, room(left)) };
}

/**
 * Moves the divider below panel `i` in a stack by `dy` px. Only panels i and i+1
 * change, and their sum stays the same, so the rest of the column holds still.
 * `mins[k]` is panel k's smallest height (its header, so a panel pulled shut
 * still shows its title). Returns a new array of heights.
 */
export function resizeStack(sizes, i, dy, mins = []) {
  const out = sizes.slice();
  if (i < 0 || i >= sizes.length - 1) return out;
  const a = sizes[i];
  const b = sizes[i + 1];
  const minA = mins[i] ?? 0;
  const minB = mins[i + 1] ?? 0;
  const next = clamp(a + dy, minA, Math.max(minA, a + b - minB));
  out[i] = next;
  out[i + 1] = a + b - next;
  return out;
}

/** Heights as shares of their sum, so a layout survives a window resize. */
export function toShares(sizes) {
  const sum = sizes.reduce((s, v) => s + Math.max(0, v), 0);
  return sum > 0 ? sizes.map((v) => Math.max(0, v) / sum) : sizes.map(() => 1 / (sizes.length || 1));
}

/** True when a panel is pulled down to (about) its header. */
export const isShut = (size, min, slack = 4) => size <= min + slack;

/**
 * Reads a saved layout, keeping only well-formed parts, so a stale or hand-edited
 * value can never break the page. Shape: { cols: {left, right}, stacks: {name: [shares]} }.
 */
export function readLayout(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const out = { cols: null, stacks: {} };
  const c = raw.cols;
  if (c && [c.left, c.right].every((v) => Number.isFinite(v) && v > 0)) out.cols = { left: c.left, right: c.right };
  for (const [k, v] of Object.entries(raw.stacks ?? {})) {
    if (Array.isArray(v) && v.length > 1 && v.every((x) => Number.isFinite(x) && x >= 0)) out.stacks[k] = toShares(v);
  }
  return out;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
