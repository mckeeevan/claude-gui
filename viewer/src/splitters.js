// Draggable dividers for the wide dashboard: between the three columns, and
// between the panels stacked in a side column. Drag, or focus a divider and use
// the arrow keys; double-click puts that divider's panels back to their defaults.
// Sizes are kept per viewer in localStorage. Only the wide (one-screen) layout
// has dividers; narrower screens stack everything and hide them.
import { resizeColumns, resizeStack, toShares, isShut, readLayout } from "./panes.js";

const KEY = "claude-gui.layout";
const STEP = 24; // px per arrow key press

/**
 * Wires every `.split` element under `root`. A column divider has
 * `data-col="left|right"`; a stack divider has `data-stack="<name>"` and
 * `data-i` (the pane above it), and sits between the children of the element
 * with `data-stack-host="<name>"` that carry `data-pane`.
 * `onChange()` is called once a drag or key press ends, so the page can refit.
 * Returns { destroy }.
 */
export function splitters(root, { onChange = () => {}, active = () => true } = {}) {
  const dash = root.querySelector(".dash");
  let saved = load() ?? { cols: null, stacks: {} };
  const panes = (name) => [...root.querySelectorAll(`[data-stack-host="${name}"] > [data-pane]`)];
  const minOf = (pane) => {
    const head = pane.querySelector(".sec-head, .crumb");
    return head ? head.offsetTop - pane.offsetTop + head.offsetHeight + 2 : 32;
  };

  function applyCols(c) {
    if (!dash) return;
    dash.style.setProperty("--w-left", c ? `${Math.round(c.left)}px` : null);
    dash.style.setProperty("--w-right", c ? `${Math.round(c.right)}px` : null);
  }
  function applyStack(name, shares) {
    const ps = panes(name);
    ps.forEach((p, k) => {
      p.style.flex = shares ? `${shares[k]} 1 0px` : "";
      p.classList.toggle("sized", !!shares);
    });
    markShut(name);
  }
  function markShut(name) {
    for (const p of panes(name)) p.classList.toggle("shut", p.classList.contains("sized") && isShut(p.offsetHeight, minOf(p)));
  }
  function applyAll() {
    applyCols(saved.cols);
    for (const name of new Set([...root.querySelectorAll("[data-stack-host]")].map((h) => h.dataset.stackHost))) {
      applyStack(name, saved.stacks[name] ?? null);
    }
  }

  function measureCols() {
    const [l, , , , r] = [...dash.children];
    return { left: l.offsetWidth, right: r.offsetWidth, total: dash.clientWidth - 2 * root.querySelector(".split[data-col]").offsetWidth };
  }

  // One move, from the sizes when the drag began, so rounding never drifts.
  function mover(el) {
    if (el.dataset.col) {
      const start = measureCols();
      return (d) => { saved.cols = resizeColumns(start, el.dataset.col, d); applyCols(saved.cols); };
    }
    const name = el.dataset.stack;
    const ps = panes(name);
    const start = ps.map((p) => p.offsetHeight);
    const mins = ps.map(minOf);
    return (d) => { saved.stacks[name] = toShares(resizeStack(start, Number(el.dataset.i), d, mins)); applyStack(name, saved.stacks[name]); };
  }
  const axis = (el) => (el.dataset.col ? "clientX" : "clientY");

  const cleanups = [];
  for (const el of root.querySelectorAll(".split")) {
    const vertical = !!el.dataset.col;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
    el.tabIndex = 0;
    let move = null;
    let from = 0;
    let frame = 0;
    const down = (e) => {
      if (!active() || e.button !== 0) return;
      e.preventDefault(); // no text selection while dragging
      el.setPointerCapture?.(e.pointerId);
      move = mover(el);
      from = e[axis(el)];
      document.body.classList.add("resizing", vertical ? "resizing-x" : "resizing-y");
      el.classList.add("dragging");
    };
    const drag = (e) => {
      if (!move) return;
      const d = e[axis(el)] - from;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => move(d));
    };
    const up = () => {
      if (!move) return;
      move = null;
      document.body.classList.remove("resizing", "resizing-x", "resizing-y");
      el.classList.remove("dragging");
      done();
    };
    const key = (e) => {
      const d = { ArrowLeft: -STEP, ArrowUp: -STEP, ArrowRight: STEP, ArrowDown: STEP }[e.key];
      if (!d || !active() || (vertical !== (e.key === "ArrowLeft" || e.key === "ArrowRight"))) return;
      e.preventDefault();
      mover(el)(d);
      done();
    };
    const reset = () => {
      if (el.dataset.col) { saved.cols = null; applyCols(null); }
      else { delete saved.stacks[el.dataset.stack]; applyStack(el.dataset.stack, null); }
      done();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", drag);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("keydown", key);
    el.addEventListener("dblclick", reset);
    cleanups.push(() => {
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", drag);
      el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
      el.removeEventListener("keydown", key); el.removeEventListener("dblclick", reset);
    });
  }

  function done() {
    save(saved);
    for (const name of Object.keys(saved.stacks)) markShut(name);
    onChange();
  }

  applyAll();
  return { destroy: () => cleanups.forEach((f) => f()), refresh: () => Object.keys(saved.stacks).forEach(markShut) };
}

function load() {
  try { return readLayout(localStorage.getItem(KEY)); } catch { return null; }
}
function save(layout) {
  try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* private window: sizes just aren't kept */ }
}
