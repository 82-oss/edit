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
});
