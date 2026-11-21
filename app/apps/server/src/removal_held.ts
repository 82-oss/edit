// Whether a project says of itself that its channel's removal doesn't start
// by itself (`Project.removal_held`: an edit moved onto a channel, Sphe,
// Nov 21). The removal's code knows a project by its home and id, and the
// store can't be imported from there without a ring, so each store says how
// to ask as it opens and this file imports nothing.

const stores = new Map<string, (id: string) => boolean>();

/** `home`'s store, asked from now on. */
export function tell(home: string, held: (id: string) => boolean): void {
  stores.set(home, held);
}

/** Whether project `id` in `home` holds its removal; false where no store has opened. */
export function held(home: string, id: string): boolean {
  return stores.get(home)?.(id) === true;
}
