// FLIP for HTML panels: elements marked data-flip="key" glide from where they
// were to where a re-render put them, instead of jumping. The same key may move
// between containers (an agent's ring in its card and its chip when idle), so
// the element appears to travel from one to the other.

/** Records the on-screen box of every [data-flip] element under `root`. */
export function capture(root) {
  const rects = new Map();
  for (const el of root.querySelectorAll("[data-flip]")) rects.set(el.dataset.flip, el.getBoundingClientRect());
  return rects;
}

/**
 * Animates every [data-flip] element under `root` from its box in `before` to
 * its current box. Elements with no previous box are left alone (their own
 * enter animation applies). duration 0 does nothing.
 */
export function play(root, before, { duration = 600 } = {}) {
  if (!duration || !before?.size) return;
  const moved = [];
  const fresh = [];
  for (const el of root.querySelectorAll("[data-flip]")) {
    const old = before.get(el.dataset.flip);
    // A new row fades up into the gap the others make, rather than landing on top of them mid-move.
    if (!old) { el.style.transition = "none"; el.style.opacity = "0"; el.style.transform = "translateY(-6px)"; fresh.push(el); continue; }
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    const sx = now.width ? old.width / now.width : 1;
    const sy = now.height ? old.height / now.height : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    // Only scale small things (rings, chips); scaling a whole card would squash its text.
    const scale = now.width < 80 && now.height < 80 ? ` scale(${sx},${sy})` : "";
    el.style.transition = "none";
    el.style.transformOrigin = "0 0";
    el.style.transform = `translate(${dx}px,${dy}px)${scale}`;
    moved.push(el);
  }
  if (!moved.length && !fresh.length) return;
  root.getBoundingClientRect(); // one layout read so the start position is applied before the transition
  for (const el of fresh) {
    el.style.transition = `opacity ${duration}ms ease-out ${duration * 0.4}ms, transform ${duration}ms cubic-bezier(.65,0,.35,1) ${duration * 0.4}ms`;
    el.style.opacity = "";
    el.style.transform = "";
    el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
  }
  for (const el of moved) {
    el.style.transition = `transform ${duration}ms cubic-bezier(.65,0,.35,1)`;
    el.style.transform = "";
    el.addEventListener("transitionend", () => { el.style.transition = ""; el.style.transformOrigin = ""; }, { once: true });
  }
}
