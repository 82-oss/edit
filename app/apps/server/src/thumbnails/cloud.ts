// Thumbnails live in mamagi (the `thumbnails` module), reached through the
// relay's /v1/ideas/convex as ideas are: the team's, so nothing of one is kept
// only on one Mac. As ideas are, each is read and changed here first and pushed
// behind (team_docs.ts): a change commits naming the rev it began from;
// overtaken, it's made again on top. Pictures go
// to R2 under `edit/thumbnails/<id>/`, the team's overlays under
// `edit/thumbnails/assets/`.

import { summarize, type Asset, type Thumbnail, type ThumbRow } from "@edit/types/thumbnails";

import * as cloudStorage from "../cloud.ts";
import * as diag from "../diag.ts";
import * as relay from "../relay.ts";
import { TeamDocs } from "../team_docs.ts";

type Answer = { status: "success"; value: unknown } | { status: "error"; errorMessage?: string; errorData?: { code?: string; message?: string } | string };

export class Conflict extends Error {}
export class Missing extends Error {}

async function call(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await relay.json<Answer>("POST", "/v1/ideas/convex", { kind, path, args }, "thumbnails", 60);
  if (answer.status === "success") return answer.value;
  const data = typeof answer.errorData === "object" && answer.errorData !== null ? answer.errorData : null;
  const said = data?.message ?? answer.errorMessage ?? "the cloud refused";
  if (data?.code === "conflict") throw new Conflict(said);
  if (data?.code === "missing") throw new Missing(said);
  throw new Error(said);
}

type Listed = Omit<ThumbRow, "id"> & { thumbId: string };

async function listed(): Promise<ThumbRow[]> {
  const rows = (await call("query", "thumbnails:list", {})) as Listed[];
  return rows.map(({ thumbId, ...row }) => ({ id: thumbId, ...row }));
}

/**
 * A thumbnail as now read: exposure was Edit's own units (50 to a stop) before
 * it was Camera Raw's stops; a stored one beyond a stop's range is an old one,
 * divided back to the stops it meant. Saved again, it's in stops for good.
 */
export function withStops(thumb: Thumbnail): Thumbnail {
  for (const layer of thumb.design.layers) {
    if (layer.kind !== "image" || layer.adjust === undefined) continue;
    if (Math.abs(layer.adjust.exposure) > 5) layer.adjust = { ...layer.adjust, exposure: layer.adjust.exposure / 50 };
  }
  return thumb;
}

async function fetched(id: string): Promise<{ body: Thumbnail; rev: number } | null> {
  const found = (await call("query", "thumbnails:get", { thumbId: id })) as { body: Thumbnail; rev: number } | null;
  return found === null ? null : { body: withStops(found.body), rev: found.rev };
}

async function committed(thumb: Thumbnail, baseRev: number, by: string): Promise<number> {
  const body = { ...thumb, updatedAt: Date.now() };
  // Its workspace when it has one (the cloud keeps what it had otherwise; none is Interrogation's).
  const answer = (await call("mutation", "thumbnails:commit", { thumbId: thumb.id, baseRev, body, summary: summarize(body), by, ...(thumb.workspace === undefined ? {} : { workspace: thumb.workspace }) })) as { rev: number };
  return answer.rev;
}

const docs = new TeamDocs<Thumbnail, ThumbRow>({
  kind: "thumbnails",
  fetch: fetched,
  list: listed,
  commit: committed,
  remove: (id, by) => call("mutation", "thumbnails:remove", { thumbId: id, by }).then(() => undefined),
  isConflict: (error) => error instanceof Conflict,
  isMissing: (error) => error instanceof Missing,
  missing: () => new Missing("This thumbnail was deleted."),
  rowOf: (thumb, rev, by, old) => ({ createdBy: null, ...old, id: thumb.id, rev, summary: summarize(thumb), updatedAt: thumb.updatedAt, updatedBy: by || old?.updatedBy || "", ...(thumb.workspace === undefined ? {} : { workspace: thumb.workspace }) }),
});

/** Keeps the copies in Edit's data folder (thumbnails/index.ts); without it, in memory (tests). */
export const useHome = (home: string | null): void => docs.useHome(home);

/** Lets go of the copies here (tests). */
export const forget = (): void => docs.forget();

/** Resolves once nothing made here is still going up (tests). */
export const settled = (): Promise<void> => docs.settled();

export const list = (): Promise<ThumbRow[]> => docs.list();

export async function get(id: string): Promise<{ thumb: Thumbnail; rev: number } | null> {
  const found = await docs.get(id);
  return found === null ? null : { thumb: found.body, rev: found.rev };
}

/** A new thumbnail: made here at once, in the cloud behind. */
export async function create(thumb: Thumbnail, by: string): Promise<void> {
  await docs.create(thumb, by);
}

/** Commits `thumb` in the cloud as the next rev after `baseRev` (and keeps it here); the new rev. */
export const commit = (thumb: Thumbnail, baseRev: number, by: string): Promise<number> => docs.commit(thumb, baseRev, by);

export const remove = (id: string, by: string): Promise<void> => docs.remove(id, by);

/** Changes a thumbnail on its newest copy here (`change` may answer false: nothing to change), pushed behind; overtaken, made again on top. `settleMs`: how long to wait for the cloud to take it. */
export async function change(id: string, by: string, change: (thumb: Thumbnail) => boolean | void, options: { settleMs?: number } = {}): Promise<{ thumb: Thumbnail; rev: number }> {
  const { body, rev } = await docs.change(id, by, change, options);
  return { thumb: body, rev };
}

/** Where bytes go on R2 under `folder`: named by their hash. */
export function keyOf(folder: string, bytes: Uint8Array, extension: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 24);
  return `edit/thumbnails/${folder}/${hash}.${extension}`;
}

/** How a picture goes up: each try bounded, and the pauses between tries (tests make them short). */
export const putting = { timeoutMs: 120_000, waits: [2_000, 8_000, 30_000] };

/**
 * Bytes put on R2 under `folder` (named by their hash): the key. Each try is
 * bounded and a failed one (a dropped connection, R2 busy) is tried again a
 * few times, a fresh address each time: a picture OpenArt was paid for went up
 * in one PUT, with no time limit, and was lost when it failed (Nov 16 audit).
 */
export async function put(folder: string, bytes: Uint8Array, type: string, extension: string): Promise<string> {
  const key = keyOf(folder, bytes, extension);
  for (let attempt = 0; ; attempt++) {
    let failure = "";
    let answer: Response | null = null;
    try {
      const url = await cloudStorage.presign(key, "PUT");
      answer = await fetch(url, { method: "PUT", body: bytes, headers: { "content-type": type }, signal: AbortSignal.timeout(putting.timeoutMs) });
    } catch (error) {
      failure = diag.messageOf(error);
    }
    if (answer !== null) {
      if (answer.ok) return key;
      failure = `the cloud refused the picture (${answer.status})`;
      // A refusal that isn't passing (a bad address, no access) won't change on asking again.
      if (answer.status < 500 && answer.status !== 408 && answer.status !== 429) throw new Error(failure);
    }
    const wait = putting.waits[attempt];
    if (wait === undefined) throw new Error(`${failure}; tried ${attempt + 1} times`);
    diag.warn("thumbnails", `putting ${key} up: ${failure}; trying again in ${Math.round(wait / 1000)} s`);
    await Bun.sleep(wait);
  }
}

/** A picture's bytes from R2. */
export async function bytesOf(key: string): Promise<Uint8Array> {
  const answer = await fetch(await cloudStorage.presign(key, "GET"));
  if (!answer.ok) throw new Missing("That picture isn't in the cloud.");
  return new Uint8Array(await answer.arrayBuffer());
}

/** The team's own overlays and pictures. */
export async function teamAssets(): Promise<Asset[]> {
  const rows = (await call("query", "thumbnails:listAssets", {})) as { assetId: string; body: Asset }[];
  return rows.map((row) => ({ ...row.body, id: row.assetId, builtIn: false }));
}

export async function putAsset(asset: Asset, by: string): Promise<void> {
  await call("mutation", "thumbnails:putAsset", { assetId: asset.id, body: asset, by });
}
