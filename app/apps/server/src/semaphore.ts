// A counting semaphore, in a file of its own with no imports: it was media.ts's, and media.ts sits in a ring of
// imports (media -> framing -> addons -> channels -> ... -> proxy_pieces -> media, since the add-ons of Nov 21), so a
// module in that ring that made one as it loaded met it before it existed ("Cannot access 'Semaphore' before
// initialization") whenever the ring was entered at the wrong file. The server's own start happened to enter it at a
// safe one; a file with no imports is always loaded first.

/** A counting semaphore for async work. */
export class Semaphore {
  private waiting: (() => void)[] = [];

  private readonly all: number;

  constructor(private permits: number) {
    this.all = permits;
  }

  /** Tests: every permit back and nobody waiting (work another test file left running in it is no longer waited for). */
  forgetForTests(): void {
    this.permits = this.all;
    this.waiting = [];
  }

  /** `urgent`: someone is waiting on it now (a viewer's read), so it goes ahead of the background work in line. */
  async acquire(urgent = false): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
    } else {
      await new Promise<void>((resolve) => (urgent ? this.waiting.unshift(resolve) : this.waiting.push(resolve)));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.permits += 1;
    };
  }

  /** Runs `work` holding a permit (`urgent`: ahead of the background work in line). */
  async with<T>(work: () => Promise<T>, urgent = false): Promise<T> {
    const release = await this.acquire(urgent);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
