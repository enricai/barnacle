/**
 * Tracks which page the recon loop is driving and every capture listener wired
 * so far, so a step that adopts a new tab moves capture onto it and
 * `stopAll` still tears down the listeners on the pages left behind.
 */
export function createCaptureRebinder<P>(
  initial: P,
  wire: (page: P) => () => void
): {
  current: () => P;
  adopt: (page: P) => void;
  stopAll: () => void;
} {
  let page = initial;
  const stoppers: (() => void)[] = [wire(initial)];
  return {
    current: () => page,
    adopt: (next) => {
      if (next === page) return;
      page = next;
      stoppers.push(wire(next));
    },
    stopAll: () => {
      for (const stop of stoppers) stop();
    },
  };
}
