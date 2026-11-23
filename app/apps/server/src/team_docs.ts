// The team's documents (ideas, thumbnails) kept on this computer first, with
// the cloud's copy kept up to date behind them (Sphe, Nov 22: "the ideas
// section is way more fragile ... compared to any other section"). They lived
// only in mamagi, through the relay: every page load, every step of a run,
// every title Claude saved and every lease renewal was a read and a commit
// there, so any moment the relay couldn't answer (its sign-in check, a dropped
// connection, a restart) was an error on the page or a failed chat. Edits and
// scripts never had this: they're files here, synced.
//
// Now each document is a file here too (<home>/team-docs/<kind>/), with the
// cloud's rev it was last in step with:
// - A read answers from here. A copy more than a couple of seconds old is
//   asked for again, waited on for half a second, else answered from here (the
//   page asks again in a moment). Only a document never seen here needs the
//   cloud to answer.
// - A change is made here at once, its function kept, and pushed behind it
//   (a commit naming the rev it began from). Overtaken by another Mac's, it's
//   made again on the newer copy, as before, so neither is lost. One a restart
//   left unpushed (its function gone) is merged field by field: what changed
//   here over what changed there.
// - The cloud out of reach, the change waits here and goes up once it's back
//   (asked again at 1 s, 2 s, 5 s ... then each minute, and at once when the
//   cloud next answers). Refused (a permission), it's undone here and said.
// - A caller that must know the cloud took it (a run's lease, one Mac at a
//   time) waits for the push, up to `settleMs`, and hears a refusal.
// Everything still ends up in the cloud ("everything on the cloud!", Oct 29):
// what's here is a copy that can be ahead of it, never one kept only here.

import * as fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

/** How one kind of document is read and written in the cloud, and listed. */
export type Spec<T, R> = {
  /** Its folder here and its area in the log. */
  kind: string;
  fetch: (id: string) => Promise<{ body: T; rev: number } | null>;
  list: () => Promise<R[]>;
  /** Commits `body` as the next rev after `baseRev`: the new rev, or a throw `isConflict` knows when overtaken. */
  commit: (body: T, baseRev: number, by: string) => Promise<number>;
  remove: (id: string, by: string) => Promise<void>;
  isConflict: (error: unknown) => boolean;
  isMissing: (error: unknown) => boolean;
  /** What's thrown for a document that's gone ("This idea was deleted."). */
  missing: () => Error;
  /** Its row in the list from the copy here, ahead of the cloud's list (`old`: the list's row, when it has one). */
  rowOf: (body: T, rev: number, by: string, old: R | undefined) => R;
};

/** Waits (tests shorten the retries and settle every change, as writing through used to). */
export const timing = {
  /** A copy older than this is asked for again on a read. */
  freshMs: 2_000,
  /** How long a read waits on that ask before answering from here. */
  peekMs: 500,
  /** How long a change waits for the cloud to take it, unless its caller says. */
  settleMs: 0,
  /** The pauses before asking the cloud again while it can't be reached. */
  retryMs: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
};

type Done = { resolve: () => void; reject: (error: unknown) => void };
type Change<T> = { seq: number; fn: (doc: T) => boolean | void; done?: Done };

/** What's kept on disk for a document. */
type Kept<T> = {
  body: T;
  /** The cloud's rev this copy began from (0: made here, not yet up). */
  rev: number;
  /** The cloud's copy at `rev`, kept while changes wait (what a merge after a restart starts from). */
  base: T | null;
  /** Changes here the cloud hasn't got. */
  waiting: boolean;
  /** Who made the last of them. */
  by: string;
  syncedAt: number;
};

type Doc<T> = Kept<T> & {
  changes: Change<T>[];
  /** Every waiting change's function is here (not after a restart: then a merge). */
  replayable: boolean;
  pushing: boolean;
  attempt: number;
  conflicts: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/** A refusal asking again won't change (a permission, a bad request), as opposed to the cloud out of reach, busy or a sign-in being renewed. */
function refused(error: unknown): boolean {
  if (typeof error !== "object" || error === null || (error as { _tag?: unknown })._tag !== "ServiceRefused") return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status);
}

/**
 * `mine` and `theirs` both from `base`: theirs, with each field changed here
 * taken from here. A list changed on both sides keeps both sides' additions
 * and removals (two chats' turns, two people's titles).
 */
export function merge3<T>(base: T | null, mine: T, theirs: T): T {
  const out = structuredClone(theirs) as Record<string, unknown>;
  const from = (base ?? {}) as Record<string, unknown>;
  const here = mine as Record<string, unknown>;
  for (const key of new Set([...Object.keys(from), ...Object.keys(here)])) {
    if (key === "updatedAt" || isDeepStrictEqual(here[key], from[key])) continue;
    const there = out[key];
    const was = from[key];
    if (Array.isArray(here[key]) && Array.isArray(there) && Array.isArray(was) && !isDeepStrictEqual(there, was)) out[key] = mergeLists(was, here[key] as unknown[], there);
    else if (key in here) out[key] = structuredClone(here[key]);
    else delete out[key];
  }
  return out as T;
}

function mergeLists(base: unknown[], mine: unknown[], theirs: unknown[]): unknown[] {
  const has = (list: unknown[], one: unknown) => list.some((other) => isDeepStrictEqual(other, one));
  const added = mine.filter((one) => !has(base, one) && !has(theirs, one));
  return [...theirs, ...structuredClone(added)].filter((one) => !(has(base, one) && !has(mine, one)));
}

const LIST = "_list.json";

export class TeamDocs<T extends { id: string; updatedAt?: number }, R extends { id: string; rev: number; updatedAt: number }> {
  private docs = new Map<string, Doc<T>>();
  private rows: R[] | null = null;
  private listedAt = 0;
  private listing: Promise<void> | null = null;
  private fetching = new Map<string, Promise<void>>();
  private dir: string | null = null;
  private seq = 0;
  private quietUntil = 0;

  constructor(private readonly spec: Spec<T, R>) {}

  /** Keeps the copies in `home` (none: in memory only), and pushes what a restart left waiting. */
  useHome(home: string | null): void {
    this.forget();
    if (home === null) return;
    this.dir = join(home, "team-docs", this.spec.kind);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      diag.warn(this.spec.kind, `couldn't make the folder for the copies here: ${diag.messageOf(error)}`);
      this.dir = null;
      return;
    }
    try {
      this.rows = (JSON.parse(fs.readFileSync(join(this.dir, LIST), "utf8")) as { rows: R[] }).rows;
    } catch {
      this.rows = null;
    }
    let waiting = 0;
    for (const name of this.files()) {
      const doc = this.loadFile(name);
      if (doc === null || !doc.waiting) continue;
      this.docs.set(doc.body.id, doc);
      waiting++;
    }
    if (waiting > 0) diag.info(this.spec.kind, `${waiting} change(s) made here before Edit stopped going up to the cloud`);
    for (const id of [...this.docs.keys()]) this.push(id);
  }

  /** Documents with a change the cloud refused after its caller had gone on, for their page to say. */
  private readonly undone = new Set<string>();

  /** Whether a change made here was undone since this was last asked. */
  takeUndone(id: string): boolean {
    return this.undone.delete(id);
  }

  /** Lets go of every copy in memory (tests; a new home). */
  forget(): void {
    for (const doc of this.docs.values()) if (doc.timer !== null) clearTimeout(doc.timer);
    this.undone.clear();
    this.docs.clear();
    this.fetching.clear();
    this.rows = null;
    this.listedAt = 0;
    this.listing = null;
    this.dir = null;
  }

  /** Whether changes made here are still on their way to the cloud. */
  waiting(): number {
    let count = 0;
    for (const doc of this.docs.values()) if (doc.waiting) count++;
    return count;
  }

  /** Resolves once nothing made here is still going up, or the cloud can't be reached for it (tests). */
  async settled(): Promise<void> {
    for (let tries = 0; tries < 500; tries++) {
      if ([...this.docs.values()].every((doc) => !doc.pushing && (!doc.waiting || doc.timer !== null)) && this.fetching.size === 0 && this.listing === null) return;
      await Bun.sleep(5);
    }
  }

  /** Every document's row, newest change first: the cloud's list with what's here ahead of it. */
  async list(): Promise<R[]> {
    if (this.rows === null) await this.refreshList();
    else if (Date.now() - this.listedAt > timing.freshMs) await this.peek(this.refreshList().catch((error: unknown) => this.quiet("the list", error)));
    const out = new Map((this.rows ?? []).map((row) => [row.id, row]));
    for (const [id, doc] of this.docs) {
      const old = out.get(id);
      if (old === undefined || doc.waiting || doc.rev > old.rev) out.set(id, this.spec.rowOf(doc.body, doc.rev, doc.by, old));
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One document and the cloud rev its copy here began from, or null when it's gone. */
  async get(id: string): Promise<{ body: T; rev: number } | null> {
    let doc = this.load(id);
    if (doc === null) {
      await this.refresh(id);
      doc = this.docs.get(id) ?? null;
    } else if (Date.now() - doc.syncedAt > timing.freshMs) {
      await this.peek(this.refresh(id).catch((error: unknown) => this.quiet(id, error)));
      doc = this.docs.get(id) ?? null;
    }
    return doc === null ? null : this.out(doc);
  }

  /**
   * Changes a document here (`fn` may answer false: nothing to change, and
   * may throw to refuse), then pushes it. Waits `settleMs` for the cloud to
   * take it (a refusal, or the change failing on a newer copy, thrown);
   * beyond that, or with the cloud out of reach, it goes up behind.
   */
  async change(id: string, by: string, fn: (doc: T) => boolean | void, options: { settleMs?: number } = {}): Promise<{ body: T; rev: number }> {
    let doc = this.load(id);
    if (doc === null) {
      await this.refresh(id);
      doc = this.docs.get(id) ?? null;
    }
    if (doc === null) throw this.spec.missing();
    const settleMs = options.settleMs ?? timing.settleMs;
    // One that waits on the cloud (a lease) is decided on its newest copy when the cloud answers in time, not on one
    // that may be a few seconds old: it could still show another Mac's run that has ended.
    if (settleMs > 0 && !doc.waiting) {
      await Promise.race([this.refresh(id).catch(() => undefined), Bun.sleep(settleMs)]);
      doc = this.docs.get(id) ?? null;
      if (doc === null) throw this.spec.missing();
    }
    const next = structuredClone(doc.body);
    if (fn(next) === false) return this.out(doc);
    next.updatedAt = Date.now();
    this.take(doc, next, by, fn);
    const change = doc.changes.at(-1)!;
    const settled = settleMs > 0 ? new Promise<void>((resolve, reject) => (change.done = { resolve, reject })) : null;
    this.push(id);
    if (settled !== null) {
      await Promise.race([settled, Bun.sleep(settleMs)]);
      delete change.done;
    }
    const now = this.docs.get(id);
    if (now === undefined) throw this.spec.missing();
    return this.out(now);
  }

  /** A new document, made here and pushed behind (waiting `settleMs`, as a change does). */
  async create(body: T, by: string, options: { settleMs?: number } = {}): Promise<{ body: T; rev: number }> {
    const made = { ...structuredClone(body), updatedAt: Date.now() };
    const doc: Doc<T> = { body: made, rev: 0, base: null, waiting: false, by, syncedAt: Date.now(), changes: [], replayable: true, pushing: false, attempt: 0, conflicts: 0, timer: null };
    this.docs.set(made.id, doc);
    // Made again whole on a copy the cloud already has under its id (never, with ids as made).
    this.take(doc, made, by, (fresh) => void Object.assign(fresh, structuredClone(made)));
    const settleMs = options.settleMs ?? timing.settleMs;
    const change = doc.changes.at(-1)!;
    const settled = settleMs > 0 ? new Promise<void>((resolve, reject) => (change.done = { resolve, reject })) : null;
    this.push(made.id);
    if (settled !== null) {
      await Promise.race([settled, Bun.sleep(settleMs)]);
      delete change.done;
    }
    const now = this.docs.get(made.id);
    if (now === undefined) throw this.spec.missing();
    return this.out(now);
  }

  /** Commits exactly `body` at `baseRev` in the cloud (no copy here first), and keeps it here: the new rev. */
  async commit(body: T, baseRev: number, by: string): Promise<number> {
    const rev = await this.spec.commit(body, baseRev, by);
    const doc = this.docs.get(body.id) ?? this.load(body.id);
    const kept = { ...structuredClone(body), updatedAt: Date.now() };
    if (doc !== null && doc.waiting) {
      // Changes here wait on an older copy: made again on this one when they next go up.
      this.push(body.id);
      return rev;
    }
    const fresh: Doc<T> = { body: kept, rev, base: null, waiting: false, by, syncedAt: Date.now(), changes: [], replayable: true, pushing: false, attempt: 0, conflicts: 0, timer: null };
    this.docs.set(body.id, fresh);
    this.save(fresh);
    return rev;
  }

  /** Deletes a document in the cloud (it has to answer), then here. */
  async remove(id: string, by: string): Promise<void> {
    try {
      await this.spec.remove(id, by);
    } catch (error) {
      if (!this.spec.isMissing(error)) throw error;
    }
    this.drop(id, null);
  }

  // ---------------------------------------------------------------------------

  private out(doc: Doc<T>): { body: T; rev: number } {
    return { body: structuredClone(doc.body), rev: doc.rev };
  }

  private peek(asked: Promise<unknown>): Promise<unknown> {
    return Promise.race([asked, Bun.sleep(timing.peekMs)]);
  }

  /** Says a read that failed (the copy here answered), at most once a minute. */
  private quiet(what: string, error: unknown): void {
    if (Date.now() < this.quietUntil) return;
    this.quietUntil = Date.now() + 60_000;
    diag.info(this.spec.kind, `${what}: answered from the copy here, as the cloud couldn't be asked (${diag.messageOf(error)})`);
  }

  /** A change made on `doc`: its new body, kept with its function and saved. */
  private take(doc: Doc<T>, next: T, by: string, fn: (doc: T) => boolean | void): void {
    if (!doc.waiting) doc.base = doc.rev > 0 ? doc.body : null;
    doc.body = next;
    doc.waiting = true;
    doc.by = by;
    doc.changes.push({ seq: ++this.seq, fn });
    this.save(doc);
  }

  private files(): string[] {
    if (this.dir === null) return [];
    try {
      return fs.readdirSync(this.dir).filter((name) => name.endsWith(".json") && name !== LIST);
    } catch {
      return [];
    }
  }

  private fileOf(id: string): string {
    return join(this.dir!, `${encodeURIComponent(id)}.json`);
  }

  private loadFile(name: string): Doc<T> | null {
    try {
      const kept = JSON.parse(fs.readFileSync(join(this.dir!, name), "utf8")) as Kept<T>;
      if (typeof kept.body?.id !== "string" || typeof kept.rev !== "number") return null;
      return { ...kept, changes: [], replayable: !kept.waiting, pushing: false, attempt: 0, conflicts: 0, timer: null };
    } catch {
      return null;
    }
  }

  private load(id: string): Doc<T> | null {
    const held = this.docs.get(id);
    if (held !== undefined) return held;
    if (this.dir === null) return null;
    const doc = this.loadFile(`${encodeURIComponent(id)}.json`);
    if (doc === null || doc.body.id !== id) return null;
    // Read from the disk: as old as its sync, so the cloud's asked on this read.
    this.docs.set(id, doc);
    return doc;
  }

  private save(doc: Doc<T>): void {
    if (this.dir === null) return;
    const kept: Kept<T> = { body: doc.body, rev: doc.rev, base: doc.base, waiting: doc.waiting, by: doc.by, syncedAt: doc.syncedAt };
    try {
      writeAtomic(this.fileOf(doc.body.id), JSON.stringify(kept));
    } catch (error) {
      diag.warn(this.spec.kind, `${doc.body.id}: couldn't keep the copy here: ${diag.messageOf(error)}`);
    }
  }

  private saveList(): void {
    if (this.dir === null || this.rows === null) return;
    try {
      writeAtomic(join(this.dir, LIST), JSON.stringify({ rows: this.rows }));
    } catch (error) {
      diag.warn(this.spec.kind, `couldn't keep the list here: ${diag.messageOf(error)}`);
    }
  }

  /** Lets go of a document here (deleted, in the cloud or by a refusal of what was made here); its waiting callers told. */
  private drop(id: string, error: unknown): void {
    const doc = this.docs.get(id);
    if (doc !== undefined) {
      if (doc.timer !== null) clearTimeout(doc.timer);
      for (const change of doc.changes) change.done?.reject(error ?? this.spec.missing());
    }
    this.docs.delete(id);
    if (this.rows !== null) this.rows = this.rows.filter((row) => row.id !== id);
    if (this.dir !== null) fs.rmSync(this.fileOf(id), { force: true });
  }

  /** Asks the cloud for a document (one ask at a time each) and brings the copy here up to it. */
  private refresh(id: string): Promise<void> {
    const going = this.fetching.get(id);
    if (going !== undefined) return going;
    const asked = (async () => {
      const found = await this.spec.fetch(id);
      this.answered();
      const doc = this.docs.get(id) ?? this.load(id);
      if (found === null) {
        if (doc !== null && !doc.waiting) this.drop(id, null);
        return;
      }
      if (doc === null) {
        const fresh: Doc<T> = { body: found.body, rev: found.rev, base: null, waiting: false, by: "", syncedAt: Date.now(), changes: [], replayable: true, pushing: false, attempt: 0, conflicts: 0, timer: null };
        this.docs.set(id, fresh);
        this.save(fresh);
        return;
      }
      doc.syncedAt = Date.now();
      if (doc.waiting) {
        // Newer there while changes wait here: they're made again on it as they go up.
        if (found.rev > doc.rev) this.push(id);
        return;
      }
      // Only a newer rev: an answer asked for before this copy's own push landed is older than it.
      if (found.rev > doc.rev) {
        doc.body = found.body;
        doc.rev = found.rev;
        this.save(doc);
      }
    })().finally(() => this.fetching.delete(id));
    this.fetching.set(id, asked);
    return asked;
  }

  private refreshList(): Promise<void> {
    if (this.listing !== null) return this.listing;
    const askedAt = Date.now();
    this.listing = (async () => {
      const rows = await this.spec.list();
      this.answered();
      this.rows = rows;
      this.listedAt = Date.now();
      this.saveList();
      // Gone from the cloud: the copies here that were in step with it before this list was asked for.
      const listed = new Set(rows.map((row) => row.id));
      for (const [id, doc] of [...this.docs]) if (!listed.has(id) && !doc.waiting && doc.syncedAt < askedAt) this.drop(id, null);
      for (const name of this.files()) {
        const id = decodeURIComponent(name.slice(0, -".json".length));
        if (!listed.has(id) && !this.docs.has(id)) fs.rmSync(join(this.dir!, name), { force: true });
      }
    })().finally(() => (this.listing = null));
    return this.listing;
  }

  /** The cloud answered: what waits for it to come back goes now. */
  private answered(): void {
    for (const [id, doc] of this.docs) if (doc.waiting && doc.timer !== null) this.push(id);
  }

  private push(id: string): void {
    const doc = this.docs.get(id);
    if (doc === undefined || doc.pushing || !doc.waiting) return;
    if (doc.timer !== null) {
      clearTimeout(doc.timer);
      doc.timer = null;
    }
    doc.pushing = true;
    void this.pushing(id, doc)
      .catch((error: unknown) => diag.warn(this.spec.kind, `${id}: sending the changes made here: ${diag.messageOf(error)}`))
      .finally(() => (doc.pushing = false));
  }

  private async pushing(id: string, doc: Doc<T>): Promise<void> {
    while (doc.waiting && this.docs.get(id) === doc) {
      const sent = doc.body;
      const upTo = this.seq;
      try {
        const rev = await this.spec.commit(sent, doc.rev, doc.by);
        doc.rev = rev;
        doc.syncedAt = Date.now();
        doc.attempt = 0;
        doc.conflicts = 0;
        const done = doc.changes.filter((change) => change.seq <= upTo);
        doc.changes = doc.changes.filter((change) => change.seq > upTo);
        if (doc.body === sent) {
          doc.waiting = false;
          doc.base = null;
          doc.replayable = true;
        } else doc.base = sent;
        this.save(doc);
        if (this.rows !== null) this.rows = this.rows.map((row) => (row.id === id ? this.spec.rowOf(sent, rev, doc.by, row) : row));
        for (const change of done) change.done?.resolve();
        this.answered();
        continue;
      } catch (error) {
        if (this.spec.isConflict(error) && doc.conflicts < 10) {
          doc.conflicts++;
          if (await this.rebase(id, doc)) continue;
          return;
        }
        if (this.spec.isMissing(error)) {
          diag.warn(this.spec.kind, `${id}: deleted in the cloud, so what was made here on it is let go`);
          this.drop(id, null);
          return;
        }
        if (refused(error)) {
          this.undo(id, doc, error);
          return;
        }
        this.later(id, doc, error);
        return;
      }
    }
  }

  /** Overtaken: the cloud's newer copy, with what waits here made again on it (merged, after a restart). Whether to push again. */
  private async rebase(id: string, doc: Doc<T>): Promise<boolean> {
    let theirs: { body: T; rev: number } | null;
    try {
      theirs = await this.spec.fetch(id);
    } catch (error) {
      this.later(id, doc, error);
      return false;
    }
    if (this.docs.get(id) !== doc) return false;
    if (theirs === null) {
      diag.warn(this.spec.kind, `${id}: deleted in the cloud, so what was made here on it is let go`);
      this.drop(id, null);
      return false;
    }
    let body = structuredClone(theirs.body);
    if (doc.replayable) {
      for (const change of [...doc.changes]) {
        const tried = structuredClone(body);
        try {
          if (change.fn(tried) !== false) body = tried;
        } catch (error) {
          // It doesn't hold on the newer copy (another Mac took the run meanwhile): its caller told, the rest go on.
          doc.changes = doc.changes.filter((one) => one !== change);
          if (change.done === undefined) this.undone.add(id);
          change.done?.reject(error);
          diag.info(this.spec.kind, `${id}: a change made here no longer holds on the cloud's newer copy: ${diag.messageOf(error)}`);
        }
      }
    } else body = merge3(doc.base, doc.body, theirs.body);
    diag.info(this.spec.kind, `${id}: changed elsewhere meanwhile; making the change again on top`);
    doc.base = theirs.body;
    doc.rev = theirs.rev;
    doc.syncedAt = Date.now();
    const same = isDeepStrictEqual({ ...body, updatedAt: 0 }, { ...theirs.body, updatedAt: 0 });
    doc.body = same ? theirs.body : { ...body, updatedAt: Date.now() };
    if (same) {
      for (const change of doc.changes) change.done?.resolve();
      doc.changes = [];
      doc.waiting = false;
      doc.base = null;
      doc.replayable = true;
    }
    this.save(doc);
    return doc.waiting;
  }

  /** Refused: what was made here undone (the cloud's copy back), its callers told. */
  private undo(id: string, doc: Doc<T>, error: unknown): void {
    diag.warn(this.spec.kind, `${id}: the cloud refused what was made here, so it's undone: ${diag.messageOf(error)}`);
    if (doc.base === null && doc.rev === 0) {
      this.drop(id, error);
      return;
    }
    // Nobody waiting on it (none at all after a restart): the page says it.
    if (doc.changes.length === 0 || doc.changes.some((change) => change.done === undefined)) this.undone.add(id);
    for (const change of doc.changes) change.done?.reject(error);
    doc.changes = [];
    if (doc.base !== null) doc.body = doc.base;
    doc.base = null;
    doc.waiting = false;
    doc.replayable = true;
    doc.syncedAt = 0;
    this.save(doc);
  }

  /** The cloud out of reach: kept here and asked again later; whoever waits on it goes on with the copy here. */
  private later(id: string, doc: Doc<T>, error: unknown): void {
    for (const change of doc.changes) {
      change.done?.resolve();
      delete change.done;
    }
    const waits = timing.retryMs;
    const ms = waits[Math.min(doc.attempt, waits.length - 1)]!;
    doc.attempt++;
    if (doc.attempt === 1 || doc.attempt % 10 === 0) diag.warn(this.spec.kind, `${id}: kept here until the cloud takes it (${diag.messageOf(error)}); asking again in ${Math.round(ms / 1000)} s`);
    doc.timer = setTimeout(() => {
      doc.timer = null;
      this.push(id);
    }, ms);
    doc.timer.unref?.();
  }
}
