import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { readState } from "../src/files.ts";
import * as encoder from "../src/encoder.ts";
import * as failure from "../src/failure.ts";
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

test("when the trouble is over (the relay answers again, the machine woke), work waiting on something that passes goes at once; credit's wait stays", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "archive", "p1", {});
    jobs.wait(dir, "archive:p1", "could not reach Edit's relay: The socket connection was closed unexpectedly");
    jobs.begin(dir, "case", "p2", {});
    jobs.settle(dir, "case:p2", "waiting", { step: "trying again by itself", retry_at: Date.now() + 30 * 60_000, args: { waiting_on: "passing" } });
    jobs.begin(dir, "case", "p3", {});
    jobs.settle(dir, "case:p3", "waiting", { step: "waiting for credit", retry_at: Date.now() + 30 * 60_000, args: { waiting_on: "quota" } });
    const woken: string[] = [];
    jobs.useResumers(dir, { archive: (job) => void woken.push(job.key), case: (job) => void woken.push(job.key) });
    expect(jobs.wakePassing(dir, "Edit's relay answers again").sort()).toEqual(["archive:p1", "case:p2"]);
    // A few seconds apart: the first now, the next after.
    await Bun.sleep(50);
    await jobs.wake(dir);
    expect(woken.length).toBeGreaterThanOrEqual(1);
    expect(jobs.get(dir, "case:p3")).toMatchObject({ state: "waiting", step: "waiting for credit" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Fable's check of the work, Nov 19 (verify.md findings 1, 3 and 6).
test("two pieces of work that waited on one dropped line both go when it's back: one at a time is only for work cut short by restarts", async () => {
  const dir = home();
  const waits = failure.PASSING_WAITS.value;
  failure.PASSING_WAITS.value = [0, 0, 0];
  try {
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    const script = jobs.begin(dir, "script", "s1", { waiting_on: "import" }, "", "importing");
    const share = jobs.begin(dir, "share", "p1", { id: "x" }, "", "uploading");
    jobs.wait(dir, script, dropped);
    jobs.wait(dir, share, dropped);
    const started: string[] = [];
    // As serve.ts' resumers do: start long work and return, the row left running.
    jobs.useResumers(dir, { script: (job) => void started.push(job.key), share: (job) => void started.push(job.key) });
    await Bun.sleep(5);
    await jobs.wake(dir);
    await jobs.wake(dir);
    expect(started.sort()).toEqual([script, share].sort());
  } finally {
    failure.PASSING_WAITS.value = waits;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("work that got further between blips waits a minute after each; work that only reaches the same step again waits longer each time (Fable's last look)", () => {
  const dir = home();
  try {
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    const key = jobs.begin(dir, "script", "s9", { waiting_on: "import" }, "", "importing");
    const waited: number[] = [];
    for (const stage of ["downloading", "transcribing", "placing", "voicing", "finishing"]) {
      jobs.step(dir, key, stage);
      const now = Date.now();
      waited.push(Math.round((jobs.wait(dir, key, dropped)! - now) / 60_000));
      // Woken, it begins its row again (as a Script import does) and gets to a step it never reached before.
      jobs.begin(dir, "script", "s9", { waiting_on: "import" }, "", "importing");
    }
    expect(waited).toEqual([1, 1, 1, 1, 1]);
    // A file the relay refuses every time: each start reaches the same step and fails there. Its waits grow, and the
    // table's waking leaves the step as it was, so starting again isn't read as progress.
    const again = jobs.begin(dir, "script", "s10", { waiting_on: "import" }, "", "importing");
    const grew: number[] = [];
    for (let time = 0; time < 4; time++) {
      jobs.step(dir, again, "downloading");
      const now = Date.now();
      grew.push(Math.round((jobs.wait(dir, again, "Relay answered 500 for the hearing")! - now) / 60_000));
      jobs.begin(dir, "script", "s10", { waiting_on: "import" }, "", "importing");
    }
    expect(grew.slice(0, 3)).toEqual([1, 5, 15]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a known outage never fails work by the same-failure count, however long; a restart isn't a failure; work nobody is shown only waits; words nothing knows fail on the fourth time (Fable's last look)", () => {
  const dir = home();
  try {
    const dropped = "could not reach Edit's relay: The socket connection was closed unexpectedly";
    for (const kind of ["archive", "share", "export"] as const) {
      const key = jobs.begin(dir, kind, `p-${kind}`, {}, "", "uploading");
      for (let time = 0; time < 8; time++) jobs.wait(dir, key, dropped);
      expect([kind, jobs.get(dir, key)!.state]).toEqual([kind, "waiting"]);
    }
    const cut = jobs.begin(dir, "export", "p-cut", {}, "", "rendering");
    for (let time = 0; time < 8; time++) jobs.wait(dir, cut, "cut short by 3 restarts in a row");
    expect(jobs.get(dir, cut)!.state).toBe("waiting");
    const odd = "Repack said something nobody has seen";
    const unseen = jobs.begin(dir, "full", "p-full", {}, "", "uploading");
    for (let time = 0; time < 8; time++) jobs.wait(dir, unseen, odd);
    expect(jobs.get(dir, unseen)!.state).toBe("waiting");
    const seen = jobs.begin(dir, "share", "p-seen", {}, "", "uploading");
    const states: string[] = [];
    for (let time = 0; time < 4; time++) {
      jobs.wait(dir, seen, odd);
      states.push(jobs.get(dir, seen)!.state);
    }
    expect(states).toEqual(["waiting", "waiting", "waiting", "failed"]);
    // A Script import begins its row afresh each wake: the count is carried through.
    const script = jobs.begin(dir, "script", "s-odd", { waiting_on: "import" }, "", "importing");
    const scriptStates: string[] = [];
    for (let time = 0; time < 4; time++) {
      jobs.wait(dir, script, odd);
      scriptStates.push(jobs.get(dir, script)!.state);
      if (jobs.get(dir, script)!.state === "waiting") jobs.begin(dir, "script", "s-odd", { waiting_on: "import" }, "", "importing");
    }
    expect(scriptStates).toEqual(["waiting", "waiting", "waiting", "failed"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure read as the person's is looked at again in half an hour, never parked where nobody is asked (only an import's question waits on the person)", () => {
  const dir = home();
  try {
    const key = jobs.begin(dir, "archive", "p2", { output: "/x.mp4", key: "k" }, "", "uploading");
    jobs.wait(dir, key, "its upload failed: the export has no bytes");
    const row = jobs.get(dir, key)!;
    expect(row.until).toBeUndefined();
    expect(row.retry_at! - Date.now()).toBeGreaterThan(29 * 60_000);
    const asked = jobs.begin(dir, "case", "p3", {}, "", "downloading");
    jobs.wait(dir, asked, "Google Drive can't find this file: it was deleted, or in the trash.");
    expect(jobs.get(dir, asked)!.until).toBe("person");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("work waiting for room starts again only once there's room for what it needs, never redone into a full disk every five minutes", async () => {
  const dir = home();
  const was = jobs.roomCheck.has;
  const waits = failure.ROOM_EVERY_MS.value;
  failure.ROOM_EVERY_MS.value = 0;
  try {
    const key = jobs.begin(dir, "script", "s1", { waiting_on: "import" }, "", "importing");
    jobs.wait(dir, key, new failure.NoRoom(5e9, "This import needs about 5 GB free and this Mac has 3 GB."));
    expect(jobs.get(dir, key)!.args.room_bytes).toBe(5e9);
    const started: string[] = [];
    jobs.useResumers(dir, { script: (job) => void started.push(job.key) });
    let free = 3e9;
    jobs.roomCheck.has = (bytes) => free >= bytes;
    await Bun.sleep(5);
    await jobs.wake(dir);
    expect(started).toEqual([]);
    free = 8e9;
    await jobs.wake(dir);
    expect(started).toEqual([key]);
  } finally {
    jobs.roomCheck.has = was;
    failure.ROOM_EVERY_MS.value = waits;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a wait due sooner than the table's next look goes when it's due, not at the next 30-second look", async () => {
  const dir = home();
  try {
    const started: string[] = [];
    jobs.useResumers(dir, { case: (job) => void started.push(job.key) });
    const key = jobs.begin(dir, "case", "p-soon", {}, "", "downloading");
    jobs.settle(dir, key, "waiting", { retry_at: Date.now() + 200 });
    await Bun.sleep(1000);
    expect(started).toEqual([key]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Nov 21, the fault-injection run's kill-three-times: a row put to wait as a run starts (cut short by restarts in a row,
// a minute; there a second) went only at the table's next look, up to 30 s on, since no timer was set for it.
test("a wait already there as a run starts, due before the table's next look, goes when it's due", async () => {
  const dir = home();
  try {
    const started: string[] = [];
    const key = jobs.begin(dir, "case", "p-left", {}, "", "downloading");
    // Set before any resumers are in, as the last run (or this one's taking over) leaves it.
    jobs.settle(dir, key, "waiting", { retry_at: Date.now() + 200 });
    await jobs.resume(dir, { case: (job) => void started.push(job.key) });
    expect(started).toEqual([]);
    await Bun.sleep(1200);
    expect(started).toEqual([key]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Nov 21 (audit I15.a): the trouble over, the second and later rows woken a few seconds apart had their time set but
// no timer, so they went only at the table's next look, up to 30 s on.
test("rows woken a few seconds apart as the trouble ends each go when their time comes, not at the table's next look", async () => {
  const dir = home();
  // Sixty times faster (failure.ts `speed`): 3 s apart becomes 50 ms apart.
  process.env.EDIT_BAD_DAY_SPEED = "60";
  try {
    const keys = ["p1", "p2", "p3", "p4"].map((project) => {
      jobs.begin(dir, "archive", project, {});
      jobs.wait(dir, `archive:${project}`, "could not reach Edit's relay: The socket connection was closed unexpectedly");
      return `archive:${project}`;
    });
    const started: string[] = [];
    // No table timer of its own (`useResumers`, not `resume`): only what waking sets can start them.
    jobs.useResumers(dir, { archive: (job) => void started.push(job.key) });
    expect(jobs.wakePassing(dir, "Edit's relay answers again").sort()).toEqual(keys);
    // The last is due 150 ms on; a second and a half is ten times that.
    await Bun.sleep(1500);
    expect(started.sort()).toEqual(keys);
  } finally {
    delete process.env.EDIT_BAD_DAY_SPEED;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Nov 20: the fault-injection run's storm and the rows left "running" with nothing running.
test("the same kind of signal again within seconds wakes nothing it just woke; another kind still wakes it at once", () => {
  const dir = home();
  try {
    jobs.begin(dir, "archive", "p1", {});
    jobs.wait(dir, "archive:p1", "could not reach Edit's relay: The socket connection was closed unexpectedly");
    expect(jobs.wakePassing(dir, "signed in")).toEqual(["archive:p1"]);
    // Its try failed again at once (the line still down): the next sign-ins of a storm leave it to its schedule.
    jobs.wait(dir, "archive:p1", "could not reach Edit's relay: The socket connection was closed unexpectedly");
    for (let n = 0; n < 5; n++) expect(jobs.wakePassing(dir, "signed in")).toEqual([]);
    expect(jobs.wakePassing(dir, "the machine woke after 3 s")).toEqual(["archive:p1"]);
    jobs.wait(dir, "archive:p1", "could not reach Edit's relay: The socket connection was closed unexpectedly");
    expect(jobs.wakePassing(dir, "the machine woke after 9 s")).toEqual([]);
    // The line coming back is its own signal: it goes at once.
    expect(jobs.wakePassing(dir, "Edit's relay answers again")).toEqual(["archive:p1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumer that fails after RESUME_MS still settles its row: it waits and is tried again by itself", async () => {
  const dir = home();
  const before = jobs.RESUME_MS.value;
  jobs.RESUME_MS.value = 50;
  try {
    jobs.begin(dir, "media", "p1", {});
    jobs.begin(dir, "smooth", "p2", {});
    const order: string[] = [];
    await jobs.resume(dir, {
      media: async () => {
        await Bun.sleep(200);
        order.push("media failed");
        throw new Error("could not reach Edit's relay: The socket connection was closed unexpectedly");
      },
      smooth: () => void order.push("smooth"),
    }, ["media", "smooth"]);
    expect(order).toEqual(["smooth"]);
    expect(jobs.owned(dir, "media:p1")).toBe(true);
    await Bun.sleep(300);
    expect(order).toEqual(["smooth", "media failed"]);
    expect(jobs.get(dir, "media:p1")).toMatchObject({ state: "waiting", put_off: 1 });
    expect(jobs.get(dir, "media:p1")?.retry_at).toBeGreaterThan(Date.now());
    expect(jobs.owned(dir, "media:p1")).toBe(false);
  } finally {
    jobs.RESUME_MS.value = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a row said running that nothing in this run holds waits after UNOWNED_MS and is tried again; a held one is left however long it takes", () => {
  const dir = home();
  try {
    const old = Date.now() - jobs.UNOWNED_MS.value - 60_000;
    // Held: begun in this run, working for an hour without a note.
    jobs.begin(dir, "export", "held", {});
    // Nothing holds it: left running by work that ended without a word (as another run, or a late step, leaves it).
    const rows = read(dir);
    rows.push({ key: "media:lost", kind: "media", project: "lost", args: {}, state: "running", attempts: 0, started_ms: old, updated_ms: old, step: "fetching" });
    rows[0]!.updated_ms = Date.now() - 60 * 60_000;
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(rows));
    // Not yet old enough: left.
    expect(jobs.cutShortUnowned(dir, old + 60_000)).toEqual([]);
    expect(jobs.cutShortUnowned(dir)).toEqual(["media:lost"]);
    const lost = jobs.get(dir, "media:lost")!;
    expect(lost).toMatchObject({ state: "waiting", put_off: 1, why: "cut short: nothing was running" });
    expect(lost.retry_at).toBeGreaterThan(Date.now());
    expect(jobs.get(dir, "export:held")).toMatchObject({ state: "running" });
    // Cut short again and again (woken, and again left running by work that ended without a word): never counted as
    // the same failure, never failed for it.
    for (let n = 0; n < 6; n++) {
      const again = read(dir);
      Object.assign(again.find((job) => job.key === "media:lost")!, { state: "running", updated_ms: old });
      fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(again));
      expect(jobs.cutShortUnowned(dir)).toEqual(["media:lost"]);
    }
    // A step held it: a row someone notes is someone's, left however still it then goes.
    jobs.step(dir, "media:lost", "fetching");
    const noted = read(dir);
    noted.find((job) => job.key === "media:lost")!.updated_ms = old;
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(noted));
    expect(jobs.cutShortUnowned(dir)).toEqual([]);
    jobs.wait(dir, "media:lost", "could not reach Edit's relay");
    expect(jobs.get(dir, "media:lost")).toMatchObject({ state: "waiting" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a running row nothing has noted for 15 minutes is reported once, held or not; a beat moves it without a write per call", () => {
  const dir = home();
  try {
    jobs.begin(dir, "footage", "p1", {}, "", "downloading");
    jobs.begin(dir, "export", "p2", {});
    const rows = read(dir);
    rows[0]!.updated_ms = Date.now() - 20 * 60_000;
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(rows));
    const listed = jobs.still(dir);
    expect(listed.map((job) => job.key)).toEqual(["footage:p1"]);
    expect(jobs.stillLine(listed[0]!)).toBe("Job footage:p1: running, nothing noted for 20 min (step downloading)");
    // A beat notes it; a second beat within BEAT_MS doesn't write.
    jobs.beat(dir, "footage:p1");
    expect(jobs.still(dir)).toEqual([]);
    const written = fs.statSync(`${dir}/jobs.json`).mtimeMs;
    const noted = jobs.get(dir, "footage:p1")!.updated_ms;
    jobs.beat(dir, "footage:p1");
    expect(jobs.get(dir, "footage:p1")!.updated_ms).toBe(noted);
    expect(fs.statSync(`${dir}/jobs.json`).mtimeMs).toBe(written);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fourth Script import behind three running is refused by Edit's own queue and stays waiting however often it's woken, a minute apart (Nov 20)", async () => {
  const dir = home();
  try {
    jobs.begin(dir, "script", "s4", {});
    jobs.wait(dir, "script:s4", new Error("3 imports are already running. Try again when one finishes."));
    jobs.useResumers(dir, {
      script: (job) => {
        jobs.wait(dir, job.key, new Error("3 imports are already running. Try again when one finishes."));
      },
    });
    for (let n = 0; n < 5; n++) {
      const rows = read(dir);
      rows[0]!.retry_at = Date.now() - 1;
      fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(rows));
      await jobs.wake(dir, ["script"]);
    }
    const row = jobs.get(dir, "script:s4")!;
    expect(row.state).toBe("waiting");
    expect(row.args.same_count).toBeUndefined();
    expect(row.retry_at! - Date.now()).toBeGreaterThan(50_000);
    expect(row.retry_at! - Date.now()).toBeLessThanOrEqual(60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Nov 21: after a wake the rows that fell due started one after another, each given up to RESUME_MS to start, and
// an archive's resumer waits on its whole cloud copy: a Script import behind N of them started N minutes late.
test("rows woken together start together, however long each takes to settle; a row put off for restarts in a row still waits its turn", async () => {
  const dir = home();
  try {
    for (const [kind, project] of [["archive", "p1"], ["share", "p2"], ["writer", "p3"], ["media", "p4"]] as const) {
      jobs.begin(dir, kind, project, {});
      jobs.wait(dir, `${kind}:${project}`, "could not reach Edit's relay: The socket connection was closed unexpectedly");
    }
    const rows = read(dir);
    for (const row of rows) row.retry_at = Date.now() - 1;
    // Cut short by restarts in a row: it may be what brings the server down.
    Object.assign(rows.find((row) => row.key === "media:p4")!, { crashy: true, put_off: 1, why: "cut short by 3 restarts in a row" });
    fs.writeFileSync(`${dir}/jobs.json`, JSON.stringify(rows));
    const started: string[] = [];
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    // Each takes "30 s" to settle: until the test lets them.
    const slow = async (job: jobs.Job) => {
      started.push(job.key);
      await settled;
      jobs.end(dir, job.key);
    };
    jobs.useResumers(dir, { archive: slow, share: slow, writer: slow, media: slow });
    const waking = jobs.wake(dir);
    await Bun.sleep(300);
    expect(started.sort()).toEqual(["archive:p1", "share:p2", "writer:p3"]);
    expect(["archive:p1", "share:p2", "writer:p3", "media:p4"].every((key) => jobs.owned(dir, key))).toBe(true);
    settle();
    await waking;
    expect(started.at(-1)).toBe("media:p4");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
