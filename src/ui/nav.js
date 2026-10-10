// Back and forward, like a browser: mouse buttons 4 and 5, or Alt+Left and
// Alt+Right. Before each navigation (a view change, a new or picked tab, a
// camera glide to a link) the current place is pushed; back returns to it.
// Calls in one tick count as one navigation.

const back = [];
const forward = [];
const MAX = 100;
let snapshot = () => null;
let restore = () => {};
let restoring = false;
let held = false;

export function initNav(snap, rest) {
  snapshot = snap;
  restore = rest;
  addEventListener("mousedown", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
  addEventListener("mouseup", (e) => {
    if (e.button === 3) go(back, forward);
    if (e.button === 4) go(forward, back);
  });
  addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    if (e.key === "ArrowLeft") go(back, forward);
    else go(forward, back);
  });
}

/** Call before navigating away: remembers where we are. */
export function navigating() {
  if (restoring || held) return;
  held = true;
  setTimeout(() => (held = false));
  const s = snapshot();
  if (!s) return;
  back.push(s);
  if (back.length > MAX) back.shift();
  forward.length = 0;
}

function go(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  restoring = true;
  try {
    restore(from.pop());
  } finally {
    restoring = false;
  }
}
