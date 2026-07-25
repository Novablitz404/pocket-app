// Tiny cross-screen handoff: the simulate screen's range pills (1W/1M/…)
// need to land the user back on Home with that range active. Router params
// don't reach an already-mounted screen cleanly, so Home consumes this on
// focus instead.
export type HomeRange = '1W' | '1M' | '1Y' | 'All';

let pendingRange: HomeRange | null = null;

export function setPendingHomeRange(range: HomeRange): void {
  pendingRange = range;
}

/** Returns the requested range once, then clears it. */
export function consumePendingHomeRange(): HomeRange | null {
  const r = pendingRange;
  pendingRange = null;
  return r;
}
