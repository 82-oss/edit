// A job RunPod refused a machine for (an empty account) is told apart from one that failed: the relay's `refused`
// flag, or its words from before the flag, so the piece is held back rather than sent again at once and an export
// doesn't sit behind it (watermark_removal.ts, text_inpaint.ts; Nov 25, Boyfriends: up to three hours on two machines).

import { afterEach, beforeEach, expect, test } from "bun:test";

import * as removerCloud from "../src/remover_cloud.ts";

let relay: ReturnType<typeof Bun.serve>;
/** What the stand-in relay answers each job's GET with, by job id. */
const answers = new Map<string, { status: number; body: unknown }>();

beforeEach(() => {
  answers.clear();
  relay = Bun.serve({
    port: 0,
    fetch(request) {
      const answer = answers.get(new URL(request.url).pathname.split("/").pop() ?? "") ?? { status: 404, body: { error: "not found" } };
      return Response.json(answer.body, { status: answer.status });
    },
  });
  process.env.EDIT_RELAY_URL = `http://127.0.0.1:${relay.port}`;
  process.env.EDIT_RELAY_TOKEN = "test-token";
});

afterEach(async () => {
  await relay.stop(true);
  delete process.env.EDIT_RELAY_URL;
  delete process.env.EDIT_RELAY_TOKEN;
});

const failure = (id: string) => removerCloud.call("GET", `/v1/remover/jobs/${id}`).then(() => null, (error: unknown) => error);

test("a refusal to rent is told apart from a machine's own failure, by the relay's flag or its words", async () => {
  const words = `RunPod wouldn't rent a CPU machine for 10 minutes (402: {"detail":"Your account balance is too low to rent a pod."})`;
  answers.set("flagged", { status: 502, body: { error: "no GPU to rent", refused: true } });
  answers.set("old", { status: 502, body: { error: words } });
  answers.set("failed", { status: 502, body: { error: "the rented machine couldn't do it: could not decode" } });
  answers.set("waiting", { status: 202, body: { pending: true, status: "queued" } });

  const flagged = await failure("flagged");
  expect(flagged).toBeInstanceOf(removerCloud.RelaySaid);
  expect([(flagged as Error).message, removerCloud.refusal(flagged)]).toEqual(["no GPU to rent", true]);
  // A relay from before the flag: known by its words, as an error or as said.
  const old = await failure("old");
  expect([(old as Error).message, removerCloud.refusal(old), removerCloud.refusal(words)]).toEqual([words, true, true]);
  // A machine that failed the work is no refusal: tried again as before.
  expect(removerCloud.refusal(await failure("failed"))).toBe(false);
  expect(await failure("waiting")).toBeNull();
  expect(removerCloud.timing.refusedRetryMs).toBe(30 * 60_000);
});
