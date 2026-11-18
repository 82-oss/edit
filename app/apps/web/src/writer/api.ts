import type { Adding, BuildStatus, ChatTurn, DocComment, DocFile, Choice, Draft, Feedback, Finds, Focus, LearnStep, Lesson, Pacing, Kind, Research, ReviewApproval, ReviewBlock, ReviewCounts, ReviewNote, ImportProgress, Role, Script, Snapshot, Summary, Version, VideoCheck, Footage, TrelloCard } from "./types";
import type { CutSource } from "@edit/types/script_cut";
import { byPerson } from "../lib/api";
import { kindOf, postFile, type Accept, type ChatFile, type Uploader } from "../lib/chatFiles";

/** Writer's own replies are JSON. Anything else came from in between (Vite
 * while the app restarts, a dropped tailnet hop), and says so plainly. A
 * connection that drops outright still rejects with fetch's TypeError, which
 * callers treat as "still running on the Mac". */
async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(
      `Edit didn't answer (${response.status}). It may be restarting; try again in a moment.`,
    );
  }
  if (!response.ok) {
    const said = (body as { error?: string } | undefined)?.error;
    throw new Error(said || `Edit didn't answer (${response.status}). Try again in a moment.`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The Edit project this script became, if it has one; making one starts the edit from the script (footage, voice-over, layout). */
export const editProject = (id: string) => http<{ project: string | null }>(`/api/writer/scripts/${id}/edit`);
export const startEdit = (id: string) => http<{ project: string }>(`/api/writer/handoff/${id}/import`, { method: "POST" });

/** The script page has `id` open (said again every 30 s): its cloud lock is kept while it does; who else holds it, if anyone. */
export const openScriptLock = (id: string, client: string) => http<{ holder: string | null; writable: boolean }>(`/api/writer/scripts/${id}/open`, json({ client }));
export const closeScriptLock = (id: string, client: string) => http<{ ok: boolean }>(`/api/writer/scripts/${id}/close`, json({ client }));
export const takeOverScript = (id: string) => http<{ holder: string | null; writable: boolean }>(`/api/writer/scripts/${id}/takeover`, { method: "POST" });

export const listScripts = () =>
  http<Summary[]>("/api/writer/scripts");

export const getScript = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}`);

/** A title given is kept in place of the video's own. */
/** `build`: built as soon as the import is ready, with that note ("" for none). */
/** `channel`: the channel it's for (its writer is taught that channel's Script lane); the same on the calls below. */
export const importYoutube = (url: string, article?: string, title?: string, kind?: Kind, build?: string, channel?: string) =>
  http<Script>("/api/writer/scripts/youtube", json({ url, article, title, kind, build, ...(channel ? { channel } : {}), ...byPerson() }));

/** A title given (typed, or a Trello card's) is kept in place of the folder's name. */
export const importDrive = (url: string, article?: string, title?: string, kind?: Kind, build?: string, channel?: string) =>
  http<Script>("/api/writer/scripts/drive", json({ url, article, title, kind, build, ...(channel ? { channel } : {}), ...byPerson() }));

/** The card a pasted Trello link names, read for its videos (any board Repack's Trello reads). */
export const trelloCard = (link: string) =>
  http<TrelloCard>("/api/writer/trello/card", json({ link }));

export const renameScript = (id: string, title: string) =>
  http<Script>(`/api/writer/scripts/${id}/title`, { ...json({ title }), method: "PUT" });

/** Its note on Home (empty: none). */
export const setScriptNote = (id: string, note: string) =>
  http<{ note: string }>(`/api/writer/scripts/${id}/note`, { ...json({ note }), method: "PUT" });

/** Its category: the kind its next build, revision and edit are made as. */
export const setScriptKind = (id: string, kind: Kind) =>
  http<Script>(`/api/writer/scripts/${id}/kind`, { ...json({ kind }), method: "PUT" });

export const resumeImport = (id: string, choice: Choice) =>
  http<Script>(`/api/writer/scripts/${id}/resume`, json(choice));

export const completeTranscription = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/complete-transcription`, { method: "POST" });

export const saveClips = (id: string, revision: number, clips: Script["clips"]) =>
  http<Script>(`/api/writer/scripts/${id}/clips`, { ...json({ revision, clips }), method: "PUT" });

export const deleteScript = (id: string) =>
  http<void>(`/api/writer/scripts/${id}`, { method: "DELETE" });

export const startBuild = (id: string, note: string, kind?: Kind, files?: string[]) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/build`, json({ note, kind, files }));

/** Opus revises a built script with targeted edits; followed as a build is. `files`: footage attached to the message (`footageUploader`), added first. */
export const startRevision = (id: string, request: string, focus: Focus, files?: string[]) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/revise`, json({ request, focus, files }));

/** A file attached to a message in the script's chat, streamed to the script until the message adds it to the footage. */
export interface AttachedFootage {
  upload: string;
  name: string;
}

/** The chat composer's uploader for a script: its upload id, which the message names it by. */
export function footageUploader(id: string): Uploader {
  return async (file, progress, signal) => {
    const query = new URLSearchParams({ name: file.name, size: String(file.size) });
    return (await postFile(`/api/writer/scripts/${id}/upload?${query}`, file, progress, signal, { "content-type": "application/octet-stream" })) as AttachedFootage;
  };
}

/** Pictures aren't footage; anything else is checked by the server (video and sound only). */
export const footageOnly: Accept = (file) => (kindOf(file) === "image" ? "only video or sound can be added to the footage" : null);

/** The upload ids of the files a message carries, as the server names them. */
export const uploadsOf = (files: readonly ChatFile[]): string[] => files.flatMap((one) => (typeof (one.landed as AttachedFootage | undefined)?.upload === "string" ? [(one.landed as AttachedFootage).upload] : []));

/** Brings a compilation's reused cases' videos into its footage for intro clips (all not yet in, by default); followed as a build is. */
export const importReuses = (id: string, urls: string[] = []) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/reuses`, json({ urls }));

/** Searches YouTube for the clips a commentary brief needs; followed as a build is. */
export const findClips = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/finds`, json({}));

export const getFinds = (id: string) =>
  http<Finds | null>(`/api/writer/scripts/${id}/finds`);

/** Starts the feedback over from the notes on the script's review page. */
export const pullFeedback = (id: string) =>
  http<Feedback>(`/api/writer/scripts/${id}/feedback`, json({}));

/** What a note from Writer says beyond its text: the words it's on, its intent, a suggestion's new words. */
export type NoteDetails = { anchor?: { kind: "text"; blockId: string; start: number; end: number; quote: string }; intent?: string; replacement?: string };

export const resolveProposals = (id: string, revision: number, proposals: string[], accept: boolean) =>
  http<Script>(`/api/writer/scripts/${id}/proposals`, json({ revision, proposals, accept }));

export const retrySpeakers = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/speakers/retry`, json({}));

export const stopJob = (id: string) =>
  http<void>(`/api/writer/scripts/${id}/build/stop`, json({}));

/** Leaves a note on the script's review page from Writer: the same note a reviewer leaves there. */
export const addReviewNote = (id: string, text: string, details?: NoteDetails) =>
  http<void>(`/api/writer/scripts/${id}/review/notes`, json({ text, details }));

/** A reply under a note on the review page, signed with the signed-in person's name. */
export const replyReviewNote = (id: string, noteId: string, text: string) =>
  http<void>(`/api/writer/scripts/${id}/review/notes/${noteId}/replies`, json({ text }));

/** A person's word on a fix: confirmed, or sent back with what still isn't right (added as a reply). */
export const checkReviewNote = (id: string, noteId: string, verdict: "confirmed" | "notFixed", text?: string) =>
  http<void>(`/api/writer/scripts/${id}/review/notes/${noteId}/check`, json({ verdict, text }));

/** How Ready for changes is going on the script's review (the page's `fix`), and whether the fixing computer is on. */
export type ReviewFix = {
  state: "waiting" | "fixing" | "sharing" | "done" | "failed";
  by: string;
  requestedAt: number;
  version: number;
  stage: string | null;
  done: number | null;
  total: number | null;
  newVersion: number | null;
  error: string | null;
  stale: boolean;
  updatedAt: number;
};
/** What a reviewer would flag that a count can find (commentary::audit, claude::team_flags), shown before sharing. */
export const scriptAudit = (id: string) =>
  http<{ flags: string[] }>(`/api/writer/scripts/${id}/audit`);

export const reviewFix = (id: string) =>
  http<{ fix: ReviewFix | null; computer: "on" | "off" | "none" | null }>(`/api/writer/scripts/${id}/review/fix`);

/** Deletes a note left from Writer (never a reviewer's), with its replies. */
export const deleteReviewNote = (id: string, noteId: string) =>
  http<void>(`/api/writer/scripts/${id}/review/notes/${noteId}`, { method: "DELETE" });

export const getFeedback = (id: string) =>
  http<Feedback | null>(`/api/writer/scripts/${id}/feedback`);

export const setFeedbackItem = (id: string, item: string, change: { skip?: boolean; note?: string }) =>
  http<Feedback>(`/api/writer/scripts/${id}/feedback/items/${item}`, { ...json(change), method: "PUT" });

/** Saves the lesson, and says what in it still points at the script. */
export const setLesson = (id: string, lesson: string) =>
  http<{ feedback: Feedback; leaks: string[] }>(`/api/writer/scripts/${id}/feedback/lesson`, { ...json({ lesson }), method: "PUT" });

export const startLearning = (id: string, step: LearnStep) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/feedback/steps`, json(step));

export const keepLesson = (id: string) =>
  http<Lesson[]>(`/api/writer/scripts/${id}/feedback/keep`, json({}));

export const getLessons = () => (http<Lesson[]>("/api/writer/lessons"));

export const forgetLesson = (lesson: string) =>
  http<Lesson[]>(`/api/writer/lessons/${lesson}`, { method: "DELETE" });

/** The frames the clip search looked at for one clip. */
export const framesUrl = (id: string, frames: string) =>
  `/api/writer/scripts/${id}/finds/frames/${frames.split("/").pop()}`;

/** The script's conversation with the editor. */
/** The producer's answer to Claude asking to start over: accepted, the built script goes (the transcript and research stay). */
export const resetScript = (id: string, accept: boolean) =>
  http<Script>(`/api/writer/scripts/${id}/reset`, json({ accept }));

export const getChat = (id: string) =>
  http<ChatTurn[]>(`/api/writer/scripts/${id}/chat`);

/** Respells a transcript word; an empty text puts it back. */
export const correctWord = (id: string, revision: number, word: string, text: string) =>
  http<Script>(`/api/writer/scripts/${id}/corrections`, { ...json({ revision, word, text }), method: "PUT" });

/** The producer's own heading; an empty one puts the generated heading back. */
export const setHeading = (id: string, revision: number, heading: string) =>
  http<Script>(`/api/writer/scripts/${id}/heading`, { ...json({ revision, heading }), method: "PUT" });

/** The script's versions, oldest first. */
export const listVersions = (id: string) =>
  http<Version[]>(`/api/writer/scripts/${id}/versions`);

export const getVersion = (id: string, version: string) =>
  http<Snapshot>(`/api/writer/scripts/${id}/versions/${version}`);

/** Makes an earlier version the script again. */
export const restoreVersion = (id: string, revision: number, version: string) =>
  http<Script>(`/api/writer/scripts/${id}/versions/${version}/restore`, json({ revision }));

export const getResearch = (id: string) =>
  http<Research | null>(`/api/writer/scripts/${id}/research`);

/** Looks for the news about the case again, replacing what was found. */
export const researchAgain = (id: string) =>
  http<Research>(`/api/writer/scripts/${id}/research`, { method: "POST" });

/** Videos joined in order: a compilation, one case each, or (`kase`) one Courtroom case across them. */
export const importCompilation = (title: string, urls: string[], kase = false, kind?: Kind, build?: string, channel?: string) =>
  http<Script>("/api/writer/scripts/compilation", json({ title, urls, case: kase, kind, build, ...(channel ? { channel } : {}), ...byPerson() }));

/** A compilation's lines checked before anything downloads, as Repack checks its videos. */
export const checkVideos = (lines: string[]) =>
  http<VideoCheck[]>("/api/writer/videos/check", json({ lines }));

export const buildStatus = (id: string) =>
  http<BuildStatus | null>(`/api/writer/scripts/${id}/build`);

/** A commentary project, its links read in as sources (the first is the brief). */
export const createCommentary = (title: string, links: string[]) =>
  http<Script>("/api/writer/scripts/commentary", json({ title, links, ...byPerson() }));

export const addSource = (id: string, adding: Adding, role: Role) =>
  http<Script>(`/api/writer/scripts/${id}/sources`, json({ adding, role }));

export const setPacing = (id: string, pacing: Pacing) =>
  http<Script>(`/api/writer/scripts/${id}/pacing`, { ...json({ pacing }), method: "PUT" });

export const updateSource = (id: string, source: string, change: { role?: Role; title?: string }) =>
  http<Script>(`/api/writer/scripts/${id}/sources/${source}`, { ...json(change), method: "PUT" });

export const removeSource = (id: string, source: string) =>
  http<Script>(`/api/writer/scripts/${id}/sources/${source}`, { method: "DELETE" });

export const sourceText = (id: string, source: string) =>
  http<string>(`/api/writer/scripts/${id}/sources/${source}`);

export const saveDraft = (id: string, revision: number, draft: Draft) =>
  http<Script>(`/api/writer/scripts/${id}/draft`, { ...json({ revision, draft }), method: "PUT" });

/** A new Google Doc from the script (a Word file in base64), as Repack exports. */
export const exportDoc = (id: string, draft: boolean, docx: string) =>
  http<DocFile>(`/api/writer/scripts/${id}/docs`, json({ draft, docx }));

/** Every Doc exported from the script, read from Drive each time. */
export const listDocs = (id: string) =>
  http<DocFile[]>(`/api/writer/scripts/${id}/docs`);

/** The comments on the script's latest Doc, or on the one named. */
export const docComments = (id: string, doc?: string) =>
  http<{ doc: string; comments: DocComment[] }>(doc ? `/api/writer/scripts/${id}/docs/${doc}/comments` : `/api/writer/scripts/${id}/docs/comments`);

/** Every import running now. */
export const getProgress = () =>
  http<ImportProgress[]>("/api/writer/progress");

export function message(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/**
 * Where a script's preview plays from: the file on this Mac when it's here,
 * otherwise the cloud's copy a range at a time (stream.rs), as Repack plays
 * its footage. `v` changes the address when the footage does.
 */
export const previewSrc = (id: string, v: number | string) =>
  `/api/writer/scripts/${id}/proxy?v=${v}`;

/**
 * The addresses a cut plays from as the files Edit.app's window player reads
 * (the server's writer/window_sources.ts): only the ones on this Mac; `coming`
 * are on their way down, so it's asked again.
 */
export const windowSources = (srcs: string[]) =>
  http<{ cache: string; sources: Record<string, CutSource>; coming: string[] }>("/api/writer/window-sources", json({ srcs }));

/** Shares the script on a Repack review link, or its next version on the same link. */
/** The script as it is now made its review's only version, v1, on the same link. */
export const compressReview = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/review/compress`, json({}));
/** Deletes the script's review link for good: the page, every version and every note go. */
export const deleteReviewLink = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/review`, { method: "DELETE" });
export const shareScript = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/share`, json({}));
/** Stops a script share. It leaves the queue once the step it's in lets go. */
export const cancelScriptShare = (id: string) =>
  http<{ cancelled: boolean }>(`/api/writer/scripts/${id}/share/cancel`, json({}));

/** Open review notes per script, for the cards' badges, and whether Claude fixes new ones by itself. */
export const reviewCounts = () =>
  http<ReviewCounts>("/api/writer/reviews");

/** A script's review notes, and its blocks as they now read. */
export type ReviewState = { notes: ReviewNote[]; blocks: ReviewBlock[]; approved: ReviewApproval | null };

export const reviewNotes = (id: string) =>
  http<ReviewState>(`/api/writer/scripts/${id}/review`);

/** Approves the latest shared version (Repack deletes the other versions' files; the notes stay), or takes the approval back. */
export const approveReview = (id: string, approve: boolean) =>
  http<ReviewState>(`/api/writer/scripts/${id}/review/approval`, { ...json({ approve }), method: "PUT" });

/** Has Claude fix the script's open notes now; followed as a build. */
export const fixNotes = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/review/fix`, json({}));

/** Calls `then` whenever review notes change (in the app; the dev page asks every half minute). */
export function onReviews(then: () => void): () => void {
  const timer = window.setInterval(then, 30_000);
  return () => window.clearInterval(timer);
}

/** Brings an archived script's footage back from its links (or Edit's originals); followed as a build. */
export const restoreScript = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/restore`, json({}));

/** Who's signed in (account.rs), at accounts.spheceo.com. */
export type Person = { sub: string; email: string; name: string; image: string | null; perms: string[]; admin: boolean };
export type AccountStatus = {
  signedIn: boolean;
  person: Person | null;
  signingIn: boolean;
  /** While signing in: the page to open, if the browser didn't. */
  signInUrl: string | null;
  /** Signing in with a code on another device: what to type, and where. */
  code: { userCode: string; url: string; urlComplete: string | null } | null;
  error: string | null;
};
/** A script starter's photo, kept on this Mac: a src for <img>, or null (show initials). */
export const avatarSrc = async (_sub: string, picture: string): Promise<string | null> => `/api/avatar?url=${encodeURIComponent(picture)}`;

/** A commentary's downloaded footage; asking starts what's missing (footage.rs). */
export const getFootage = (id: string) => (http<Footage>(`/api/writer/scripts/${id}/footage`));

/** Where a downloaded stretch of a commentary's footage plays from. */
export const footageUrl = (id: string, file: string) => `/api/writer/scripts/${id}/footage/${encodeURIComponent(file)}`;

