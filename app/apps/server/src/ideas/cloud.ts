// Ideas live in mamagi (the `ideas` module), reached through the relay's
// /v1/ideas/convex: the team's, so nothing of an idea is kept only on one Mac
// (the user, Oct 29: "everything on the cloud!"). Each is read and changed
// here first, a copy kept on this computer and pushed behind (team_docs.ts,
// Nov 22: a moment the relay couldn't answer was an error on the page or a
// failed chat): a change commits naming the rev it began from, and overtaken
// by another Mac's it's made again on top, so neither is lost.

import { footageIn, type Idea, type IdeaRow, type IdeaSummary } from "@edit/types/ideas";

import * as cloudStorage from "../cloud.ts";
import * as relay from "../relay.ts";
import { TeamDocs } from "../team_docs.ts";

type Answer = { status: "success"; value: unknown } | { status: "error"; errorMessage?: string; errorData?: { code?: string; message?: string } | string };

/** A commit another one overtook. */
export class Conflict extends Error {}

/** The idea isn't in the cloud (never was, or it was deleted). */
export class Missing extends Error {}

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await relay.json<Answer>("POST", "/v1/ideas/convex", { kind, path, args }, "ideas", 60);
  if (answer.status === "success") return answer.value;
  const data = typeof answer.errorData === "object" && answer.errorData !== null ? answer.errorData : null;
  const said = data?.message ?? answer.errorMessage ?? "the cloud refused";
  if (data?.code === "conflict") throw new Conflict(said);
  if (data?.code === "missing") throw new Missing(said);
  throw new Error(said);
}

type Listed = Omit<IdeaRow, "id" | "place"> & { ideaId: string };
type Row = Omit<IdeaRow, "place">;

/** Every idea in the cloud, newest change first, without their bodies. */
async function listed(): Promise<Row[]> {
  const rows = (await call("query", "ideas:list", {})) as Listed[];
  return rows.map(({ ideaId, ...row }) => ({ id: ideaId, ...row, workspace: row.workspace ?? "interrogation" }));
}

/** One idea in the cloud and its rev, or null. */
async function fetched(id: string): Promise<{ body: Idea; rev: number } | null> {
  const found = (await call("query", "ideas:get", { ideaId: id })) as { body: Idea; rev: number } | null;
  return found === null ? null : { body: { ...found.body, workspace: found.body.workspace ?? "interrogation", footage: footageOf(found.body.footage) }, rev: found.rev };
}

/** An idea's footage as a list: until Nov 2 it was one Drive folder's link. */
function footageOf(given: unknown): Idea["footage"] {
  if (Array.isArray(given)) return given as Idea["footage"];
  return typeof given === "string" ? footageIn(given, () => Math.random().toString(36).slice(2, 10)).footage : [];
}

/** Commits `idea` in the cloud as the next rev after `baseRev`; the new rev. */
async function committed(idea: Idea, baseRev: number, by: string): Promise<number> {
  const body = { ...idea, updatedAt: Date.now() };
  const answer = (await call("mutation", "ideas:commit", { ideaId: idea.id, workspace: idea.workspace, baseRev, body, summary: summarize(body), by })) as { rev: number };
  return answer.rev;
}

const docs = new TeamDocs<Idea, Row>({
  kind: "ideas",
  fetch: fetched,
  list: listed,
  commit: committed,
  remove: (id, by) => call("mutation", "ideas:remove", { ideaId: id, by }).then(() => undefined),
  isConflict: (error) => error instanceof Conflict,
  isMissing: (error) => error instanceof Missing,
  missing: () => new Missing("This idea was deleted."),
  rowOf: (idea, rev, by, old) => ({ createdBy: null, ...old, id: idea.id, workspace: idea.workspace, rev, summary: summarize(idea), updatedAt: idea.updatedAt, updatedBy: by || old?.updatedBy || "" }),
});

/** Keeps the copies in Edit's data folder (ideas/index.ts); without it, in memory (tests). */
export const useHome = (home: string | null): void => docs.useHome(home);

/** Lets go of the copies here (tests). */
export const forget = (): void => docs.forget();

/** Resolves once nothing made here is still going up (tests). */
export const settled = (): Promise<void> => docs.settled();

/** Every idea, newest change first, without their bodies. */
export const list = (): Promise<Row[]> => docs.list();

/** One idea and the rev it's at, or null. */
export async function get(id: string): Promise<{ idea: Idea; rev: number } | null> {
  const found = await docs.get(id);
  return found === null ? null : { idea: found.body, rev: found.rev };
}

/** A new idea: made here at once, in the cloud behind. */
export async function create(idea: Idea, by: string): Promise<void> {
  await docs.create(idea, by);
}

/** Commits `idea` in the cloud as the next rev after `baseRev` (and keeps it here); the new rev. */
export const commit = (idea: Idea, baseRev: number, by: string): Promise<number> => docs.commit(idea, baseRev, by);

/** Deletes an idea: the cloud has to answer. */
export const remove = (id: string, by: string): Promise<void> => docs.remove(id, by);

/**
 * Changes an idea: `change` makes the change on the newest copy here (and
 * may answer false: nothing to change); it goes up behind, made again on a
 * newer copy if another Mac's overtook it. `settleMs`: how long to wait for
 * the cloud to take it (a run's lease), a refusal thrown.
 */
export async function change(id: string, by: string, change: (idea: Idea) => boolean | void, options: { settleMs?: number } = {}): Promise<{ idea: Idea; rev: number }> {
  const { body, rev } = await docs.change(id, by, change, options);
  return { idea: body, rev };
}

/** A source's key: a video by its id, an article by its link. */
export const keyOf = (source: Idea["sources"][number]): string => (source.kind === "youtube" ? `youtube:${source.videoId}` : source.url);

/** An idea's row in a list. */
export function summarize(idea: Idea): IdeaSummary {
  const video = idea.sources.find((one) => one.kind === "youtube");
  const first = idea.sources[0];
  const title = idea.main ?? idea.titles[0]?.text ?? (first === undefined ? "New idea" : first.title || first.url);
  return {
    title,
    status: idea.status,
    run: idea.run?.state ?? null,
    step: idea.run?.state === "running" || idea.run?.state === "queued" ? (idea.run.step ?? null) : (idea.run?.error ?? null),
    sources: idea.sources.length,
    thumbnail: video?.kind === "youtube" ? video.thumbnail : null,
    views: video?.kind === "youtube" ? video.views : null,
    outlier: video?.kind === "youtube" ? video.outlier : null,
    card: idea.card === null ? null : { cardId: idea.card.cardId, url: idea.card.url, list: idea.card.list, ...(idea.card.channel !== undefined ? { channel: idea.card.channel } : {}) },
    changes: idea.changes?.comments.length ?? 0,
    skipped: idea.skipped,
    duplicate: idea.duplicate?.name ?? null,
    keys: idea.sources.map(keyOf),
    niche: idea.niche,
    source: first?.title ?? "",
    ...(idea.channel ? { channel: idea.channel } : {}),
    // Repackaged: Home's New until its person opens it (a chat run after it is them, or a teammate, working on it).
    ...(idea.run?.what === "repackage" && idea.run.state === "done" && typeof idea.run.endedAt === "number" ? { repackagedAt: idea.run.endedAt } : {}),
  };
}

/** A picture put in the idea's folder on R2 (`edit/ideas/<idea>/`, named by its bytes): its key. */
export async function putPicture(id: string, bytes: Uint8Array, type: string, extension: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 24);
  const key = `edit/ideas/${id}/${hash}.${extension}`;
  const url = await cloudStorage.presign(key, "PUT");
  const answer = await fetch(url, { method: "PUT", body: bytes, headers: { "content-type": type } });
  if (!answer.ok) throw new Error(`the cloud refused the picture (${answer.status})`);
  return key;
}
