// Which projects an export is waiting on right now: their removal pieces are taken first, in the order they were
// queued, ahead of projects nobody is waiting on (Nov 27, four Cuffed & Caught compilations on mandalorian: Gen Alpha's
// export waited on 14 LaMa stretches and 22 watermark cells queued behind 300 of the other three's, its edit otherwise
// done, while nobody waited on theirs yet).

/** Projects with an export waiting on their pieces, and how many waits. */
const waiting = new Map<string, number>();

/** `id`'s export is waiting on its pieces until the returned function is called. */
export function waitedOn(id: string): () => void {
  waiting.set(id, (waiting.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (waiting.get(id) ?? 1) - 1;
    if (left <= 0) waiting.delete(id);
    else waiting.set(id, left);
  };
}

export function isWaitedOn(id: string): boolean {
  return waiting.has(id);
}

/** The next piece off `queue`: the first one an export waits on, else the first one. */
export function takeNext<T extends { project: string }>(queue: T[]): T | undefined {
  if (queue.length === 0) return undefined;
  const at = waiting.size === 0 ? -1 : queue.findIndex((one) => waiting.has(one.project));
  return queue.splice(at >= 0 ? at : 0, 1)[0];
}
