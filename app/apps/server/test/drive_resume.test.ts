// An upload to Drive a restart cut short carries on from its kept session
// (Sphe, Nov 10: an update goes through at any time): Drive is asked where the
// session is, and the file is never sent again whole, nor made twice.

import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";

import * as drive from "../src/drive.ts";
import * as jobs from "../src/jobs.ts";
import { Library } from "../src/library.ts";
import { fixtureHome, write } from "./helpers/home.ts";
import { MockServer, type Recorded } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({
    GOOGLE_DRIVE_CLIENT_ID: "id",
    GOOGLE_DRIVE_CLIENT_SECRET: "secret",
    GOOGLE_DOCS_REFRESH_TOKEN: "refresh",
    EDIT_SUBTITLES_FOLDER: undefined,
    EDIT_RENDER_FOLDER: undefined,
  });
  drive.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

const SESSIONS = "/www.googleapis.com/upload/drive/v3/files";

/** A Drive that holds `have` bytes of session `id` (or all of it, done as `done`), and records what it's sent. */
function fakeDrive(id: string, have: { bytes?: number; done?: string; gone?: boolean }) {
  const seen = { asked: 0, sent: [] as Recorded[], started: [] as Recorded[], shared: [] as string[] };
  mock.on("POST", SESSIONS, (request, server) => {
    seen.started.push(request);
    return new Response(null, { status: 200, headers: { location: `${server.url}${SESSIONS}?uploadType=resumable&upload_id=new-${id}` } });
  });
  mock.on("PUT", SESSIONS, (request) => {
    const range = request.headers.get("content-range") ?? "";
    if (/^bytes \*\/\d+$/.test(range)) {
      seen.asked += 1;
      if (request.query.get("upload_id") !== id || have.gone === true) return Response.json({ error: { message: "gone" } }, { status: 404 });
      if (have.done !== undefined) return Response.json({ id: have.done }, { status: 200 });
      return new Response(null, { status: 308, headers: have.bytes === 0 ? {} : { range: `bytes=0-${have.bytes! - 1}` } });
    }
    seen.sent.push(request);
    return Response.json({ id: `file-${id}` });
  });
  mock.on("POST", /^\/www\.googleapis\.com\/drive\/v3\/files\/[^/]+\/permissions$/, (request) => {
    seen.shared.push(request.path.split("/")[5]!);
    return Response.json({ id: "anyone" });
  });
  return seen;
}

async function settled(events: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400 && !events.some((event) => event.state !== "uploading"); i++) await Bun.sleep(25);
  return events.at(-1)!;
}

function setUp(name: string) {
  const fx = fixtureHome(name);
  const project = fx.app.store.create("Case (subtitles)", { width: 1920, height: 1080, fps: 30 }).project;
  const path = `${fx.dir}/case.mp4`;
  write(path, new Uint8Array(4096).map((_, i) => i % 251));
  const events: Record<string, unknown>[] = [];
  fx.app.store.subscribe((event) => {
    if (event.type === "drive") events.push(event);
  });
  /** The job a restart left: its session kept for this file as it is. */
  const cut = (id: string, over: Partial<drive.Session> = {}) =>
    jobs.begin(fx.app.store.home, "drive", project.id, {
      path,
      session: { uri: `${mock.url}${SESSIONS}?uploadType=resumable&upload_id=${id}`, size: 4096, mtime_ms: fs.statSync(path).mtimeMs, replacing: null, ...over },
    });
  return { ...fx, project, path, events, cut };
}

test("an upload cut part-way carries on from what Drive has, in the same session", async () => {
  const fx = setUp("drive-resume-part");
  try {
    const seen = fakeDrive("part", { bytes: 1024 });
    fx.cut("part");
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.asked).toBe(1);
    // No new session, and only the bytes Drive didn't have.
    expect(seen.started.length).toBe(0);
    expect(seen.sent.length).toBe(1);
    expect(seen.sent[0]!.headers.get("content-range")).toBe("bytes 1024-4095/4096");
    expect(seen.sent[0]!.body).toEqual(fs.readFileSync(fx.path).subarray(1024));
    expect(fx.app.store.get(fx.project.id)!.project.drive?.file_id).toBe("file-part");
    // A first upload: shared by link once.
    expect(seen.shared).toEqual(["file-part"]);
    expect(jobs.list(fx.app.store.home, "drive")).toEqual([]);
  } finally {
    fx.cleanup();
  }
});

test("an upload Drive finished before the restart is linked from Drive's answer: nothing sent again, no second file", async () => {
  const fx = setUp("drive-resume-done");
  try {
    const seen = fakeDrive("done", { done: "file-first" });
    fx.cut("done");
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.started.length).toBe(0);
    expect(seen.sent.length).toBe(0);
    expect(seen.shared).toEqual(["file-first"]);
    expect(fx.app.store.get(fx.project.id)!.project.drive?.file_id).toBe("file-first");
    expect(jobs.list(fx.app.store.home, "drive")).toEqual([]);
  } finally {
    fx.cleanup();
  }
});

test("a session Drive no longer has starts a new one, kept before a byte goes; one kept for another version of the file isn't asked", async () => {
  const fx = setUp("drive-resume-gone");
  try {
    const seen = fakeDrive("gone", { gone: true });
    fx.cut("gone");
    let keptWhileSending: unknown = null;
    mock.on("PUT", SESSIONS, (request) => {
      if (/^bytes \*\//.test(request.headers.get("content-range") ?? "")) return Response.json({}, { status: 404 });
      keptWhileSending = jobs.list(fx.app.store.home, "drive")[0]?.args.session;
      seen.sent.push(request);
      return Response.json({ id: "file-again" });
    });
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.started.length).toBe(1);
    expect(seen.sent.at(-1)!.body.length).toBe(4096);
    expect(keptWhileSending).toMatchObject({ uri: `${mock.url}${SESSIONS}?uploadType=resumable&upload_id=new-gone`, size: 4096, replacing: null });

    // Exported again since (another mtime): its old session isn't this file's.
    mock.on("PATCH", `${SESSIONS}/file-again`, (_request, server) =>
      new Response(null, { status: 200, headers: { location: `${server.url}${SESSIONS}?uploadType=resumable&upload_id=patch` } }),
    );
    const asked = seen.asked;
    fx.cut("gone", { mtime_ms: 1 });
    fx.events.length = 0;
    drive.start(fx.app.store, new Library(), fx.app.store.get(fx.project.id)!.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(seen.asked).toBe(asked);
    // The file it made before gets the new contents (same link), not a new file.
    expect(mock.calls(`${SESSIONS}/file-again`, "PATCH").length).toBe(1);
    expect(seen.started.length).toBe(1);
    expect(seen.sent.at(-1)!.body.length).toBe(4096);
  } finally {
    fx.cleanup();
  }
});

test("Drive's 308 says how much it has", () => {
  expect(drive.received("HTTP/1.1 308 Resume Incomplete\r\nRange: bytes=0-1023\r\ncontent-length: 0\r\n\r\n")).toBe(1024);
  expect(drive.received("HTTP/1.1 308 Resume Incomplete\r\ncontent-length: 0\r\n\r\n")).toBe(0);
});

// Nov 21: a running row nothing notes for 15 minutes is reported as still (jobs.still). An upload only patched its
// row (its session), which doesn't move its time, so a long upload on a slow line was reported while it sent.
test("an upload's progress notes its row as moving", async () => {
  const fx = setUp("drive-upload-beats");
  const was = jobs.BEAT_MS.value;
  jobs.BEAT_MS.value = 0;
  try {
    fakeDrive("beats", {});
    const old = Date.now() - 20 * 60_000;
    const noted: number[] = [];
    fx.app.store.subscribe((event) => {
      if (event.type !== "drive" || event.state !== "uploading") return;
      const file = `${fx.app.store.home}/jobs.json`;
      if (event.progress === 0) {
        // As if the upload had begun 20 minutes ago.
        const rows = JSON.parse(fs.readFileSync(file, "utf8")) as { key: string; updated_ms: number }[];
        for (const row of rows) row.updated_ms = old;
        fs.writeFileSync(file, JSON.stringify(rows));
      } else {
        noted.push(jobs.get(fx.app.store.home, jobs.keyOf("drive", fx.project.id))!.updated_ms);
      }
    });
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    expect((await settled(fx.events)).state).toBe("done");
    expect(noted.length).toBeGreaterThan(0);
    expect(noted.at(-1)!).toBeGreaterThan(Date.now() - 60_000);
  } finally {
    jobs.BEAT_MS.value = was;
    fx.cleanup();
  }
});

/**
 * A Drive upload session on a line that drops (Nov 21): a raw socket, so a drop is a connection cut mid-send, as a
 * Wi-Fi drop is, never a tidy answer. While `down`, a PUT is cut once Drive has kept `keepAt` bytes of it, and every
 * status ask after that cut is cut too; up, it answers as Drive does. What it kept, from where each PUT began, is recorded.
 */
function droppingSession(size: number, keepAt: number) {
  const kept: { from: number; bytes: Uint8Array }[] = [];
  let have = 0;
  const line = { down: false, drops: 0, asks: 0 };
  const answer = (socket: { write(text: string): unknown; end(): unknown }, status: string, headers: Record<string, string>, body = "") => {
    const head = Object.entries({ ...headers, "content-length": String(Buffer.byteLength(body)), connection: "close" }).map(([key, value]) => `${key}: ${value}\r\n`).join("");
    socket.write(`HTTP/1.1 ${status}\r\n${head}\r\n${body}`);
    socket.end();
  };
  const server = Bun.listen<{ buffer: Buffer; done: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0), done: false };
      },
      data(socket, chunk) {
        if (socket.data.done) return;
        socket.data.buffer = Buffer.concat([socket.data.buffer, chunk]);
        const split = socket.data.buffer.indexOf("\r\n\r\n");
        if (split < 0) return;
        const lines = socket.data.buffer.subarray(0, split).toString("latin1").split("\r\n");
        const header = (name: string) => lines.find((one) => one.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
        const range = header("content-range");
        const body = socket.data.buffer.subarray(split + 4);
        if (/^bytes \*\/\d+$/.test(range)) {
          line.asks += 1;
          socket.data.done = true;
          // Cut once the line has gone under a PUT: the ask before it reaches Drive.
          if (line.down && line.drops > 0) return (line.drops++, void socket.terminate());
          if (have >= size) return answer(socket, "200 OK", { "content-type": "application/json" }, JSON.stringify({ id: "file-dropped" }));
          return answer(socket, "308 Resume Incomplete", have === 0 ? {} : { range: `bytes=0-${have - 1}` });
        }
        const from = /^bytes (\d+)-/.exec(range)?.[1] === undefined ? 0 : Number(/^bytes (\d+)-/.exec(range)![1]);
        if (line.down && body.length >= keepAt - from) {
          // Drive kept up to `keepAt`, then the line went: cut while curl is still sending.
          kept.push({ from, bytes: new Uint8Array(body.subarray(0, keepAt - from)) });
          have = keepAt;
          socket.data.done = true;
          line.drops += 1;
          socket.terminate();
          return;
        }
        if (body.length < Number(header("content-length"))) return;
        socket.data.done = true;
        kept.push({ from, bytes: new Uint8Array(body) });
        have = from + body.length;
        answer(socket, "200 OK", { "content-type": "application/json" }, JSON.stringify({ id: "file-dropped" }));
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}/upload?upload_id=dropped`, kept, line, stop: () => server.stop(true) };
}

// Nov 21: an upload that met a dropped line ended as failed (after three quick tries inside), its kept session never
// carried on, and the export's link never came. It waits in the job table now and its resumer carries it on.
test("an upload on a line that drops mid-send waits by itself and is carried on from what Drive has: no byte sent twice", async () => {
  const fx = fixtureHome("drive-dropped");
  const size = 4 * 1024 * 1024;
  const keepAt = 1024 * 1024;
  const session = droppingSession(size, keepAt);
  try {
    const project = fx.app.store.create("Case (subtitles)", { width: 1920, height: 1080, fps: 30 }).project;
    const path = `${fx.dir}/case.mp4`;
    const bytes = new Uint8Array(size).map((_, i) => (i * 7) % 251);
    write(path, bytes);
    mock.on("POST", /^\/www\.googleapis\.com\/drive\/v3\/files\/[^/]+\/permissions$/, () => Response.json({ id: "anyone" }));
    const events: Record<string, unknown>[] = [];
    fx.app.store.subscribe((event) => {
      if (event.type === "drive") events.push(event);
    });
    // Its session kept with its job (as one begun before the line went), then the line goes under its bytes.
    jobs.begin(fx.app.store.home, "drive", project.id, { path, session: { uri: session.url, size, mtime_ms: fs.statSync(path).mtimeMs, replacing: null } });
    session.line.down = true;
    const library = new Library();
    drive.start(fx.app.store, library, project, path);
    const waited = await settled(events);
    // Waiting, never failed: the page hears it as such, and its row waits in the table with its session.
    expect(waited.state).toBe("waiting");
    expect(events.some((event) => event.state === "failed")).toBe(false);
    const row = jobs.get(fx.app.store.home, jobs.keyOf("drive", project.id))!;
    expect(row).toMatchObject({ state: "waiting", args: { path, session: { uri: session.url } } });
    expect(row.retry_at! - Date.now()).toBeGreaterThan(50_000);
    expect(session.line.drops).toBeGreaterThan(0);
    expect(drive.uploading(project.id)).toBe(false);

    // The line back; the table wakes it at its time (a minute on), and serve.ts' resumer carries it on.
    session.line.down = false;
    events.length = 0;
    jobs.useResumers(fx.app.store.home, { drive: (job) => drive.start(fx.app.store, library, fx.app.store.get(job.project)!.project, (job.args as { path: string }).path) });
    setSystemTime(new Date(row.retry_at! + 1_000));
    await jobs.wake(fx.app.store.home, ["drive"]);
    const done = await settled(events);
    expect(done.state).toBe("done");
    expect(fx.app.store.get(project.id)!.project.drive?.file_id).toBe("file-dropped");
    expect(jobs.list(fx.app.store.home, "drive")).toEqual([]);
    // What Drive kept: the first megabyte before the drop, then the rest from there. Nothing twice, nothing missed.
    expect(session.kept.map((one) => [one.from, one.bytes.length])).toEqual([[0, keepAt], [keepAt, size - keepAt]]);
    const whole = new Uint8Array(size);
    for (const one of session.kept) whole.set(one.bytes, one.from);
    expect(Buffer.from(whole).equals(Buffer.from(bytes))).toBe(true);
  } finally {
    setSystemTime();
    session.stop();
    fx.cleanup();
  }
}, 60_000);

test("a refusal that is Drive's word (403, not allowed) still fails at once, its row crossed off", async () => {
  const fx = setUp("drive-refused");
  try {
    mock.on("POST", SESSIONS, () => Response.json({ error: { message: "The user does not have sufficient permissions for this file." } }, { status: 403 }));
    drive.start(fx.app.store, new Library(), fx.project, fx.path);
    const ended = await settled(fx.events);
    expect(ended.state).toBe("failed");
    expect(String(ended.error)).toContain("Google Drive refused the upload (403)");
    expect(jobs.list(fx.app.store.home, "drive")).toEqual([]);
  } finally {
    fx.cleanup();
  }
});
