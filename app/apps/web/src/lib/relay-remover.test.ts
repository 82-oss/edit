// Relay's RunPod finder job handling (apps/relay/src/remover.ts): request validation, GPU pool routing,
// parallel pod scaling across multiple long files, and signed payload delivery (including slowed-copy parent_url).
import * as fs from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readCutOffsWith, useKeys } from "../../../relay/src/auth";
import { forgetProjects } from "../../../relay/src/cloud";
import { readRequest, removerJobs, RemoverPods, RENT_REFUSED_MS, SHARED_OUT_MS, type RemoverEnv } from "../../../relay/src/remover";
import { BOOTSTRAP_B64, POD_B64 } from "../../../relay/src/remover_kit";

class MemStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string | string[]): Promise<T | Map<string, T> | undefined> {
    if (Array.isArray(key)) {
      const m = new Map<string, T>();
      for (const k of key) if (this.data.has(k)) m.set(k, this.data.get(k) as T);
      return m;
    }
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const m = new Map<string, T>();
    for (const [k, v] of this.data) if (k.startsWith(options.prefix)) m.set(k, v as T);
    return m;
  }
  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("relay RunPod finder jobs (remover.ts)", () => {
  it("validates find requests and rejects bad spans or parent prefixes", () => {
    expect(readRequest("find", { input: "edit/originals/drive/x/a.mp4", spans: [[0, 60]] })).toEqual({
      input: "edit/originals/drive/x/a.mp4",
      spans: [[0, 60]],
    });
    expect(readRequest("find", { input: "edit/originals/drive/x/a.mp4", spans: [[0, 60]], parent: "edit/cleaned/finder/abc.json" })).toEqual({
      input: "edit/originals/drive/x/a.mp4",
      spans: [[0, 60]],
      parent: "edit/cleaned/finder/abc.json",
    });
    expect(readRequest("find", { input: "edit/originals/drive/x/a.mp4", spans: [] })).toBeNull();
    expect(readRequest("find", { input: "edit/originals/drive/x/a.mp4", spans: [[20, 10]] })).toBeNull();
    expect(readRequest("find", { input: "edit/originals/drive/x/a.mp4", spans: [[0, 10]], parent: "edit/originals/evil.json" })).toBeNull();
  });

  it("routes find to the GPU pool, scales pods across long files, and delivers signed URLs + worker", async () => {
    const storage = new MemStorage();
    const rented: { id: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.runpod.io/v2/pods" && init?.method === "POST") {
        const id = `pod-${rented.length + 1}`;
        rented.push({ id, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ id });
      }
      if (url === "https://api.runpod.io/v2/pods") return Response.json({ pods: rented.map((p) => ({ id: p.id, name: p.body.name })) });
      return Response.json({ ok: true });
    });

    const env: RemoverEnv = {
      REMOVER: "pods",
      RUNPOD_API_KEY: "test-key",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: "bucket",
    };
    const pods = new RemoverPods({ storage: storage as never, blockConcurrencyWhile: (fn) => fn() }, env);

    for (let i = 1; i <= 3; i++) {
      const res = await pods.fetch(
        new Request("https://remover/enqueue", {
          method: "POST",
          body: JSON.stringify({
            id: `00000000-0000-4000-8000-00000000000${i}`,
            kind: "find",
            out: `edit/cleaned/work/f${i}.json`,
            worker: '{"find.py":"print(1)"}',
            request: { input: `edit/originals/drive/f${i}/v.mp4`, spans: [[0, 900]], ...(i === 3 ? { parent: "edit/cleaned/finder/p1.json" } : {}) },
            relay: "https://relay.example",
            backlog: 0,
          }),
        }),
      );
      expect(res.status).toBe(200);
    }
    expect(rented.length).toBeGreaterThanOrEqual(2);
    expect(String(rented[0]!.body.name)).toContain("edit-remover-gpu-");

    const token = (rented[0]!.body.env as Record<string, string>).REMOVER_TOKEN!;
    const nextRes = await pods.fetch(new Request("https://remover/pod/next", { method: "POST", body: JSON.stringify({ pod: "pod-1", token }) }));
    const nextBody = (await nextRes.json()) as { job: Record<string, unknown> };
    expect(nextBody.job.kind).toBe("find");
    expect(nextBody.job.worker).toBe('{"find.py":"print(1)"}');
    expect(nextBody.job.spans).toEqual([[0, 900]]);
    expect(String(nextBody.job.input_url)).toContain("edit/originals/drive/f1/v.mp4");
    expect(String(nextBody.job.output_url)).toContain("edit/cleaned/work/f1.json");

    // Take jobs 2 and 3 too so we verify parent_url on job 3
    const next2 = (await (await pods.fetch(new Request("https://remover/pod/next", { method: "POST", body: JSON.stringify({ pod: "pod-1", token }) }))).json()) as { job: Record<string, unknown> };
    const next3 = (await (await pods.fetch(new Request("https://remover/pod/next", { method: "POST", body: JSON.stringify({ pod: "pod-1", token }) }))).json()) as { job: Record<string, unknown> };
    expect(next2.job.parent_url).toBeUndefined();
    expect(String(next3.job.parent_url)).toContain("edit/cleaned/finder/p1.json");

    await pods.fetch(new Request("https://remover/pod/done", { method: "POST", body: JSON.stringify({ pod: "pod-1", token, id: nextBody.job.id, output: { ok: true, ask: 2, sheets: 1, seconds: 12 } }) }));
    const st = await pods.fetch(new Request("https://remover/status", { method: "POST", body: JSON.stringify({ id: nextBody.job.id }) }));
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({ ok: true, ask: 2, sheets: 1, seconds: 12 });
  });

  it("never assigns find jobs to pre-find GPU pods and preserves shared deduplicated jobs until all callers cancel", async () => {
    const storage = new MemStorage();
    // Seed an already-running pre-find GPU pod (no canFind flag)
    await storage.put("pods", {
      "old-pod": { pool: "gpu", token: "old-tok", machine: "RTX 4090", cloud: "COMMUNITY", rentedAt: Date.now(), seenAt: Date.now(), jobs: [] },
    });
    const rented: { id: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.runpod.io/v2/pods" && init?.method === "POST") {
        const id = `new-pod-${rented.length + 1}`;
        rented.push({ id, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ id });
      }
      if (url === "https://api.runpod.io/v2/pods") {
        return Response.json({ pods: [{ id: "old-pod", name: "edit-remover-gpu-old" }, ...rented.map((p) => ({ id: p.id, name: p.body.name }))] });
      }
      return Response.json({ ok: true });
    });

    const env: RemoverEnv = {
      REMOVER: "pods",
      RUNPOD_API_KEY: "test-key",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: "bucket",
    };
    const pods = new RemoverPods({ storage: storage as never, blockConcurrencyWhile: (fn) => fn() }, env);

    // Enqueue the same find job twice (two machines deduplicating via twin)
    const req = {
      kind: "find",
      worker: '{"find.py":"print(1)"}',
      request: { input: "edit/originals/drive/shared/v.mp4", spans: [[0, 60]] },
      relay: "https://relay.example",
      backlog: 0,
    };
    const r1 = await pods.fetch(new Request("https://remover/enqueue", { method: "POST", body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000010", out: "edit/cleaned/work/s1.json", ...req }) }));
    expect(r1.status).toBe(200);
    const r2 = await pods.fetch(new Request("https://remover/enqueue", { method: "POST", body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000011", out: "edit/cleaned/work/s2.json", ...req }) }));
    expect(await r2.json()).toEqual({ ok: true, id: "00000000-0000-4000-8000-000000000010", out: "edit/cleaned/work/s1.json" });

    // A fresh canFind GPU pod must have been rented even though old-pod was idle
    expect(rented).toHaveLength(1);

    // Old pod asking for work must NOT get the find job
    const oldNext = (await (await pods.fetch(new Request("https://remover/pod/next", { method: "POST", body: JSON.stringify({ pod: "old-pod", token: "old-tok" }) }))).json()) as { job: unknown };
    expect(oldNext.job).toBeNull();

    // First caller cancels -> job stays queued because second caller is still subscribed
    await pods.fetch(new Request("https://remover/cancel", { method: "POST", body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000010" }) }));
    const newTok = (rented[0]!.body.env as Record<string, string>).REMOVER_TOKEN!;
    const newNext = (await (await pods.fetch(new Request("https://remover/pod/next", { method: "POST", body: JSON.stringify({ pod: "new-pod-1", token: newTok }) }))).json()) as { job: Record<string, unknown> };
    expect(newNext.job.id).toBe("00000000-0000-4000-8000-000000000010");

    // Finish job -> status includes shared: true so callers don't delete job.out out from under each other
    await pods.fetch(new Request("https://remover/pod/done", { method: "POST", body: JSON.stringify({ pod: "new-pod-1", token: newTok, id: newNext.job.id, output: { ok: true, ask: 0, sheets: 0, seconds: 5 } }) }));
    const st = await pods.fetch(new Request("https://remover/status", { method: "POST", body: JSON.stringify({ id: newNext.job.id }) }));
    expect(await st.json()).toEqual({ ok: true, ask: 0, sheets: 0, seconds: 5, shared: true });
  });

  it("sizes find-only GPU rentals independently of legacy pods and clean backlog, and keeps/retries shared output cleanup alarms", async () => {
    const env: RemoverEnv = {
      REMOVER: "pods",
      RUNPOD_API_KEY: "test-key",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: "bucket",
    };

    // Case 1: 1 idle pre-find GPU + 2 queued 60s finds (waiting > free, total work = 240s <= 600s) MUST rent 1 canFind pod.
    const storage1 = new MemStorage();
    await storage1.put("pods", {
      "old-1": { pool: "gpu", token: "t1", machine: "RTX 4090", cloud: "COMMUNITY", rentedAt: Date.now(), seenAt: Date.now(), jobs: [] },
    });
    const rented1: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.runpod.io/v2/pods" && init?.method === "POST") {
        const id = `cf-${rented1.length + 1}`;
        rented1.push(id);
        return Response.json({ id });
      }
      if (url === "https://api.runpod.io/v2/pods") return Response.json({ pods: [{ id: "old-1" }, ...rented1.map((id) => ({ id }))] });
      return Response.json({ ok: true });
    });
    const pods1 = new RemoverPods({ storage: storage1 as never, blockConcurrencyWhile: (fn) => fn() }, env);
    await storage1.put("order:gpu", ["f1", "f2"]);
    await storage1.put("j:f1", { id: "f1", kind: "find", out: "edit/cleaned/work/f1.json", request: { input: "edit/originals/drive/a/1.mp4", spans: [[0, 60]] }, state: "queued", tries: 0, at: Date.now() });
    await storage1.put("j:f2", { id: "f2", kind: "find", out: "edit/cleaned/work/f2.json", request: { input: "edit/originals/drive/a/2.mp4", spans: [[0, 60]] }, state: "queued", tries: 0, at: Date.now() });
    await pods1.alarm();
    expect(rented1).toHaveLength(1);

    // Case 2: 10 idle legacy GPUs + 5 queued heavy cleans + 1 queued 60s find -> rents ONLY 1 canFind pod (clean work fits legacy lanes).
    const storage2 = new MemStorage();
    const legacyPods: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      legacyPods[`leg-${i}`] = { pool: "gpu", token: `t${i}`, machine: "RTX 4090", cloud: "COMMUNITY", rentedAt: Date.now(), seenAt: Date.now(), jobs: [] };
    }
    await storage2.put("pods", legacyPods);
    const rented2: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.runpod.io/v2/pods" && init?.method === "POST") {
        const id = `cf2-${rented2.length + 1}`;
        rented2.push(id);
        return Response.json({ id });
      }
      if (url === "https://api.runpod.io/v2/pods") {
        return Response.json({ pods: [...Object.keys(legacyPods).map((id) => ({ id })), ...rented2.map((id) => ({ id }))] });
      }
      return Response.json({ ok: true });
    });
    const pods2 = new RemoverPods({ storage: storage2 as never, blockConcurrencyWhile: (fn) => fn() }, env);
    const order2: string[] = [];
    for (let i = 0; i < 5; i++) {
      order2.push(`c${i}`);
      await storage2.put(`j:c${i}`, { id: `c${i}`, kind: "clean", out: `edit/cleaned/work/c${i}.mp4`, request: { input: `edit/originals/drive/c/${i}.mp4`, fps: 30, masks: new Array(30 * 120).fill([0, 0, 10, 10]) }, state: "queued", tries: 0, at: Date.now() });
    }
    order2.push("f-one");
    await storage2.put("j:f-one", { id: "f-one", kind: "find", out: "edit/cleaned/work/f-one.json", request: { input: "edit/originals/drive/f/one.mp4", spans: [[0, 60]] }, state: "queued", tries: 0, at: Date.now() });
    await storage2.put("order:gpu", order2);
    await pods2.alarm();
    expect(rented2).toHaveLength(1);

    // Case 3: Shared output cleanup keeps an alarm after the last pod leaves, and retries after a 503 DELETE failure.
    const storage3 = new MemStorage();
    await storage3.put("pods", {});
    const doneAt = Date.now() - 2 * 60_000; // 2 min ago (< 10 min TTL)
    await storage3.put("j:sh1", { id: "sh1", kind: "find", out: "edit/cleaned/work/sh1.json", request: { input: "edit/originals/drive/s/1.mp4", spans: [[0, 10]] }, state: "done", tries: 0, at: doneAt, shared: true });
    let deleteAttempts = 0;
    let failDelete = true;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.runpod.io/v2/pods") return Response.json({ pods: [] });
      if (init?.method === "DELETE" && url.includes("edit/cleaned/work/sh1.json")) {
        deleteAttempts += 1;
        return new Response(failDelete ? "unavailable" : null, { status: failDelete ? 503 : 204 });
      }
      return Response.json({ ok: true });
    });
    const pods3 = new RemoverPods({ storage: storage3 as never, blockConcurrencyWhile: (fn) => fn() }, env);
    await pods3.alarm();
    expect(deleteAttempts).toBe(0);
    // Alarm stays scheduled for the 10-min cleanup deadline even with 0 pods
    expect(storage3.alarm).not.toBeNull();

    // Advance past 10 min (even past 24h expiry): 503 DELETE must NOT mark outCleaned or drop the job
    await storage3.put("j:sh1", { id: "sh1", kind: "find", out: "edit/cleaned/work/sh1.json", request: { input: "edit/originals/drive/s/1.mp4", spans: [[0, 10]] }, state: "done", tries: 0, at: Date.now() - 25 * 3600_000, shared: true });
    await pods3.alarm();
    expect(deleteAttempts).toBe(1);
    const afterFail = (await storage3.get<{ outCleaned?: boolean }>("j:sh1")) as { outCleaned?: boolean } | undefined;
    expect(afterFail).toBeDefined();
    expect(afterFail?.outCleaned).toBeUndefined();
    expect(storage3.alarm).not.toBeNull();

    // Next alarm succeeds -> deletes object, expires old job, clears alarm
    failDelete = false;
    await pods3.alarm();
    expect(deleteAttempts).toBe(2);
    expect(await storage3.get("j:sh1")).toBeUndefined();
    expect(storage3.alarm).toBeNull();
  });
  it("fails what waits with RunPod's words once it has refused to rent for RENT_REFUSED_MS and the pool has no machine", async () => {
    const env: RemoverEnv = { REMOVER: "pods", RUNPOD_API_KEY: "k", R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b", R2_SECRET_ACCESS_KEY: "c", R2_BUCKET: "d" };
    let refuse = true;
    let refusals = 0;
    const rented: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.runpod.io/v2/pods" && init?.method === "POST") {
        if (refuse) {
          refusals += 1;
          return new Response('{"error":"insufficient balance"}', { status: 402 });
        }
        rented.push(`pod-${rented.length + 1}`);
        return Response.json({ id: rented.at(-1) });
      }
      if (url === "https://api.runpod.io/v2/pods") return Response.json({ pods: rented.map((id) => ({ id, name: "edit-remover-gpu-x" })) });
      return Response.json({ ok: true });
    });
    const storage = new MemStorage();
    const pods = new RemoverPods({ storage: storage as never, blockConcurrencyWhile: (fn) => fn() }, env);
    const find = (id: string, spans = [[0, 60]]) => ({ id, kind: "find", out: `edit/cleaned/work/${id}.json`, worker: "{}", request: { input: `edit/originals/drive/${id}/v.mp4`, spans }, relay: "https://relay.example" });
    const status = async (id: string) => {
      const answer = await pods.fetch(new Request("https://remover/status", { method: "POST", body: JSON.stringify({ id }) }));
      return { status: answer.status, body: (await answer.json()) as { error?: string; status?: string } };
    };
    const id = "00000000-0000-4000-8000-0000000000a1";
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    await pods.fetch(new Request("https://remover/enqueue", { method: "POST", body: JSON.stringify(find(id)) }));
    expect((await status(id)).status).toBe(202);
    // Refused a while, short of the limit: still waiting, and the relay keeps asking.
    vi.spyOn(Date, "now").mockReturnValue(start + RENT_REFUSED_MS - 30_000);
    await pods.alarm();
    expect(await status(id)).toEqual({ status: 202, body: { pending: true, status: "queued" } });
    expect(storage.alarm).not.toBeNull();
    // Past it: failed with RunPod's own words, and nothing more is asked of RunPod for it.
    vi.spyOn(Date, "now").mockReturnValue(start + RENT_REFUSED_MS + 1000);
    await pods.alarm();
    const failed = await status(id);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe(`RunPod wouldn't rent a GPU for 10 minutes (402: {"error":"insufficient balance"})`);
    // Flagged as a refusal, so Edit's export doesn't wait on it (remover_cloud.ts `refusal`).
    expect((failed.body as { refused?: unknown }).refused).toBe(true);
    expect(await storage.get("order:gpu")).toEqual([]);

    // A pool with a machine at work is only waiting its turn: never failed however long RunPod refuses more.
    refuse = false;
    const second = "00000000-0000-4000-8000-0000000000a2";
    await pods.fetch(new Request("https://remover/enqueue", { method: "POST", body: JSON.stringify(find(second)) }));
    expect(rented).toEqual(["pod-1"]);
    const token = (await storage.get<Record<string, { token: string }>>("pods") as Record<string, { token: string }>)["pod-1"]!.token;
    await pods.fetch(new Request("https://remover/pod/next", { method: "POST", body: JSON.stringify({ pod: "pod-1", token }) }));
    expect((await status(second)).body.status).toBe("running");
    refuse = true;
    const third = "00000000-0000-4000-8000-0000000000a3";
    // Long enough (900 s) that one card isn't enough for it: a second is asked for, and refused.
    const refusedBefore = refusals;
    await pods.fetch(new Request("https://remover/enqueue", { method: "POST", body: JSON.stringify(find(third, [[0, 900]])) }));
    expect(refusals).toBeGreaterThan(refusedBefore);
    vi.spyOn(Date, "now").mockReturnValue(start + 3 * RENT_REFUSED_MS);
    const refusedThen = refusals;
    await pods.alarm();
    expect(refusals).toBeGreaterThan(refusedThen);
    expect(await status(third)).toEqual({ status: 202, body: { pending: true, status: "queued" } });
    vi.restoreAllMocks();
  });
});

const ENV: RemoverEnv = { REMOVER: "pods", RUNPOD_API_KEY: "k", R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b", R2_SECRET_ACCESS_KEY: "c", R2_BUCKET: "d" };
const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const ask = (pods: RemoverPods, path: string, body: unknown) => pods.fetch(new Request(`https://remover${path}`, { method: "POST", body: JSON.stringify(body) }));
const statusOf = async (pods: RemoverPods, id: string) => {
  const answer = await ask(pods, "/status", { id });
  return { status: answer.status, body: (await answer.json()) as { error?: string; status?: string } };
};
const findJob = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "find", out: `edit/cleaned/work/${id}.json`, worker: "{}", request: { input: `edit/originals/drive/${id}/v.mp4`, spans: [[0, 60]] }, relay: "https://relay.example", ...extra });

describe("relay RunPod jobs: holds, shared results, refusals, pods without OCR (Nov 24 review)", () => {
  it("a Stop sent twice lets go of its own hold once; an older caller's Stop (no sub) still lets go of one", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (urlOf(input) === "https://api.runpod.io/v2/pods" && init?.method === "POST") return Response.json({ id: "pod-1" });
      if (urlOf(input) === "https://api.runpod.io/v2/pods") return Response.json({ pods: [{ id: "pod-1", name: "edit-remover-gpu-x" }] });
      return Response.json({ ok: true });
    });
    const pods = new RemoverPods({ storage: new MemStorage() as never, blockConcurrencyWhile: (fn) => fn() }, ENV);
    const id = "00000000-0000-4000-8000-0000000000b1";
    // The same job sent by two callers: one job, two holds.
    const sameRequest = { request: { input: "edit/originals/drive/same/v.mp4", spans: [[0, 60]] } };
    await ask(pods, "/enqueue", findJob(id, { sub: "a", ...sameRequest }));
    const twin = await ask(pods, "/enqueue", findJob("00000000-0000-4000-8000-0000000000b2", { sub: "b", ...sameRequest }));
    expect(((await twin.json()) as { id?: string }).id).toBe(id);
    // A's Stop, twice (its first answer lost): B's hold stays, and so does the job.
    await ask(pods, "/cancel", { id, sub: "a" });
    await ask(pods, "/cancel", { id, sub: "a" });
    expect((await statusOf(pods, id)).body.status).toBe("queued");
    // A hold that was never this job's takes nothing either.
    await ask(pods, "/cancel", { id, sub: "zzz" });
    expect((await statusOf(pods, id)).body.status).toBe("queued");
    await ask(pods, "/cancel", { id, sub: "b" });
    expect(await statusOf(pods, id)).toEqual({ status: 502, body: { error: "stopped" } });

    // Older callers send no sub: each Stop lets go of one hold, as before.
    const old = "00000000-0000-4000-8000-0000000000b3";
    const oldJob = findJob(old, { request: { input: "edit/originals/drive/old/v.mp4", spans: [[0, 30]] } });
    await ask(pods, "/enqueue", oldJob);
    await ask(pods, "/enqueue", { ...oldJob, id: "00000000-0000-4000-8000-0000000000b4" });
    await ask(pods, "/cancel", { id: old });
    expect((await statusOf(pods, old)).body.status).toBe("queued");
    await ask(pods, "/cancel", { id: old });
    expect((await statusOf(pods, old)).status).toBe(502);
  });

  it("keeps a shared result for the callers' whole wait, deletes it outside the queue's block, and never calls a deleted one ready", async () => {
    const storage = new MemStorage();
    await storage.put("pods", {});
    const shared = { id: "sh", kind: "find", out: "edit/cleaned/work/sh.json", request: { input: "edit/originals/drive/s/1.mp4", spans: [[0, 10]] }, state: "done", tries: 0, shared: true, output: { ok: true } };
    await storage.put("j:sh", { ...shared, at: Date.now() - (SHARED_OUT_MS - 60_000) });
    let inBlock = false;
    const deletes: boolean[] = [];
    let hang = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (urlOf(input) === "https://api.runpod.io/v2/pods") return Response.json({ pods: [] });
      if (init?.method === "DELETE" && urlOf(input).includes("edit/cleaned/work/sh.json")) {
        deletes.push(inBlock);
        if (hang) return new Promise<Response>(() => {});
        return new Response(null, { status: 204 });
      }
      return Response.json({ ok: true });
    });
    const block = async <T>(fn: () => Promise<T>): Promise<T> => {
      inBlock = true;
      try {
        return await fn();
      } finally {
        inBlock = false;
      }
    };
    const pods = new RemoverPods({ storage: storage as never, blockConcurrencyWhile: block }, ENV);
    // A caller that came back late within its 3-hour wait still finds it.
    await pods.alarm();
    expect(deletes).toEqual([]);
    expect((await statusOf(pods, "sh")).status).toBe(200);

    // Past it: an R2 that never answers is given up on (tried again on the next alarm), the queue answering meanwhile.
    await storage.put("j:sh", { ...shared, at: Date.now() - SHARED_OUT_MS - 1000 });
    hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const alarm = pods.alarm();
      await vi.waitFor(() => expect(deletes).toHaveLength(1));
      expect(inBlock).toBe(false);
      expect((await statusOf(pods, "sh")).status).toBe(200);
      await vi.advanceTimersByTimeAsync(10_000);
      await alarm;
    } finally {
      vi.useRealTimers();
    }
    expect(deletes).toEqual([false]);
    expect(((await storage.get<{ outCleaned?: boolean }>("j:sh")) as { outCleaned?: boolean } | undefined)?.outCleaned).toBeUndefined();
    expect(storage.alarm).not.toBeNull();

    // R2 answers: deleted (outside the block), and then said to be gone, not ready.
    hang = false;
    await pods.alarm();
    expect(deletes).toEqual([false, false]);
    expect(((await storage.get<{ outCleaned?: boolean }>("j:sh")) as { outCleaned?: boolean } | undefined)?.outCleaned).toBe(true);
    const gone = await statusOf(pods, "sh");
    expect(gone.status).toBe(410);
    expect(gone.body.error).toContain("send the job again");
  });

  it("fails waiting finds with RunPod's words while only a pod that can't find is there, and leaves its cleans", async () => {
    const storage = new MemStorage();
    const start = Date.now();
    await storage.put("pods", { legacy: { pool: "gpu", token: "t", machine: "RTX 4090", cloud: "COMMUNITY", rentedAt: start, seenAt: start, jobs: ["c1"] } });
    await storage.put("j:c1", { id: "c1", kind: "clean", out: "edit/cleaned/work/c1.mp4", request: { input: "edit/originals/drive/c/1.mp4", fps: 30, masks: [[[0, 0, 1, 1]]] }, state: "running", pod: "legacy", tries: 0, at: start });
    await storage.put("j:c2", { id: "c2", kind: "clean", out: "edit/cleaned/work/c2.mp4", request: { input: "edit/originals/drive/c/2.mp4", fps: 30, masks: [[[0, 0, 1, 1]]] }, state: "queued", tries: 0, at: start });
    await storage.put("j:f1", { id: "f1", kind: "find", out: "edit/cleaned/work/f1.json", request: { input: "edit/originals/drive/f/1.mp4", spans: [[0, 60]] }, state: "queued", tries: 0, at: start });
    await storage.put("order:gpu", ["c2", "f1"]);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (urlOf(input) === "https://api.runpod.io/v2/pods" && init?.method === "POST") return new Response('{"error":"insufficient balance"}', { status: 402 });
      if (urlOf(input) === "https://api.runpod.io/v2/pods") return Response.json({ pods: [{ id: "legacy", name: "edit-remover-gpu-old" }] });
      return Response.json({ ok: true });
    });
    const pods = new RemoverPods({ storage: storage as never, blockConcurrencyWhile: (fn) => fn() }, ENV);
    vi.spyOn(Date, "now").mockReturnValue(start);
    await pods.alarm();
    vi.spyOn(Date, "now").mockReturnValue(start + RENT_REFUSED_MS + 1000);
    await pods.alarm();
    const failed = await statusOf(pods, "f1");
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe(`RunPod wouldn't rent a GPU for 10 minutes (402: {"error":"insufficient balance"})`);
    expect(await storage.get("order:gpu")).toEqual(["c2"]);
    expect((await statusOf(pods, "c2")).body.status).toBe("queued");
    vi.restoreAllMocks();
  });

  it("gives a pod whose OCR didn't load cleans alone, and fails the finds after three such pods in a row", async () => {
    const storage = new MemStorage();
    const now = Date.now();
    const pod = (token: string) => ({ pool: "gpu", token, machine: "RTX 5090", cloud: "COMMUNITY", rentedAt: now, seenAt: null, jobs: [], canFind: true });
    await storage.put("pods", { p1: pod("t1"), p2: pod("t2"), p3: pod("t3"), p4: pod("t4") });
    await storage.put("j:f1", { id: "f1", kind: "find", out: "edit/cleaned/work/f1.json", request: { input: "edit/originals/drive/f/1.mp4", spans: [[0, 60]] }, state: "queued", tries: 0, at: now });
    await storage.put("j:c1", { id: "c1", kind: "clean", out: "edit/cleaned/work/c1.mp4", request: { input: "edit/originals/drive/c/1.mp4", fps: 30, masks: [[[0, 0, 1, 1]]] }, state: "queued", tries: 0, at: now });
    await storage.put("order:gpu", ["f1", "c1"]);
    const pods = new RemoverPods({ storage: storage as never, blockConcurrencyWhile: (fn) => fn() }, ENV);
    const next = async (id: string, token: string, find: boolean) => ((await (await ask(pods, "/pod/next", { pod: id, token, find })).json()) as { job: { id: string } | null }).job;
    // Without OCR: the clean behind the find, never the find.
    expect((await next("p1", "t1", false))?.id).toBe("c1");
    expect(await next("p2", "t2", false)).toBeNull();
    expect((await statusOf(pods, "f1")).body.status).toBe("queued");
    // A third in a row: the finds waiting fail, said why.
    expect(await next("p3", "t3", false)).toBeNull();
    const failed = await statusOf(pods, "f1");
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("its OCR didn't load");
    // One whose OCR loaded takes finds again, and the count starts over.
    await storage.put("j:f2", { id: "f2", kind: "find", out: "edit/cleaned/work/f2.json", request: { input: "edit/originals/drive/f/2.mp4", spans: [[0, 60]] }, state: "queued", tries: 0, at: now });
    await storage.put("order:gpu", ["f2"]);
    expect((await next("p4", "t4", true))?.id).toBe("f2");
    expect(await storage.get("findFailures")).toBe(0);
  });

  it("ships pods exactly the bootstrap.sh and pod.py beside it (remover_kit.ts made by kit.ts)", () => {
    const dir = new URL("../../../../scripts/remover-runpod/", import.meta.url);
    expect(Buffer.from(BOOTSTRAP_B64, "base64").equals(fs.readFileSync(new URL("bootstrap.sh", dir)))).toBe(true);
    expect(Buffer.from(POD_B64, "base64").equals(fs.readFileSync(new URL("pod.py", dir)))).toBe(true);
  });
});

describe("relay RunPod jobs: who may have a machine read what (Nov 24 review)", () => {
  let token = "";
  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    useKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256" }] }));
    readCutOffsWith(async () => Response.json({ at: Date.now(), revoked: [] }));
    token = await new SignJWT({ perms: ["use", "edit.bodycam"], admin: false, name: "editor" })
      .setProtectedHeader({ alg: "RS256", kid: "t1" })
      .setIssuer("https://accounts.spheceo.com")
      .setAudience("edit")
      .setSubject("person-editor")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  });
  afterAll(() => {
    useKeys(null);
    readCutOffsWith(null);
    forgetProjects();
  });

  it("holds every key a job's machine reads to the cloud's read rules, footage and authorized projects passing as before", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const projects: Record<string, unknown> = { theirs: { projectId: "theirs", summary: { style: "interrogation" } }, mine: { projectId: "mine", summary: { style: "bodycam" } } };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === "https://api.runpod.io/v2/pods" && init?.method === "POST") return Response.json({ id: "pod-1" });
      if (url === "https://api.runpod.io/v2/pods") return Response.json({ pods: [{ id: "pod-1", name: "edit-remover-gpu-x" }] });
      if (url.includes("convex.cloud")) {
        const sent = JSON.parse(String(init?.body ?? "{}")) as { path: string; args: { projectId: string } };
        return Response.json({ status: "success", value: sent.path === "edit:getProject" ? (projects[sent.args.projectId] ?? null) : null });
      }
      return new Response(null, { status: 204 });
    });
    const pods = new RemoverPods({ storage: new MemStorage() as never, blockConcurrencyWhile: (fn) => fn() }, ENV);
    const env: RemoverEnv = { ...ENV, CONVEX_URL: "https://example.convex.cloud/", CONVEX_SERVICE_TOKEN: "service", REMOVER_PODS: { idFromName: () => "remover", get: () => ({ fetch: (request: Request) => pods.fetch(request) }) } };
    const post = (body: unknown) => {
      const url = new URL("https://relay.test/v1/remover/jobs");
      return removerJobs(new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), url, env);
    };
    const clean = (input: string) => ({ kind: "clean", worker: "w", request: { input, beneath: [], from: 0, fps: 30, width: 640, height: 360, matrix: "bt709", masks: [[[0, 0, 10, 10]]] } });
    const find = (input: string, parent?: string) => ({ kind: "find", worker: "{}", request: { input, spans: [[0, 60]], ...(parent === undefined ? {} : { parent }) } });

    // Footage, and a slowed copy's own original with its parent's state: as before, each with its own hold.
    const original = await post(find("edit/originals/drive/x/v.mp4"));
    expect(original.status).toBe(202);
    expect(typeof ((await original.json()) as { sub?: unknown }).sub).toBe("string");
    expect((await post(find("edit/originals/sha256/ab/slow.mp4", "edit/cleaned/finder/abc.json"))).status).toBe(202);
    // An older Edit's clean (its worker sent as ever) of footage, and of a project it may work on.
    expect((await post(clean("edit/originals/drive/x/v.mp4"))).status).toBe(202);
    expect((await post(clean("edit/exports/mine/final.mp4"))).status).toBe(202);
    // A project outside the caller's kinds: refused before anything is signed; the finder reads footage alone.
    expect((await post(clean("edit/exports/theirs/final.mp4"))).status).toBe(403);
    expect((await post(find("edit/exports/theirs/final.mp4"))).status).toBe(400);
    expect((await post(find("edit/exports/mine/final.mp4"))).status).toBe(400);
  });
});
