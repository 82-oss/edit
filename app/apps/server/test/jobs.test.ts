import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { readState } from "../src/files.ts";
import * as encoder from "../src/encoder.ts";
import * as jobs from "../src/jobs.ts";
import { scratch } from "./helpers/home.ts";

function read(dir: string): jobs.Job[] {
  return JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")) as jobs.Job[];
}

function home(): string {
  return fs.mkdtempSync(`${os.tmpdir()}/edit-jobs-`);
}

test("a job is listed while it runs and crossed off when it ends", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    expect(key).toBe("export:p1");
    const smooth = jobs.begin(dir, "smooth", "p1", { clip: "c1" }, "c1");
    expect(smooth).toBe("smooth:p1:c1");
    const listed = JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")) as jobs.Job[];
    expect(listed.map((job) => job.key)).toEqual(["export:p1", "smooth:p1:c1"]);
    jobs.end(dir, key);
    const left = JSON.parse(fs.readFileSync(`${dir}/jobs.json`, "utf8")) as jobs.Job[];
    expect(left.map((job) => job.key)).toEqual(["smooth:p1:c1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart starts unfinished jobs again; one cut short three times in a row waits by itself, an agent's turn alone is ended", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "watch", "p1", {});
    jobs.begin(dir, "turn", "p2", {});
    const resumed: string[] = [];
    const again = (job: jobs.Job) => {
      resumed.push(job.key);
      // Started again, as its owner does: noted again under its key.
      jobs.begin(dir, job.kind, job.project, job.args);
    };
    const resumers: jobs.Resumers = { watch: again, turn: again };
    for (let restart = 1; restart <= 3; restart++) await jobs.resume(dir, resumers);
    // Resumed after the first and second restarts; the third leaves the watch waiting and the turn ended.
    expect(resumed).toEqual(["watch:p1", "turn:p2", "watch:p1", "turn:p2"]);
    expect(jobs.get(dir, "watch:p1")).toMatchObject({ state: "waiting", put_off: 1, why: "cut short by 3 restarts in a row" });
    expect(jobs.givenUp(dir).map((job) => job.key)).toEqual(["turn:p2"]);
    // Neither is started by a later restart: the watch when its time comes, the turn never.
    await jobs.resume(dir, resumers);
    expect(resumed.length).toBe(4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart Edit made itself (an update) isn't counted against the jobs it cut; an old note doesn't count", () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    for (let restart = 0; restart < 5; restart++) {
      jobs.plannedRestart(dir);
      expect(jobs.takeOver(dir).map((job) => [job.key, job.attempts])).toEqual([["export:p1", 0]]);
    }
    // Read once: the next start without a note counts as before.
    expect(jobs.takeOver(dir).map((job) => job.attempts)).toEqual([1]);
    fs.writeFileSync(`${dir}/restart.json`, JSON.stringify({ at: Date.now() - 3_600_000 }));
    expect(jobs.takeOver(dir).map((job) => job.attempts)).toEqual([2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("taking over keeps every job listed, its count raised, until its work ends", () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    jobs.begin(dir, "watch", "p2", {});
    expect(jobs.takeOver(dir).map((job) => job.key)).toEqual(["export:p1", "watch:p2"]);
    expect(read(dir).map((job) => [job.key, job.attempts])).toEqual([["export:p1", 1], ["watch:p2", 1]]);
    // A resumer noting it again is the same entry, its count kept.
    jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    expect(read(dir).map((job) => [job.key, job.attempts])).toEqual([["export:p1", 1], ["watch:p2", 1]]);
    jobs.end(dir, "export:p1");
    expect(read(dir).map((job) => job.key)).toEqual(["watch:p2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash while recovering (taken over twice, nothing ended) loses neither job", () => {
  const dir = home();
  try {
    jobs.begin(dir, "export", "p1", {});
    jobs.begin(dir, "upload", "-", {}, "sha256:e0");
    jobs.takeOver(dir);
    // The server dies before any resumer noted its job again.
    expect(jobs.takeOver(dir).map((job) => job.key)).toEqual(["export:p1", "upload:-:sha256:e0"]);
    expect(read(dir).map((job) => job.attempts)).toEqual([2, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumer that throws keeps its job; one that says it's gone crosses it off", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "watch", "p2", {});
    jobs.begin(dir, "smooth", "p3", { clip: "c1" }, "c1");
    await jobs.resume(dir, {
      watch: () => {
        throw new Error("the relay doesn't answer");
      },
      smooth: () => {
        throw new jobs.Gone("the clip is gone");
      },
    });
    expect(read(dir).map((job) => [job.key, job.attempts])).toEqual([["watch:p2", 1]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unstick starts a given-up job (a turn) or one waiting by itself again at once, its count cleared", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "turn", "p1", {});
    const started: string[] = [];
    // Each restart cuts it short again (its resumer never gets it to the end).
    const resumers: jobs.Resumers = { turn: (job) => void started.push(job.key) };
    for (let restart = 1; restart <= 3; restart++) await jobs.resume(dir, resumers);
    expect(started.length).toBe(2);
    expect(jobs.givenUp(dir).length).toBe(1);
    const revived = jobs.startGivenUp(dir);
    expect(revived.keys).toEqual(["turn:p1"]);
    await revived.started;
    expect(started.length).toBe(3);
    expect(read(dir).map((job) => [job.key, job.attempts, job.given_up])).toEqual([["turn:p1", 0, undefined]]);
    // Nothing left given up: unstick again does nothing.
    expect(jobs.startGivenUp(dir).keys).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a given-up job started anew by hand starts its count over", () => {
  const dir = home();
  try {
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([{ key: "export:p1", kind: "export", project: "p1", args: {}, started_ms: 0, resumes: 2, given_up: "cut short by 3 restarts in a row" }]));
    jobs.begin(dir, "export", "p1", { output: "/y.mp4" });
    expect(read(dir).map((job) => [job.attempts, job.given_up, job.args])).toEqual([[0, undefined, { output: "/y.mp4" }]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a jobs.json from before given-up jobs (no resumes, no given_up) loads as before", () => {
  const dir = home();
  try {
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([{ key: "watch:p2", kind: "watch", project: "p2", args: {}, started_ms: 0 }]));
    expect(jobs.takeOver(dir).map((job) => [job.key, job.attempts])).toEqual([["watch:p2", 1]]);
    expect(jobs.givenUp(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that gets further each run (a big upload resuming) is started again however often it's cut short", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "upload", "-", { file: "/ten-hours.mp4" }, "sha256:e0");
    const resumed: string[] = [];
    const resumers: jobs.Resumers = {
      upload: (job) => {
        resumed.push(job.key);
        const key = jobs.begin(dir, "upload", job.project, job.args, "sha256:e0");
        jobs.progressed(dir, key);
      },
    };
    for (let restart = 1; restart <= 5; restart++) await jobs.resume(dir, resumers);
    expect(resumed.length).toBe(5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a data folder nothing is written", () => {
  expect(jobs.begin(null, "export", "p", {})).toBe("export:p");
  jobs.end(null, "export:p");
});

test("a state file that won't read is set aside, never read as empty and written over", () => {
  const { dir, cleanup } = scratch("state-broken");
  try {
    const path = `${dir}/jobs.json`;
    fs.writeFileSync(path, "{ not json");
    const warned: string[] = [];
    expect(readState(path, (message) => warned.push(message))).toBeUndefined();
    expect(fs.existsSync(path)).toBe(false);
    const aside = fs.readdirSync(dir).find((name) => name.startsWith("jobs.json.broken-"));
    expect(aside).toBeDefined();
    expect(fs.readFileSync(`${dir}/${aside}`, "utf8")).toBe("{ not json");
    expect(warned[0]).toContain("isn't valid JSON");
    // None at all is simply empty, quietly.
    expect(readState(`${dir}/none.json`, (message) => warned.push(message))).toBeUndefined();
    expect(warned.length).toBe(1);
  } finally {
    cleanup();
  }
});

test("a job's steps, its ending and a hand-off round trip through jobs.json as plain objects", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "share", "p1", { id: "s1" }, "", "exporting");
    jobs.step(dir, key, "review copy", { path: "/x.mp4" });
    expect(jobs.get(dir, key)).toMatchObject({ kind: "share", state: "running", step: "review copy", args: { id: "s1", path: "/x.mp4" }, attempts: 0 });
    // Published: kept done, and its full-quality upload listed, in one write.
    jobs.handOff(dir, key, { kind: "full", project: "p1", args: { key: "k" }, part: "k" }, { state: "done", step: "published", args: { published: { version: 2 } } });
    expect(read(dir).map((job) => [job.key, job.state, job.step])).toEqual([["share:p1", "done", "published"], ["full:p1:k", "running", undefined]]);
    // Done and failed jobs aren't started again by a restart.
    jobs.settle(dir, "full:p1:k", "failed", { error: "R2 closed the connection", build: "nightly-70" });
    expect(jobs.takeOver(dir)).toEqual([]);
    expect(jobs.get(dir, "full:p1:k")).toMatchObject({ state: "failed", error: "R2 closed the connection", build: "nightly-70" });
    // Begun again, a failed job starts over.
    jobs.begin(dir, "full", "p1", { key: "k" }, "k");
    expect(jobs.get(dir, "full:p1:k")).toMatchObject({ state: "running", attempts: 0 });
    expect(jobs.get(dir, "full:p1:k")?.error).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an export handed to its archive in one write: no crash falls between them", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "export", "p1", { output: "/x.mp4" });
    jobs.handOff(dir, key, { kind: "archive", project: "p1", args: { output: "/x.mp4" } });
    expect(read(dir).map((job) => job.key)).toEqual(["archive:p1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that's still going (a turn's minute) has its time noted and its restarts forgiven", async () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "turn", "p1", { chat: "p1" });
    jobs.takeOver(dir);
    expect(jobs.get(dir, key)?.attempts).toBe(1);
    const before = jobs.get(dir, key)!.updated_ms;
    await Bun.sleep(2);
    jobs.touch(dir, key);
    expect(jobs.get(dir, key)).toMatchObject({ attempts: 0 });
    expect(jobs.get(dir, key)!.updated_ms).toBeGreaterThan(before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job waiting on a time, the encoder or the person isn't cut short by a restart; it's woken when it's due", async () => {
  const dir = home();
  let exporting = true;
  const undo = encoder.register(() => (exporting ? "an export" : null));
  try {
    for (const [project, fields] of [
      ["later", { retry_at: Date.now() + 60_000 }],
      ["due", { retry_at: Date.now() - 1 }],
      ["encoder", { until: "encoder" as const }],
      ["person", { until: "person" as const }],
    ] as const) {
      jobs.begin(dir, "case", project, {});
      jobs.settle(dir, jobs.keyOf("case", project), "waiting", { step: "waiting", ...fields });
    }
    // None was cut short: a restart hands none back, and counts none.
    expect(jobs.takeOver(dir)).toEqual([]);
    expect(read(dir).every((job) => job.attempts === 0 && job.state === "waiting")).toBe(true);
    const woken: string[] = [];
    jobs.useResumers(dir, { case: (job) => void woken.push(job.project) });
    await jobs.wake(dir);
    expect(woken).toEqual(["due"]);
    exporting = false;
    await jobs.wake(dir);
    expect(woken).toEqual(["due", "encoder"]);
    // The person's answer, never a timer, carries the last one on; the first waits for its time.
    expect(read(dir).filter((job) => job.state === "waiting").map((job) => job.project).sort()).toEqual(["later", "person"]);
  } finally {
    undo();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("any work cut short three times in a row waits and is started again by itself on the passing schedule (1, then 5 minutes), one at a time; never given up", async () => {
  const dir = home();
  try {
    for (const [kind, project] of [["archive", "p1"], ["idea", "p2"]] as const) jobs.begin(dir, kind, project, { output: `/${project}.mp4` });
    const started: string[] = [];
    // Each start notes it again (as ExportRegistry does) and never gets it to the end.
    const again = (job: jobs.Job) => void (started.push(job.key), jobs.begin(dir, job.kind, job.project, job.args));
    const resumers: jobs.Resumers = { archive: again, idea: again };
    for (let restart = 1; restart <= 3; restart++) await jobs.resume(dir, resumers);
    expect(started.length).toBe(4);
    // Not given up, a paid one (Claude on an idea) neither: waiting a minute, why kept.
    expect(jobs.givenUp(dir)).toEqual([]);
    const waiting = jobs.putOffNow(dir);
    expect(waiting.map((job) => [job.key, job.put_off, job.why])).toEqual([["archive:p1", 1, "cut short by 3 restarts in a row"], ["idea:p2", 1, "cut short by 3 restarts in a row"]]);
    const wait = waiting[0]!.retry_at! - Date.now();
    expect(wait).toBeGreaterThan(55_000);
    expect(wait).toBeLessThanOrEqual(60_000);
    // A restart doesn't start them early.
    expect(jobs.takeOver(dir)).toEqual([]);
    // Due: woken one at a time, the second only once the first has ended.
    const all = read(dir).map((job) => ({ ...job, retry_at: Date.now() - 1 }));
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(all));
    jobs.useResumers(dir, resumers);
    await jobs.wake(dir);
    expect(started.slice(4)).toEqual(["archive:p1"]);
    await jobs.wake(dir);
    expect(started.slice(4)).toEqual(["archive:p1"]);
    expect(jobs.get(dir, "archive:p1")).toMatchObject({ state: "running", put_off: 1 });
    // Cut short once more: waits again at once, five minutes this time.
    jobs.takeOver(dir);
    const later = jobs.get(dir, "archive:p1")!;
    expect(later).toMatchObject({ state: "waiting", put_off: 2 });
    expect(later.retry_at! - Date.now()).toBeGreaterThan(5 * 60_000 - 5_000);
    await jobs.wake(dir);
    expect(started.slice(4)).toEqual(["archive:p1", "idea:p2"]);
    // Getting further forgives it.
    jobs.progressed(dir, "idea:p2");
    expect(jobs.get(dir, "idea:p2")?.put_off).toBeUndefined();
    // Unstick still starts one waiting now.
    const revived = jobs.startGivenUp(dir);
    expect(revived.keys).toEqual(["archive:p1"]);
    await revived.started;
    expect(started.at(-1)).toBe("archive:p1");
    expect(jobs.get(dir, "archive:p1")).toMatchObject({ state: "running", attempts: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job given up for restarts by an older build (Marc's archive), of any kind, waits and is tried again in a minute; a turn stays ended", () => {
  const dir = home();
  try {
    const old = (kind: string, project: string) => ({ key: `${kind}:${project}`, kind, project, args: {}, state: "given_up", attempts: 2, started_ms: 0, updated_ms: 0, given_up: "cut short by 3 restarts in a row" });
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify([old("archive", "p1"), old("idea", "p2"), old("turn", "p3")]));
    expect(jobs.takeOver(dir)).toEqual([]);
    for (const key of ["archive:p1", "idea:p2"]) {
      const job = jobs.get(dir, key)!;
      expect(job).toMatchObject({ state: "waiting", put_off: 1 });
      expect(job.given_up).toBeUndefined();
      expect(job.retry_at! - Date.now()).toBeLessThanOrEqual(60_000);
    }
    expect(jobs.get(dir, "turn:p3")).toMatchObject({ state: "given_up" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumer of work that can wait that fails as it starts (offline) puts its job off; one that's gone is crossed off", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "upload", "-", {}, "sha256:e0");
    jobs.begin(dir, "full", "p1", {}, "k");
    await jobs.resume(dir, {
      upload: () => {
        throw new Error("could not reach Edit's relay: the sign-in is being renewed");
      },
      full: () => {
        throw new jobs.Gone("/x.mp4 is gone");
      },
    });
    expect(read(dir).map((job) => [job.key, job.state, job.put_off])).toEqual([["upload:-:sha256:e0", "waiting", 1]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
