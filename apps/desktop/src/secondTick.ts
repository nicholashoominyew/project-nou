// One shared clock for everything that shows seconds (the flip clocks and their seconds bar, the Now timer, focus mode, the reminder countdown).
// Each of them used to run its own one-second timer, started at a different moment, so their seconds changed at different instants. Now a single
// timer is aimed at the top of each wall-clock second and wakes every listener in the same turn, so all the second counters change together.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function arm(extra = 0) {
  const wait = 1000 - (Date.now() % 1000) + extra; // time to the next whole second
  timer = setTimeout(() => {
    // A timer that fires a hair early would show the old second again: wait out the last few milliseconds first.
    if (Date.now() % 1000 > 985) { arm(15); return; }
    timer = undefined;
    for (const f of [...listeners]) { try { f(); } catch { /* one listener must not stop the others */ } }
    if (listeners.size && timer === undefined) arm();
  }, wait);
}

/** Call `fn` at the start of every second (all listeners together). Returns the function that stops it. */
export function onSecond(fn: () => void): () => void {
  listeners.add(fn);
  if (timer === undefined) arm();
  return () => { listeners.delete(fn); if (!listeners.size && timer !== undefined) { clearTimeout(timer); timer = undefined; } };
}
