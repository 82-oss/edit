// Relay's RunPod finder job handling (apps/relay/src/remover.ts): request validation, GPU pool routing,
// parallel pod scaling across multiple long files, and signed payload delivery (including slowed-copy parent_url).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRequest, RemoverPods, type RemoverEnv } from "../../../relay/src/remover";

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
});
