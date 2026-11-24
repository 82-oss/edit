// The RunPod cleaner against a stand-in relay: a stretch started (202), still going (202), then done (200) is a
// success, not three failures (Nov 20: relay.json took the 202 as a refusal and all 105 of Boyfriends' stretches
// were left blurred the moment they started); the relay's own refusal ends it; a Stop while the job was being sent
// cancels it once its id comes back.
import { afterAll, beforeAll, expect, test } from "bun:test";

import * as inpaint from "../src/text_inpaint.ts";

let server: ReturnType<typeof Bun.serve>;
const asked: string[] = [];
let polls = 0;
let refuse = false;
let slow = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      asked.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/v1/remover/jobs" && request.method === "POST") {
        if (refuse) return Response.json({ error: "Cleaning on RunPod isn't on for this relay." }, { status: 503 });
        if (slow) {
          await Bun.sleep(100);
          return Response.json({ id: "job-slow", out: "edit/cleaned/work/slow.mp4" }, { status: 202 });
        }
        const body = (await request.json()) as { worker: string; request: { input: string } };
        expect(body.worker.length).toBeGreaterThan(100);
        expect(body.request.input).toBe("edit/originals/test/clip.mp4");
        return Response.json({ id: "job-123456", out: "edit/cleaned/work/x.mp4" }, { status: 202 });
      }
      if (url.pathname === "/v1/remover/jobs/job-123456" && request.method === "GET") {
        polls += 1;
        if (polls < 2) return Response.json({ pending: true, status: "IN_PROGRESS" }, { status: 202 });
        return Response.json({ ok: true, box: null, inferred: 0, seconds: 3 });
      }
      if (url.pathname === "/v1/remover/jobs/job-slow") return Response.json({ pending: true, status: "IN_QUEUE" }, { status: 202 });
      if (url.pathname === "/v1/cloud/r2/delete") return Response.json({ ok: true, deleted: 1 });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${server.port}`;
  process.env.EDIT_RELAY_TOKEN = "test-token";
  inpaint.timing.pollMs = 5;
});

afterAll(() => {
  void server.stop(true);
  delete process.env.EDIT_RELAY_URL;
  delete process.env.EDIT_RELAY_TOKEN;
});

const request = {
  inputKey: "edit/originals/test/clip.mp4",
  piece: "p1 clean:m1@0-1000",
  input: "unused",
  input_args: [],
  from: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  matrix: "bt709",
  masks: [[]],
  out: "/nonexistent/out.mp4",
  beneath: [],
};

test("a stretch started and still going (202) then done (200) is cleaned", async () => {
  const answer = await inpaint.runPodForTests.clean(request);
  expect(answer).toEqual({ ok: true, box: null, inferred: 0, seconds: 3 });
  expect(polls).toBe(2);
  expect(asked.filter((one) => one.startsWith("POST /v1/remover/jobs"))).toHaveLength(1);
});

test("a Stop while the job was being sent cancels it once its id comes back, and nothing more is asked of it", async () => {
  // Nov 24, the M1 Air: nine of Trooper's stretches were stopped while their jobs were on the way to the relay; with
  // no id yet the Stop missed them, and each lane kept asking after its job until RunPod's refusal ten minutes later
  // (a rent would have cleaned, and paid for, stretches nobody wanted), while Hitman's stretches waited for a lane.
  slow = true;
  let wanted = true;
  const going = inpaint.runPodForTests.clean({ ...request, piece: "p1 clean:m1@5000-6000", wanted: () => wanted });
  await Bun.sleep(20);
  wanted = false;
  expect(await going).toEqual({ ok: false, error: "stopped" });
  expect(asked).toContain("DELETE /v1/remover/jobs/job-slow");
  expect(asked).not.toContain("GET /v1/remover/jobs/job-slow");
  slow = false;
});

test("the relay's refusal ends it with its words", async () => {
  refuse = true;
  await expect(inpaint.runPodForTests.clean(request)).rejects.toThrow("isn't on for this relay");
});

test("footage not in the cloud isn't sent", async () => {
  const answer = await inpaint.runPodForTests.clean({ ...request, inputKey: undefined });
  expect(answer.ok).toBe(false);
});
