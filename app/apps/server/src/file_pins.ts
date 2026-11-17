// Files an export is reading, held against everything that deletes Edit's own
// files: the cache's cleaner, an effect render's swap into the cache once it
// went up, the renders' sweep and prune, an effect's old renders retired from
// the cloud. Sphe's M4, Nov 17 (nightly-78): an export planned cutfx-10's
// render at effect-renders/, the cloud backfill deleted that file 5 s later
// (its copy now the cache's), and 9 minutes in the export failed on it with
// "Edit can't read that video … download it again". Then Retry's room-making
// took the 7.3 GB export made ahead that the export would have copied every
// chunk from, and it rendered all 88 again. A file pinned here stays until the
// last export holding it lets go; whatever wanted it gone takes it later (the
// sweep, the cleaner's next pass).

/** Paths held, and by how many. */
const held = new Map<string, number>();

/** Whether something holds `path` now (an export reading it, or about to). */
export function pinned(path: string): boolean {
  return (held.get(path) ?? 0) > 0;
}

/** Holds `paths` until the returned function is called (once; again does nothing). */
export function pin(paths: Iterable<string>): () => void {
  const own = [...new Set(paths)].filter((path) => path !== "");
  for (const path of own) held.set(path, (held.get(path) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const path of own) {
      const left = (held.get(path) ?? 1) - 1;
      if (left > 0) held.set(path, left);
      else held.delete(path);
    }
  };
}
